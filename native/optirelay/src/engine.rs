//! The app engine: ONE receiver (orp-transfer) shared by the video
//! and the camera, and the translation of its events into screen states.
//! Independent of Android: the image sources live in `lib.rs`.

use crate::{with_app, App, Screen};
use orp_transfer::{Event, TransferredFile, Receiver};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

thread_local! {
    /// Live throughput: instant and symbols of the FIRST accepted frame.
    static INITIAL_THROUGHPUT: RefCell<Option<(Instant, usize)>> = const { RefCell::new(None) };
}

/// Mode (TM4 / TM8) of the last DATA frame read — the repeats of the
/// init code, always in TM4, do not count.
static DATA_MODE: Mutex<Option<&'static str>> = Mutex::new(None);

/// Number of the reception in progress, bumped ONLY when it is abandoned (back
/// key) — not by the other new receivers (file rejected, received…), which
/// keep the camera reading. A reading thread notes it when it starts: once the
/// reception is abandoned, its late frames and events are dropped — they would
/// otherwise feed the next reception, or bring back the screen just left.
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

thread_local! {
    /// The received file, kept in memory until "Save" or "Delete".
    pub static RECEIVED: RefCell<Option<TransferredFile>> = const { RefCell::new(None) };
}

/// The receiver in progress, shared between the reading threads and the UI.
pub fn receiver() -> Arc<Mutex<Receiver>> {
    static R: std::sync::OnceLock<Mutex<Arc<Mutex<Receiver>>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(Arc::new(Mutex::new(Receiver::new())))).lock().unwrap().clone()
}

/// New receiver (file received, rejected, aborted): start from scratch.
/// The transmission just received is ignored (the sender may still
/// be showing it: never the same file twice).
pub fn new_receiver() {
    let r = receiver();
    let mut r = r.lock().unwrap();
    *r = r.next();
}

/// Back key on a reception screen (camera, code, slow motion): the reception
/// in progress is FORGOTTEN — session, pairing code, progress, slow-motion
/// reading. The next capture starts from scratch, as after "Abandon".
pub fn abandon(app: &App) {
    let started = {
        let r = receiver();
        let r = r.lock().unwrap();
        r.frames_read > 0 || r.info.is_some()
    };
    // Before the new receiver: a thread that takes the lock afterwards sees it.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    new_receiver();
    reset_display(app);
    if started {
        log("reception abandoned (back): the next capture starts from scratch.");
    }
}

/// After a received file, the next reception starts from scratch — session AND
/// screens (progress, code, slow-motion reading). Called at the start of a
/// new reception: back from the "received" screen, camera, shooting.
pub fn restart_if_finished(app: &App) {
    let finished = receiver().lock().unwrap().phase == orp_transfer::ReceivePhase::Finished;
    if finished {
        new_receiver();
        reset_display(app);
        log("new reception: screens reset.");
    }
}

/// Reception screens back to their initial state.
pub fn reset_display(app: &App) {
    app.set_capture_part(0.0);
    app.set_capture_title("Reading the sender's code".into());
    app.set_capture_detail("".into());
    app.set_capture_frames("0".into());
    app.set_capture_throughput("—".into());
    app.set_capture_mode("—".into());
    app.set_capture_errors("—".into());
    restore_throughput();
    app.set_code_readable("".into());
    let dashes: Vec<slint::SharedString> = (0..6).map(|_| "–".into()).collect();
    app.set_code_digits(slint::ModelRc::new(slint::VecModel::from(dashes)));
    app.set_code_note("".into());
    stop_response(app);
    app.set_slow_motion_share(0.0);
    app.set_slow_motion_step(0);
    app.set_slow_motion_title("Reading the video".into());
    app.set_slow_motion_help("Film the transmission; the app reads the video afterwards, not in real time.".into());
    app.set_slow_motion_filmed("—".into());
    app.set_slow_motion_grids("—".into());
    app.set_slow_motion_frames("—".into());
    app.set_slow_motion_message("".into());
    app.set_slow_motion_next(0);
    app.set_receive_info("".into());
    app.set_block_view(slint::ModelRc::default());
    app.set_file_title("".into());
}

pub fn readable_size(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{} B", bytes.round())
    } else if bytes < 1024.0 * 1024.0 {
        format!("{:.1} KB", bytes / 1024.0)
    } else {
        format!("{:.1} MB", bytes / 1024.0 / 1024.0)
    }
}

/// Processes a new valid frame, on the source's thread; the events
/// go back to the UI. `source`: "slow-motion" or "live".
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn on_frame_read(bytes: &[u8], source: &'static str, generation: u64) {
    // Frame of an abandoned reception, read before the thread stopped.
    if generation != self::generation() {
        return;
    }
    if !orp_transfer::is_pairing_frame(bytes) {
        if let Some(name) = orp_core::frames::read_meta_by_majority(bytes).ok().and_then(|e| orp_optics::temporal::tm_name(e.codec).ok()) {
            *DATA_MODE.lock().unwrap() = Some(name);
        }
    }
    let r = receiver();
    let mut r = r.lock().unwrap();
    // Checked again under the lock: the reception may have been abandoned meanwhile.
    if generation != self::generation() {
        return;
    }
    let events = match r.process(bytes) {
        Ok(e) => e,
        Err(e) => {
            log(&format!("frame: {e}"));
            return;
        }
    };
    drop(r);
    if !events.is_empty() {
        let _ = slint::invoke_from_event_loop(move || {
            if generation == self::generation() {
                with_app(|app| show(app, events, source));
            }
        });
    }
}

/// The last lines of the log, shown by the Log screen.
static LOG: std::sync::Mutex<std::collections::VecDeque<String>> = std::sync::Mutex::new(std::collections::VecDeque::new());
const LOG_LINES: usize = 300;

fn app_start() -> std::time::Instant {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    *START.get_or_init(std::time::Instant::now)
}

/// Records a message: logcat (Android) or stderr, and the Log screen.
pub fn log(message: &str) {
    #[cfg(target_os = "android")]
    crate::android::log(message);
    #[cfg(not(target_os = "android"))]
    eprintln!("[OptiRelay] {message}");
    let s = app_start().elapsed().as_secs();
    let line = format!("{:02}:{:02}:{:02}  {message}", s / 3600, s / 60 % 60, s % 60);
    {
        let mut j = LOG.lock().unwrap();
        j.push_front(line);
        j.truncate(LOG_LINES);
    }
    let _ = slint::invoke_from_event_loop(|| with_app(show_log));
}

/// Log lines to the screen (UI thread).
pub fn show_log(app: &App) {
    let lines: Vec<slint::SharedString> = LOG.lock().unwrap().iter().map(|l| l.as_str().into()).collect();
    app.set_log_lines(slint::ModelRc::new(slint::VecModel::from(lines)));
}

pub fn clear_log(app: &App) {
    LOG.lock().unwrap().clear();
    show_log(app);
}

/// The receiver's events, on screen (UI thread).
pub fn show(app: &App, events: Vec<Event>, source: &'static str) {
    for e in events {
        match e {
            Event::CodeRead { sas, stream_size, by_passphrase, response_code } => {
                log(&format!("initialization code read: {} announced, code {sas}.", readable_size(stream_size as f64)));
                let digits: Vec<slint::SharedString> = sas.chars().map(|c| c.to_string().into()).collect();
                app.set_code_digits(slint::ModelRc::new(slint::VecModel::from(digits)));
                app.set_code_readable(format!("{} {}", &sas[..3.min(sas.len())], &sas[3.min(sas.len())..]).into());
                let note = if by_passphrase {
                    format!("Sender without a camera (bench): {} announced.", readable_size(stream_size as f64))
                } else {
                    format!("{} announced.", readable_size(stream_size as f64))
                };
                app.set_code_note(note.into());
                show_blocks(app);
                match response_code {
                    Some(c) => show_response(app, &c),
                    None => stop_response(app),
                }
                app.set_screen(Screen::Code);
            }
            Event::Progress { symbols, k_total, accepted } => {
                // Progress by blocks (a total ≥ K guarantees nothing).
                let blocks = receiver().try_lock().ok().map(|r| orp_transfer::block_summary(&r.session().blocks()));
                let part = blocks.map(|b| b.part as f32).unwrap_or(if k_total > 0 { (symbols as f32 / k_total as f32).min(0.99) } else { 0.0 });
                app.set_capture_part(part);
                app.set_capture_title("Receiving".into());
                app.set_capture_frames(accepted.to_string().into());
                show_blocks(app);
                app.set_capture_detail(
                    match blocks {
                        Some(b) if b.nb > 1 => format!("{symbols} / {k_total} symbols · {}/{} blocks complete", b.complete_count, b.nb),
                        _ => format!("{symbols} / {k_total} symbols"),
                    }
                    .into(),
                );
                if let Some(name) = *DATA_MODE.lock().unwrap() {
                    app.set_capture_mode(name.into());
                }
                // USEFUL live throughput, since the first accepted frame. In
                // slow motion, the computation clock says nothing about the channel: the
                // slow-motion screen has its own measurements.
                if source == "live" {
                    let now = Instant::now();
                    let throughput = INITIAL_THROUGHPUT.with(|d| {
                        let (t0, s0) = *d.borrow_mut().get_or_insert((now, symbols));
                        let duration = now.duration_since(t0).as_secs_f64();
                        (duration >= 1.0 && symbols > s0).then(|| ((symbols - s0) * orp_core::frames::SYMBOL_SIZE) as f64 / duration)
                    });
                    if let Some(d) = throughput {
                        app.set_capture_throughput(format!("{}/s", readable_size(d)).into());
                    }
                }
            }
            Event::File(f) => {
                app.set_received_name(f.name.clone().into());
                app.set_received_size(readable_size(f.data.len() as f64).into());
                app.set_received_filmed(if source == "slow-motion" { "slow-mo".into() } else { "live".into() });
                app.set_received_mode("TM8 / TM4".into());
                log(&format!("received and verified: {} ({} bytes)", f.name, f.data.len()));
                show_blocks(app);
                show_preview(app, &f);
                RECEIVED.with(|r| *r.borrow_mut() = Some(f));
                app.set_screen(Screen::Received);
            }
            Event::Rejected => {
                app.set_slow_motion_message("Reception rejected: the file fingerprint does not match.".into());
                new_receiver();
            }
            Event::NewSending => {
                log("new transmission detected: reception starts over");
                app.set_slow_motion_next(0);
                app.set_receive_info("".into());
                app.set_slow_motion_message(
                    "ANOTHER transmission was filmed (different code): the previous reception is abandoned, \
                     this one starts from scratch. To complete a transfer, leave its transmission running without restarting it."
                        .into(),
                );
                app.set_capture_part(0.0);
                app.set_capture_frames("0".into());
                app.set_capture_throughput("—".into());
                app.set_capture_mode("—".into());
                restore_throughput();
            }
        }
    }
}

/// Throughput and mode forgotten: new reception, or new transmission detected.
fn restore_throughput() {
    INITIAL_THROUGHPUT.with(|d| d.borrow_mut().take());
    *DATA_MODE.lock().unwrap() = None;
}

thread_local! {
    /// Strong mode: the response code grid, R and P alternating (250 ms).
    static RESPONSE: RefCell<Option<slint::Timer>> = const { RefCell::new(None) };
}

/// Strong mode (sender with a camera, the web app): the response code as a TM4
/// grid, R and P alternating every 250 ms, like the web app.
fn show_response(app: &App, code: &[u8]) {
    let images = orp_transfer::pairing_frame(code).and_then(|t| orp_transfer::batch_images(&[t], 1, 8));
    let Ok((r, p)) = images else {
        log("response code: rendering failed");
        return;
    };
    let to_image = |i: &orp_optics::render::ImageRGBA| {
        slint::Image::from_rgba8(slint::SharedPixelBuffer::clone_from_slice(&i.data, i.width as u32, i.height as u32))
    };
    let (r, p) = (to_image(&r), to_image(&p));
    app.set_response_code(r.clone());
    app.set_code_has_response(true);
    let mut phase_p = false;
    let timer = slint::Timer::default();
    timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(250), move || {
        phase_p = !phase_p;
        let image = if phase_p { p.clone() } else { r.clone() };
        with_app(|app| app.set_response_code(image));
    });
    RESPONSE.with(|t| *t.borrow_mut() = Some(timer));
    log("strong mode: response code shown for the sender's camera.");
}

pub fn stop_response(app: &App) {
    RESPONSE.with(|t| t.borrow_mut().take());
    app.set_code_has_response(false);
}

/// "Identical": reception starts (pending frames replayed).
pub fn confirm_code(app: &App, back: Screen) {
    stop_response(app);
    let r = receiver();
    let events = r.lock().unwrap().confirm();
    app.set_screen(back);
    match events {
        Ok(e) => show(app, e, if back == Screen::SlowMotion { "slow-motion" } else { "live" }),
        Err(e) => log(&format!("confirmation: {e}")),
    }
}

/// Preview of the received file: image decoded in memory (nothing is opened by
/// another app), otherwise the start of the text, otherwise nothing.
fn show_preview(app: &App, f: &TransferredFile) {
    if f.mime_type.starts_with("image/") {
        if let Ok(image) = image::load_from_memory(&f.data) {
            // Capped: the preview does not need full resolution.
            let image = image.thumbnail(1600, 1600).to_rgba8();
            let (l, h) = image.dimensions();
            let buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(image.as_raw(), l, h);
            app.set_received_preview(slint::Image::from_rgba8(buffer));
            app.set_received_has_preview(true);
            return;
        }
    }
    app.set_received_has_preview(false);
    let text = if f.mime_type.starts_with("text/") || std::str::from_utf8(&f.data).is_ok() {
        let start: String = String::from_utf8_lossy(&f.data).chars().take(240).collect();
        format!("“{}”", start.trim())
    } else {
        format!("{} — no preview for this file type.", f.mime_type)
    };
    app.set_received_text_preview(text.into());
}

/// Completeness bars, block by block (slow-motion, live and Receive screens).
pub fn show_blocks(app: &App) {
    let share = receiver();
    let Ok(r) = share.try_lock() else { return };
    if r.info.is_none() {
        app.set_block_view(slint::ModelRc::default());
        app.set_file_title("".into());
        return;
    }
    let states = r.session().blocks();
    drop(r);
    let summary = orp_transfer::block_summary(&states);
    let views: Vec<crate::BlockView> = orp_transfer::block_view(&states).into_iter().map(|(part, complete)| crate::BlockView { part, complete }).collect();
    app.set_block_view(slint::ModelRc::new(slint::VecModel::from(views)));
    let part = if summary.complete_count == summary.nb { 100.0 } else { (100.0 * summary.part).min(99.0) };
    app.set_file_title(
        if summary.nb > 1 { format!("{}/{} blocks · ≈ {part:.0}%", summary.complete_count, summary.nb) } else { format!("≈ {part:.0}%") }.into(),
    );
}
