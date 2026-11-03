//! Sending a file through the phone screen, like OptiRelay Studio
//! (examples/studio, live.ts): a random 12-character code drawn per sending
//! (CSPRNG), shown as TEXT next to the grid with the 6-digit verification
//! code; passphrase pairing on that code, encryption required; the loop
//! shows the init code (one R/P pair) then a data frame (two R/P pairs),
//! single grid, 250 ms per subframe, TM4 by default (TM8 optional).
//!
//! A thread prepares the frames ahead of time (ORP session, R/P rendering by
//! orp-optics); a Slint timer, on the UI thread, switches the subframes at
//! the period. If the next frame is not ready, its gray R (identical for
//! all frames) simply lasts longer, as in the Studio.

use crate::{engine, with_app, App, Screen};
use orp_core::Codec;
use orp_transfer::{batch_images, random_code, shown_code, shown_sas, SendSettings, Sender, TransferredFile, DEFAULT_PERIOD_MS};
use slint::ComponentHandle;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Display timer step: each switch lands within 2 ms of its instant.
const TIMER_STEP: Duration = Duration::from_millis(2);
/// Tolerance of a switch (ms): a quarter frame at 60 Hz, like the Studio.
const TOLERANCE_MS: f64 = 4.0;
/// R/P pairs per step of the loop: the init code once, the data frame twice
/// (`display.show(init, TM4, 1)` then `display.show(frame, codec, 2)`).
const INIT_CYCLES: usize = 1;
const DATA_CYCLES: usize = 2;

/// WHOLE physical pixels per module for one grid to fit in `side` pixels
/// (41 modules + 2 × 2 of quiet zone).
fn module_for(side: usize) -> usize {
    (side / 45).max(2)
}

/// Codec of the chosen mode (0: TM4, 1: TM8).
fn codec_of(mode: i32) -> Codec {
    if mode == 1 {
        Codec::Color8
    } else {
        Codec::Color4
    }
}

/// Seconds on screen for one pass over the file (no losses): each data frame
/// takes (1 + 2) R/P pairs.
fn seconds_on_screen(bytes: usize, codec: Codec) -> f64 {
    let per_frame = (orp_core::symbol_capacity(codec) * orp_core::SYMBOL_SIZE) as f64;
    let step = (2 * (INIT_CYCLES + DATA_CYCLES)) as f64 * DEFAULT_PERIOD_MS as f64 / 1000.0;
    (bytes as f64 / per_frame).ceil() * step
}

fn readable_duration(s: f64) -> String {
    if s < 90.0 {
        format!("~{:.0} s", s.max(1.0))
    } else if s < 5400.0 {
        format!("~{:.0} min", s / 60.0)
    } else {
        format!("~{:.1} h", s / 3600.0)
    }
}

type Pair = (slint::SharedPixelBuffer<slint::Rgba8Pixel>, slint::SharedPixelBuffer<slint::Rgba8Pixel>);

enum Message {
    Ready { code: String, sas: String, init: Pair, bytes: usize },
    Frame { pair: Pair, frames: u64 },
    Error(String),
}

struct Sending {
    _timer: slint::Timer,
    stop_flag: Arc<AtomicBool>,
}

thread_local! {
    static FILE: RefCell<Option<TransferredFile>> = const { RefCell::new(None) };
    static SENDING: RefCell<Option<Sending>> = const { RefCell::new(None) };
}

fn buffer(image: &orp_optics::render::ImageRGBA) -> slint::SharedPixelBuffer<slint::Rgba8Pixel> {
    slint::SharedPixelBuffer::clone_from_slice(&image.data, image.width as u32, image.height as u32)
}

/// The chosen file and its estimate, on the Send screen.
pub fn show_settings(app: &App) {
    FILE.with(|f| {
        if let Some(f) = f.borrow().as_ref() {
            app.set_send_name(f.name.clone().into());
            let duration = seconds_on_screen(f.data.len(), codec_of(app.get_send_mode()));
            app.set_send_detail(format!("{} / {} ON SCREEN", engine::readable_size(f.data.len() as f64), readable_duration(duration)).to_uppercase().into());
        }
        app.set_send_chosen(f.borrow().is_some());
    });
}

pub fn file_chosen(f: TransferredFile) {
    engine::log(&format!("file to send: {} ({} bytes, {})", f.name, f.data.len(), f.mime_type));
    FILE.with(|e| *e.borrow_mut() = Some(f));
    with_app(show_settings);
}

pub fn start(app: &App) {
    let Some(file) = FILE.with(|f| f.borrow().clone()) else { return };
    stop();
    let codec = codec_of(app.get_send_mode());
    let settings = SendSettings { codec, period_ms: DEFAULT_PERIOD_MS, columns: 1 };
    // Module size: the grid takes a square as wide as the screen.
    let side = app.window().size().width as usize;
    let module = module_for(side);
    engine::log(&format!("transmission: {side} px screen, {module} px per module, {codec:?}."));
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<Message>(3);
    let thread_stop_flag = stop_flag.clone();
    std::thread::spawn(move || {
        // One code per sending, never reused: drawn here, shown as text.
        let code = random_code();
        let mut em = match Sender::new(&file, settings, &code) {
            Ok(em) => em,
            Err(e) => {
                let _ = tx.send(Message::Error(e.to_string()));
                return;
            }
        };
        let init = match batch_images(std::slice::from_ref(&em.init), 1, module) {
            Ok((r, p)) => (buffer(&r), buffer(&p)),
            Err(e) => {
                let _ = tx.send(Message::Error(e.to_string()));
                return;
            }
        };
        if tx.send(Message::Ready { code, sas: em.sas.clone(), init, bytes: em.stream_size }).is_err() {
            return;
        }
        while !thread_stop_flag.load(Ordering::SeqCst) {
            let frame = match em.next_data_frame().and_then(|t| batch_images(&[t], 1, module)) {
                Ok((r, p)) => (buffer(&r), buffer(&p)),
                Err(e) => {
                    let _ = tx.send(Message::Error(e.to_string()));
                    return;
                }
            };
            if tx.send(Message::Frame { pair: frame, frames: em.frames }).is_err() {
                return;
            }
        }
        em.finish();
    });

    app.set_sending_code("····-····-····".into());
    app.set_sending_sas("··· ···".into());
    app.set_sending_hud("DRAWING THE CODE AND PREPARING THE FILE...".into());
    app.set_sending_grid(slint::Image::default());
    app.set_screen(Screen::Sending);
    #[cfg(target_os = "android")]
    crate::android::max_brightness(true);

    // Display: the subframes of the current step (init R, P, data R, P, R, P).
    let mut init: Option<(slint::Image, slint::Image)> = None;
    let mut step: Vec<slint::Image> = Vec::new();
    let mut index = 0usize;
    let mut phase_start: Option<Instant> = None;
    let mut waiting_shown = false;
    let mut frames = 0u64;
    let mut stream_start: Option<Instant> = None;
    let mut bytes = 0usize;
    let mode = if codec == Codec::Color8 { "TM8" } else { "TM4" };
    let period = DEFAULT_PERIOD_MS as f64;
    let timer = slint::Timer::default();
    let ui_stop_flag = stop_flag.clone();
    timer.start(slint::TimerMode::Repeated, TIMER_STEP, move || {
        if ui_stop_flag.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        if init.is_none() {
            match rx.try_recv() {
                Ok(Message::Ready { code, sas, init: (r, p), bytes: o }) => {
                    bytes = o;
                    init = Some((slint::Image::from_rgba8(r), slint::Image::from_rgba8(p)));
                    with_app(|app| {
                        app.set_sending_code(shown_code(&code).into());
                        app.set_sending_sas(shown_sas(&sas).into());
                    });
                }
                Ok(Message::Error(e)) => {
                    with_app(|app| app.set_sending_hud(format!("CANNOT TRANSMIT: {e}").into()));
                    return;
                }
                _ => return,
            }
        }
        let expired = phase_start.map(|d| (now - d).as_secs_f64() * 1000.0 >= period - TOLERANCE_MS).unwrap_or(true);
        if !expired {
            return;
        }
        if index + 1 < step.len() {
            index += 1;
        } else {
            // Step done: the next data frame, preceded by the init code. Not
            // ready yet? The last R (gray, the same for all frames) stays.
            match rx.try_recv() {
                Ok(Message::Frame { pair: (r, p), frames: n }) => {
                    let (ir, ip) = init.clone().unwrap();
                    let (r, p) = (slint::Image::from_rgba8(r), slint::Image::from_rgba8(p));
                    step = vec![ir, ip];
                    for _ in 0..DATA_CYCLES {
                        step.push(r.clone());
                        step.push(p.clone());
                    }
                    index = 0;
                    frames = n;
                    stream_start.get_or_insert(now);
                    waiting_shown = false;
                }
                Ok(Message::Error(e)) => {
                    with_app(|app| app.set_sending_hud(format!("TRANSMISSION INTERRUPTED: {e}").into()));
                    return;
                }
                _ => {
                    if !waiting_shown {
                        if let Some(r) = step.first().or(init.as_ref().map(|i| &i.0)).cloned() {
                            with_app(|app| app.set_sending_grid(r));
                        }
                        waiting_shown = true;
                    }
                    return;
                }
            }
        }
        phase_start = Some(now);
        let image = step[index].clone();
        let elapsed = stream_start.map(|d| d.elapsed().as_secs_f64()).unwrap_or(0.0);
        with_app(|app| {
            app.set_sending_grid(image);
            if index == 0 {
                app.set_sending_hud(
                    format!("{mode} / {} MS / FRAME {frames} / {:.0} S / {} STREAM", DEFAULT_PERIOD_MS, elapsed, engine::readable_size(bytes as f64)).into(),
                );
            }
        });
    });
    SENDING.with(|e| *e.borrow_mut() = Some(Sending { _timer: timer, stop_flag }));
}

/// Stops the transmission in progress (screen left, "Stop", back).
pub fn stop() {
    let finished = SENDING.with(|e| e.borrow_mut().take());
    if let Some(e) = finished {
        e.stop_flag.store(true, Ordering::SeqCst);
        #[cfg(target_os = "android")]
        crate::android::max_brightness(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates() {
        assert_eq!(module_for(1440), 32);
        // 1 KB in TM4: 6 frames of 192 bytes, 1.5 s each.
        assert!((seconds_on_screen(1024, Codec::Color4) - 9.0).abs() < 1e-9);
        assert!(seconds_on_screen(1024, Codec::Color8) < seconds_on_screen(1024, Codec::Color4));
        assert_eq!(readable_duration(42.0), "~42 s");
        assert_eq!(readable_duration(600.0), "~10 min");
    }
}
