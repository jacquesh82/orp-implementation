//! The reception engine: ONE receiver (orp-transfer) fed by the camera, and
//! the translation of its events into screen states — code to type,
//! verification code to compare, progress, received file. Independent of
//! Android: the camera lives in `lib.rs`.

use crate::{with_app, App, CodeStep, Screen};
use orp_transfer::{shown_sas, Event, Receiver, TransferredFile};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

thread_local! {
    /// Live throughput: instant and symbols of the FIRST accepted frame.
    static INITIAL_THROUGHPUT: RefCell<Option<(Instant, usize)>> = const { RefCell::new(None) };
    /// The received file, kept in memory until "Save" or "Delete".
    pub static RECEIVED: RefCell<Option<TransferredFile>> = const { RefCell::new(None) };
    /// Codes path: the response code grid, R and P alternating (250 ms).
    static RESPONSE: RefCell<Option<slint::Timer>> = const { RefCell::new(None) };
}

/// Mode (TM4 / TM8) of the last DATA frame read — the init code, always in
/// TM4, does not count.
static DATA_MODE: Mutex<Option<&'static str>> = Mutex::new(None);

/// Number of the reception in progress, bumped ONLY when it is abandoned
/// (back key). A reading thread notes it when it starts: once the reception
/// is abandoned, its late frames and events are dropped — they would
/// otherwise feed the next reception, or bring back the screen just left.
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// The receiver in progress, shared between the camera thread and the UI.
pub fn receiver() -> Arc<Mutex<Receiver>> {
    static R: std::sync::OnceLock<Mutex<Arc<Mutex<Receiver>>>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(Arc::new(Mutex::new(Receiver::new())))).lock().unwrap().clone()
}

/// New receiver (file received, rejected): start from scratch. The
/// transmission just received is ignored (the sender may still be showing
/// it: never the same file twice).
pub fn new_receiver() {
    let r = receiver();
    let mut r = r.lock().unwrap();
    *r = r.next();
}

/// Back key on a reception screen (camera, code): the reception in progress
/// is FORGOTTEN — session, typed code, progress.
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

/// After a received file, the next reception starts from scratch.
pub fn restart_if_finished(app: &App) {
    let finished = receiver().lock().unwrap().phase == orp_transfer::ReceivePhase::Finished;
    if finished {
        new_receiver();
        reset_display(app);
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
    show_sas(app, None);
    app.set_code_step(CodeStep::TypeCode);
    app.set_code_note("".into());
    app.set_code_error("".into());
    app.set_code_typed("".into());
    stop_response(app);
    app.set_block_view(slint::ModelRc::default());
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

/// Processes a new valid frame, on the camera thread; the events go back to
/// the UI.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn on_frame_read(bytes: &[u8], generation: u64) {
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
                with_app(|app| show(app, events));
            }
        });
    }
}

/// Records a message: logcat (Android) or stderr.
pub fn log(message: &str) {
    #[cfg(target_os = "android")]
    crate::android::log(message);
    #[cfg(not(target_os = "android"))]
    eprintln!("[OptiRelay] {message}");
}

/// The receiver's events, on screen (UI thread).
pub fn show(app: &App, events: Vec<Event>) {
    for e in events {
        match e {
            Event::CodeRead { stream_size, by_passphrase, response_code, .. } => {
                let size = readable_size(stream_size as f64);
                show_sas(app, None);
                app.set_code_error("".into());
                app.set_code_typed("".into());
                show_blocks(app);
                match response_code {
                    Some(c) => {
                        // Codes path (sender with a camera): the response grid
                        // for its camera; the SAS comes with its reveal code.
                        log(&format!("init code read: {size} announced, codes pairing."));
                        app.set_code_note(format!("{size} announced.").to_uppercase().into());
                        show_response(app, &c);
                        app.set_code_step(CodeStep::Response);
                    }
                    None => {
                        log(&format!("init code read: {size} announced, passphrase pairing: asking for the code."));
                        let _ = by_passphrase;
                        app.set_code_note(format!("{size} announced. Frames already read are kept.").to_uppercase().into());
                        app.set_code_step(CodeStep::TypeCode);
                    }
                }
                app.set_screen(Screen::Code);
            }
            Event::RevealRead { sas } => {
                log("reveal code read: verification code to compare.");
                stop_response(app);
                show_sas(app, Some(&sas));
                app.set_code_step(CodeStep::Compare);
                app.set_screen(Screen::Code);
            }
            Event::WrongCode => {
                log("frames refused as forged: the typed code is not the sender's.");
                show_sas(app, None);
                app.set_code_typed("".into());
                app.set_code_error("The frames do not open with this code: it is not the sender's. Type it again.".into());
                app.set_code_step(CodeStep::TypeCode);
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
                        Some(b) if b.nb > 1 => format!("{symbols} / {k_total} SYMBOLS / {}/{} BLOCKS", b.complete_count, b.nb),
                        _ => format!("{symbols} / {k_total} SYMBOLS"),
                    }
                    .into(),
                );
                if let Some(name) = *DATA_MODE.lock().unwrap() {
                    app.set_capture_mode(name.into());
                }
                // USEFUL throughput, since the first accepted frame.
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
            Event::File(f) => {
                app.set_received_name(f.name.clone().into());
                app.set_received_size(readable_size(f.data.len() as f64).into());
                app.set_received_mode(DATA_MODE.lock().unwrap().unwrap_or("TM4").into());
                app.set_received_message("".into());
                log(&format!("received and verified: {} ({} bytes)", f.name, f.data.len()));
                show_blocks(app);
                show_preview(app, &f);
                RECEIVED.with(|r| *r.borrow_mut() = Some(f));
                app.set_screen(Screen::Received);
            }
            Event::Rejected => {
                log("reception rejected: the file fingerprint does not match.");
                app.set_capture_title("Rejected: wrong fingerprint. Reading again".into());
                new_receiver();
            }
            Event::NewSending => {
                log("new transmission detected: reception starts over");
                app.set_capture_part(0.0);
                app.set_capture_frames("0".into());
                app.set_capture_throughput("—".into());
                app.set_capture_mode("—".into());
                restore_throughput();
            }
        }
    }
}

/// The verification code to compare (dashes while it is not known yet).
fn show_sas(app: &App, sas: Option<&str>) {
    let digits: Vec<slint::SharedString> = match sas {
        Some(sas) => sas.chars().map(|c| c.to_string().into()).collect(),
        None => (0..6).map(|_| "–".into()).collect(),
    };
    app.set_code_digits(slint::ModelRc::new(slint::VecModel::from(digits)));
    app.set_code_readable(sas.map(shown_sas).unwrap_or_default().into());
}

/// Throughput and mode forgotten: new reception, or new transmission detected.
fn restore_throughput() {
    INITIAL_THROUGHPUT.with(|d| d.borrow_mut().take());
    *DATA_MODE.lock().unwrap() = None;
}

/// Codes path (sender with a camera): the response code as a TM4 grid, R and
/// P alternating every 250 ms. The camera keeps reading meanwhile: once the
/// sender has read this grid, it shows its REVEAL code (ORP v0.2), which
/// gives the verification code here.
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
    let mut phase_p = false;
    let timer = slint::Timer::default();
    timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(250), move || {
        phase_p = !phase_p;
        let image = if phase_p { p.clone() } else { r.clone() };
        with_app(|app| app.set_response_code(image));
    });
    RESPONSE.with(|t| *t.borrow_mut() = Some(timer));
}

fn stop_response(_app: &App) {
    RESPONSE.with(|t| t.borrow_mut().take());
}

/// Passphrase path: the code TYPED by the user (the one the sender shows).
/// The key stretching (PBKDF2, 600 000 rounds) runs on a thread; the
/// verification code then comes back to the screen.
pub fn submit_code(app: &App, typed: &str) {
    let passphrase = orp_transfer::typed_passphrase(typed);
    if passphrase.is_empty() {
        app.set_code_error(format!("Type the {}-character code shown next to the sender's grid.", orp_transfer::CODE_LENGTH).into());
        return;
    }
    app.set_code_error("".into());
    app.set_code_step(CodeStep::Checking);
    let generation = generation();
    std::thread::spawn(move || {
        let result = receiver().lock().unwrap().pair_with_passphrase(&passphrase);
        let _ = slint::invoke_from_event_loop(move || {
            if generation != self::generation() {
                return;
            }
            with_app(|app| match result {
                Ok(sas) => {
                    log("typed code: verification code to compare.");
                    show_sas(app, Some(&sas));
                    app.set_code_step(CodeStep::Compare);
                }
                Err(e) => {
                    app.set_code_error(format!("Code refused: {e}").into());
                    app.set_code_step(CodeStep::TypeCode);
                }
            })
        });
    });
}

/// Codes differ: the typed code is wrong (or someone is in the middle) —
/// type it again; nothing is received meanwhile.
pub fn retype_code(app: &App) {
    show_sas(app, None);
    app.set_code_error("Codes differ: check the code you typed. If it is right, someone is in the middle: cancel.".into());
    app.set_code_step(CodeStep::TypeCode);
}

/// "They match": reception starts (pending frames replayed), back to the camera.
pub fn confirm_code(app: &App) {
    stop_response(app);
    let r = receiver();
    let events = r.lock().unwrap().confirm();
    app.set_capture_title("Receiving".into());
    app.set_screen(Screen::Capture);
    match events {
        Ok(e) => show(app, e),
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

/// Completeness bars, block by block (camera screen).
pub fn show_blocks(app: &App) {
    let share = receiver();
    let Ok(r) = share.try_lock() else { return };
    if r.info.is_none() {
        app.set_block_view(slint::ModelRc::default());
        return;
    }
    let states = r.session().blocks();
    drop(r);
    let views: Vec<crate::BlockView> = orp_transfer::block_view(&states).into_iter().map(|(part, complete)| crate::BlockView { part, complete }).collect();
    app.set_block_view(slint::ModelRc::new(slint::VecModel::from(views)));
}
