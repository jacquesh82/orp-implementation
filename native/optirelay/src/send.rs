//! Sending a file through the phone screen: file choice, settings
//! (mode, mosaic, subframe duration), full-screen transmission.
//!
//! A thread prepares the batches ahead of time (ORP session, R/P rendering by orp-optics);
//! a Slint timer, on the UI thread, alternates R and P at the chosen
//! period. If the next batch is not ready, P stays displayed a little
//! longer, as on the bench.

use crate::{with_app, engine, App, Screen};
use slint::ComponentHandle;
use orp_core::Codec;
use orp_transfer::{batch_images, Sender, TransferredFile, SendSettings};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use orp_transfer::{MAX_COLUMNS, SUBFRAME_PERIODS};

/// Countdown: the receiver aims and reads the init code.
const START_DELAY: Duration = Duration::from_secs(5);
/// Densest mosaic offered by tapping (beyond: calibration code).
const OFFERED_COLUMNS: usize = 4;
/// Display timer step: each switch lands within 2 ms of its
/// instant, instead of drifting from one timer period to the next.
const TIMER_STEP: Duration = Duration::from_millis(2);
/// Tolerance of a switch (ms): a quarter frame at 60 Hz, like the bench.
const TOLERANCE_MS: f64 = 4.0;

/// WHOLE physical pixels per module for a `columns` × `columns` mosaic
/// to fit in `side` pixels (41 modules + 2 × 2 of quiet zone).
fn module_for(side: usize, columns: usize) -> usize {
    (side / (45 * columns.max(1))).max(2)
}

/// Below this (physical pixels per module), reading is not guaranteed; then slow.
const CRITICAL_MODULE: usize = 3;
const COMFORT_MODULE: usize = 5;
/// Same thresholds in logical pixels — a PHYSICAL SIZE: on a very dense
/// screen, 8 physical pixels are only about 0.4 mm.
const CRITICAL_MODULE_LOGICAL: f32 = 2.0;
const COMFORT_MODULE_LOGICAL: f32 = 3.0;

/// Warning if the module rendering guarantees neither quality nor speed
/// (same rule as `diagnosticModule`, packages/browser): enough pixels
/// AND a sufficient size. `density`: physical pixels per logical pixel.
fn module_alert(px: usize, columns: usize, density: f32) -> Option<String> {
    let density = density.max(1.0);
    let comfort = (COMFORT_MODULE as f32).max(COMFORT_MODULE_LOGICAL * density);
    let advised = ((px * 45 * columns) as f32 / (45.0 * comfort)).floor() as usize;
    let logical = px as f32 / density;
    let size = if density > 1.0 { format!(" ({logical:.1} logical px on this dense screen)") } else { String::new() };
    let remedy = if advised >= 1 && advised < columns {
        if advised == 1 { " Switch to one grid.".to_string() } else { format!(" Switch to {advised} × {advised}.") }
    } else {
        String::new()
    };
    if px < CRITICAL_MODULE || logical < CRITICAL_MODULE_LOGICAL {
        Some(format!("⚠ {px} px modules{size}: too small, reading not guaranteed.{remedy}"))
    } else if px < COMFORT_MODULE || logical < COMFORT_MODULE_LOGICAL {
        Some(format!("⚠ {px} px modules{size}: slow reading, keep the phone very close and still.{remedy}"))
    } else if columns > 3 {
        Some(format!("ⓘ {columns} × {columns} mosaic: the phone must film in 4K."))
    } else {
        None
    }
}

/// True if the screen can display 120 Hz or more (8 ms subframes).
fn fast_screen() -> bool {
    #[cfg(target_os = "android")]
    return crate::android::max_frequency() >= 110.0;
    #[cfg(not(target_os = "android"))]
    false
}

struct SendState {
    file: Option<TransferredFile>,
    tm4: bool,
    columns: usize,
    period: u32,
}

type Pair = (slint::SharedPixelBuffer<slint::Rgba8Pixel>, slint::SharedPixelBuffer<slint::Rgba8Pixel>);

enum Message {
    Ready { sas: String, init: Pair, bytes: usize },
    Batch { pair: Pair, frames: u64 },
    Error(String),
}

struct Sending {
    _timer: slint::Timer,
    stop_flag: Arc<AtomicBool>,
}

thread_local! {
    static SEND: RefCell<SendState> = const { RefCell::new(SendState { file: None, tm4: false, columns: 1, period: 100 }) };
    static SENDING: RefCell<Option<Sending>> = const { RefCell::new(None) };
}

fn buffer(image: &orp_optics::render::ImageRGBA) -> slint::SharedPixelBuffer<slint::Rgba8Pixel> {
    slint::SharedPixelBuffer::clone_from_slice(&image.data, image.width as u32, image.height as u32)
}

/// Settings shown on the Send screen.
pub fn show_settings(app: &App) {
    SEND.with(|e| {
        let e = e.borrow();
        app.set_send_mode(if e.tm4 { "TM4 · robust" } else { "TM8 · fast" }.into());
        let grids = if e.columns == 1 { "1 grid".to_string() } else { format!("{0} × {0}", e.columns) };
        let px = module_for(app.window().size().width as usize, e.columns);
        app.set_send_grids(match module_alert(px, e.columns, app.window().scale_factor()) {
            Some(alert) => format!("{grids} — {alert}"),
            None => grids,
        }.into());
        let usage = if e.period < 17 { "120 Hz screen, 240 fps slow-mo" } else if e.period <= 33 { "film in slow-mo" } else if e.period >= 100 { "readable live" } else { "slow-mo advised" };
        app.set_send_subframe(format!("{} ms — {usage}", e.period).into());
        if let Some(f) = &e.file {
            app.set_send_name(f.name.clone().into());
            // Expected useful throughput: 4 symbols (TM8) or 2 (TM4) of 96 bytes per R/P pair.
            let per_pair = (if e.tm4 { 2.0 } else { 4.0 }) * 96.0 * (e.columns * e.columns) as f64;
            let throughput = per_pair / (2.0 * e.period as f64 / 1000.0) * 0.9;
            app.set_send_detail(
                format!("{} · ≈ {:.0} s on screen", engine::readable_size(f.data.len() as f64), (f.data.len() as f64 / throughput).ceil()).into(),
            );
        }
        app.set_send_chosen(e.file.is_some());
    });
}

pub fn file_chosen(f: TransferredFile) {
    engine::log(&format!("file to send: {} ({} bytes, {})", f.name, f.data.len(), f.mime_type));
    SEND.with(|e| e.borrow_mut().file = Some(f));
    with_app(show_settings);
}

/// Tapping a setting cycles it: mode, mosaic, duration.
pub fn set(app: &App, what: i32) {
    SEND.with(|e| {
        let mut e = e.borrow_mut();
        match what {
            0 => e.tm4 = !e.tm4,
            1 => e.columns = e.columns % OFFERED_COLUMNS + 1,
            _ => {
                // 8 ms only if the screen keeps up (120 Hz); otherwise from 17 ms.
                let periods: Vec<u32> = SUBFRAME_PERIODS.iter().copied().filter(|&p| p >= 17 || fast_screen()).collect();
                let i = periods.iter().position(|&p| p == e.period).unwrap_or(2);
                e.period = periods[(i + 1) % periods.len()];
            }
        }
    });
    app.set_send_calibrated(false);
    show_settings(app);
}

/// Setting coming from a calibration (short code "33-2").
#[allow(dead_code)]
pub fn apply_calibration(app: &App, period: u32, columns: usize) {
    SEND.with(|e| {
        let mut e = e.borrow_mut();
        e.period = period;
        e.columns = columns.clamp(1, MAX_COLUMNS as usize);
        e.tm4 = false;
    });
    app.set_send_calibrated(true);
    show_settings(app);
}

pub fn start(app: &App) {
    let Some((file, settings)) = SEND.with(|e| {
        let e = e.borrow();
        e.file.clone().map(|f| (f, SendSettings { codec: if e.tm4 { Codec::Color4 } else { Codec::Color8 }, period_ms: e.period, columns: e.columns }))
    }) else {
        return;
    };
    stop();
    // Module size: the grid takes a square as wide as the screen.
    let side = app.window().size().width as usize;
    let module_init = module_for(side, 1);
    let batch_module = module_for(side, settings.columns);
    engine::log(&format!("transmission: {side} px screen, {batch_module} px per module in {c} × {c}.", c = settings.columns));
    let alert = module_alert(batch_module, settings.columns, app.window().scale_factor()).map(|a| format!("{a}\n")).unwrap_or_default();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<Message>(3);
    let thread_stop_flag = stop_flag.clone();
    std::thread::spawn(move || {
        let mut em = match Sender::new(&file, settings) {
            Ok(em) => em,
            Err(e) => {
                let _ = tx.send(Message::Error(e.to_string()));
                return;
            }
        };
        let init = match batch_images(std::slice::from_ref(&em.init), 1, module_init) {
            Ok((r, p)) => (buffer(&r), buffer(&p)),
            Err(e) => {
                let _ = tx.send(Message::Error(e.to_string()));
                return;
            }
        };
        if tx.send(Message::Ready { sas: em.sas.clone(), init, bytes: em.stream_size }).is_err() {
            return;
        }
        while !thread_stop_flag.load(Ordering::SeqCst) {
            let batch = match em.next_batch() {
                Ok(l) => l,
                Err(e) => {
                    let _ = tx.send(Message::Error(e.to_string()));
                    return;
                }
            };
            let (columns, module) = if batch.len() == 1 { (1, module_init) } else { (settings.columns, batch_module) };
            let pair = match batch_images(&batch, columns, module) {
                Ok((r, p)) => (buffer(&r), buffer(&p)),
                Err(e) => {
                    let _ = tx.send(Message::Error(e.to_string()));
                    return;
                }
            };
            if tx.send(Message::Batch { pair, frames: em.frames }).is_err() {
                return;
            }
        }
        em.finish();
    });

    app.set_sending_count("".into());
    app.set_sending_code("— —".into());
    app.set_sending_hud("Preparing the file…".into());
    app.set_screen(Screen::Sending);
    #[cfg(target_os = "android")]
    crate::android::max_brightness(true);

    // Display: R then P of each pair, at the chosen period.
    let mut code_init: Option<(slint::Image, slint::Image)> = None;
    let mut current: Option<(slint::Image, slint::Image)> = None;
    let mut phase_p = true;
    let mut begin: Option<Instant> = None;
    let mut frames = 0u64;
    let mut stream_start: Option<Instant> = None;
    let mut bytes = 0usize;
    // Switch on elapsed time, not on every timer tick: the
    // timer runs fast (2 ms) and the subframe changes as soon as its duration
    // is reached within a quarter frame — no more drift between the requested
    // period and the screen refresh.
    let mut phase_start: Option<Instant> = None;
    // What is on screen, so it is only set again when it changes.
    let mut count_phase: Option<(bool, u64)> = None;
    let mut waiting_shown = false;
    let period = settings.period_ms as f64;
    let timer = slint::Timer::default();
    let ui_stop_flag = stop_flag.clone();
    timer.start(slint::TimerMode::Repeated, TIMER_STEP, move || {
        if ui_stop_flag.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        // The init code first (countdown).
        if code_init.is_none() {
            match rx.try_recv() {
                Ok(Message::Ready { sas, init, bytes: o }) => {
                    let code = format!("{} {}", &sas[..3], &sas[3..]);
                    bytes = o;
                    code_init = Some((slint::Image::from_rgba8(init.0), slint::Image::from_rgba8(init.1)));
                    begin = Some(now);
                    with_app(|app| app.set_sending_code(code.into()));
                }
                Ok(Message::Error(e)) => {
                    with_app(|app| app.set_sending_hud(format!("Cannot transmit: {e}").into()));
                    return;
                }
                _ => return,
            }
        }
        let elapsed = now - begin.unwrap_or(now);
        if elapsed < START_DELAY {
            let rest = START_DELAY.saturating_sub(elapsed).as_secs() + 1;
            // SLOW countdown (≥ 100 ms per subframe) whatever
            // the period: the receiver reads the code there and learns the gray
            // reference, which an LCD does not stabilize in 17 ms.
            let slow = settings.period_ms.max(100) as u128;
            phase_p = (elapsed.as_millis() / slow) % 2 == 1;
            if count_phase == Some((phase_p, rest)) {
                return;
            }
            count_phase = Some((phase_p, rest));
            let (r, p) = code_init.as_ref().unwrap();
            with_app(|app| {
                app.set_sending_grid(if phase_p { p.clone() } else { r.clone() });
                app.set_sending_count(rest.to_string().into());
                app.set_sending_hud("The receiver aims at the screen and is already reading the initialization code.".into());
            });
            return;
        }
        let expired = phase_start.map(|d| (now - d).as_secs_f64() * 1000.0 >= period - TOLERANCE_MS).unwrap_or(true);
        if !expired {
            return;
        }
        // After P comes the R of the next batch. Not ready yet? The GRAY R
        // (identical for all frames) is shown meanwhile: P
        // keeps its exact duration, R is lengthened by the preparation time.
        if phase_p || current.is_none() {
            match rx.try_recv() {
                Ok(Message::Batch { pair, frames: n }) => {
                    current = Some((slint::Image::from_rgba8(pair.0), slint::Image::from_rgba8(pair.1)));
                    frames = n;
                    stream_start.get_or_insert_with(Instant::now);
                    waiting_shown = false;
                    phase_p = true; // the switch below opens the batch on its R
                }
                Ok(Message::Error(e)) => {
                    with_app(|app| app.set_sending_hud(format!("Transmission interrupted: {e}").into()));
                    return;
                }
                _ => {
                    if !waiting_shown {
                        if let Some((r, _)) = current.as_ref() {
                            let r = r.clone();
                            with_app(|app| app.set_sending_grid(r));
                            waiting_shown = true;
                        }
                    }
                    return;
                }
            }
        }
        let Some((r, p)) = current.as_ref() else { return };
        phase_p = !phase_p;
        phase_start = Some(now);
        let throughput = stream_start.map(|d| frames as f64 * 384.0 / d.elapsed().as_secs_f64().max(0.1)).unwrap_or(0.0);
        with_app(|app| {
            app.set_sending_grid(if phase_p { p.clone() } else { r.clone() });
            app.set_sending_count("".into());
            app.set_sending_hud(
                format!("{alert}{} frames · {}/s sent · {} stream", frames, engine::readable_size(throughput), engine::readable_size(bytes as f64)).into(),
            );
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
    fn module_alerts() {
        assert_eq!(module_alert(8, 3, 1.0), None);
        assert!(module_alert(6, 4, 1.0).unwrap().contains("4K"));
        assert!(module_alert(4, 3, 1.0).unwrap().contains("2 × 2"));
        assert!(module_alert(2, 4, 1.0).unwrap().contains("one grid"));
        // Density-3 phone: 10 physical px = 3.3 logical px, just above.
        assert_eq!(module_alert(10, 3, 3.0), None);
        assert!(module_alert(8, 3, 3.0).unwrap().contains("slow reading"));
        assert!(module_alert(5, 4, 3.0).unwrap().contains("too small"));
        assert_eq!(module_for(1440, 3), 10);
    }
}
