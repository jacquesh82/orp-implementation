//! OptiRelay native: Slint interface (Material 3) and the ORP protocol in Rust
//! (orp-core, orp-optics, orp-transfer). Image sources: the video
//! shot in slow motion (MediaCodec) and the live camera (NDK Camera2).

slint::include_modules!();

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod camera_android;
mod send;
mod engine;
#[cfg(target_os = "android")]
mod video_android;

use slint::ComponentHandle;
use std::cell::RefCell;

thread_local! {
    /// The window, for callbacks from the threads and from the Android host.
    static APP: RefCell<Option<slint::Weak<App>>> = const { RefCell::new(None) };
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn with_app_value<R>(f: impl FnOnce(&App) -> R) -> Option<R> {
    APP.with(|a| a.borrow().as_ref().and_then(|w| w.upgrade()).map(|app| f(&app)))
}

pub(crate) fn with_app(f: impl FnOnce(&App)) {
    APP.with(|a| {
        if let Some(app) = a.borrow().as_ref().and_then(|w| w.upgrade()) {
            f(&app);
        }
    });
}

/// The next slow-motion shot is the bench calibration series (not a transfer).
static CALIBRATION_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The next slow-motion shot is a TRANSFER TEST (Test bench tab).
static TEST_REQUEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Maximum duration of a slow-motion shot (s).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const SLOW_MOTION_SECONDS: i32 = 30;

/// Opens the main window and returns when it is closed.
pub fn launch() -> Result<(), slint::PlatformError> {
    let app = App::new()?;
    APP.with(|a| *a.borrow_mut() = Some(app.as_weak()));
    let weak = app.as_weak();
    app.on_quit(move || {
        if let Some(app) = weak.upgrade() {
            let _ = app.hide();
        }
    });
    app.on_film(|| {
        with_app(engine::restart_if_finished);
        #[cfg(target_os = "android")]
        {
            sources::close_camera();
            // Continuation of a started transfer: advised duration and code to find again.
            let (next, code) = with_app_value(|app| (app.get_slow_motion_next(), app.get_code_readable().to_string())).unwrap_or((0, String::new()));
            let in_progress = engine::receiver().lock().unwrap().phase == orp_transfer::ReceivePhase::Data;
            if in_progress && next > 0 {
                // The advised duration already has its margin; filming may go a little beyond.
                let max = ((next as f64 * 1.2) as i32 + 6).clamp(10, 60);
                let instruction = format!("Continue: the sender must STILL show code {code}. Film ≈ {next} s");
                android::film_slow_motion(max, next, &instruction);
            } else {
                android::film_slow_motion(SLOW_MOTION_SECONDS, 0, "Start filming as soon as the sender's countdown begins");
            }
        }
        #[cfg(not(target_os = "android"))]
        with_app(|app| {
            app.set_slow_motion_message("Slow-mo filming is only available on Android (240 fps).".into());
            app.set_screen(Screen::SlowMotion);
        });
    });
    app.on_dark_bars(|dark| {
        #[cfg(target_os = "android")]
        android::light_bars(!dark);
        let _ = dark;
    });
    app.on_confirm_code(|| {
        with_app(|app| {
            let back = if app.get_receive_mode() == 1 { Screen::SlowMotion } else { Screen::Capture };
            engine::confirm_code(app, back);
        })
    });
    app.on_import_video(|| {
        #[cfg(target_os = "android")]
        android::choose_video();
        #[cfg(not(target_os = "android"))]
        with_app(|app| app.set_slow_motion_message("Import a video: Android only.".into()));
    });
    app.on_abort_transfer(|| {
        engine::new_receiver();
        with_app(|app| {
            engine::reset_display(app);
            engine::log("transfer in progress abandoned: the next video starts from scratch.");
        });
    });
    app.on_reject_code(|| {
        engine::new_receiver();
        with_app(|app| {
            engine::stop_response(app);
            app.set_code_readable("".into());
            app.set_screen(Screen::Home);
        });
    });
    app.on_cancel_reading(|| {
        #[cfg(target_os = "android")]
        sources::cancel_reading();
    });
    app.on_save(|| {
        let message = engine::RECEIVED.with(|r| match r.borrow().as_ref() {
            #[cfg(target_os = "android")]
            Some(f) => {
                if android::save(&f.name, &f.mime_type, &f.data) {
                    format!("“{}” saved to Downloads.", f.name)
                } else {
                    "Android refused to save the file.".to_string()
                }
            }
            #[cfg(not(target_os = "android"))]
            Some(f) => {
                let path = std::env::temp_dir().join(&f.name);
                match std::fs::write(&path, &f.data) {
                    Ok(()) => format!("Saved: {}", path.display()),
                    Err(e) => format!("Could not save: {e}"),
                }
            }
            None => "No file in memory.".to_string(),
        });
        engine::log(&message);
        with_app(|app| app.set_received_filmed(message.into()));
    });
    app.on_share(|| {
        engine::RECEIVED.with(|r| {
            if let Some(f) = r.borrow().as_ref() {
                #[cfg(target_os = "android")]
                if !android::share(&f.name, &f.mime_type, &f.data) {
                    engine::log("Android refused to share.");
                }
                #[cfg(not(target_os = "android"))]
                engine::log(&format!("sharing “{}”: Android only.", f.name));
            }
        })
    });
    app.on_clear_log(|| with_app(engine::clear_log));
    app.on_choose_file(|| {
        #[cfg(target_os = "android")]
        android::choose_file();
        #[cfg(not(target_os = "android"))]
        {
            // Desktop: OPTIRELAY_FILE, otherwise a test text.
            let f = std::env::var("OPTIRELAY_FILE")
                .ok()
                .and_then(|c| {
                    let data = std::fs::read(&c).ok()?;
                    let name = std::path::Path::new(&c).file_name()?.to_string_lossy().into_owned();
                    Some(orp_transfer::TransferredFile { name, mime_type: "application/octet-stream".into(), data })
                })
                .unwrap_or_else(|| orp_transfer::TransferredFile {
                    name: "sample.txt".into(),
                    mime_type: "text/plain".into(),
                    data: "OptiRelay native sample. ".repeat(200).into_bytes(),
                });
            send::file_chosen(f);
        }
    });
    app.on_configure_send(|i| with_app(|app| send::set(app, i)));
    app.on_film_test(|| {
        TEST_REQUEST.store(true, std::sync::atomic::Ordering::SeqCst);
        #[cfg(target_os = "android")]
        {
            sources::close_camera();
            android::film_slow_motion(SLOW_MOTION_SECONDS, 0, "Test: film from the bench countdown until “Enough sent”");
        }
        #[cfg(not(target_os = "android"))]
        with_app(|app| app.set_test_state("The test is filmed in slow-mo: Android only.".into()));
    });
    app.on_send_test(|| {
        with_app(|app| {
            let ko = [10usize, 50, 200][app.get_test_size().clamp(0, 2) as usize];
            // Pseudo-random bytes: compression gains nothing, the
            // sent stream really has the announced size.
            let mut x: u32 = 0x9e37_79b9;
            let data: Vec<u8> = (0..ko * 1024)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    x as u8
                })
                .collect();
            send::file_chosen(orp_transfer::TransferredFile {
                name: format!("test-{ko}kb.bin"),
                mime_type: "application/octet-stream".into(),
                data,
            });
            send::start(app);
        })
    });
    app.on_film_calibration(|| {
        CALIBRATION_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
        #[cfg(target_os = "android")]
        {
            // The whole series, countdown included, with some margin.
            let series = (orp_transfer::CALIBRATION_SERIES_DURATION / 1000) as i32 + 4;
            sources::close_camera();
            android::film_slow_motion(series + 8, series, "Calibration: start filming during the bench countdown");
        }
        #[cfg(not(target_os = "android"))]
        with_app(|app| app.set_bench_state("Calibration is filmed in slow-mo: Android only.".into()));
    });
    app.on_apply_calibration(|| {
        with_app(|app| {
            let code = app.get_bench_code().to_string();
            if let Some((p, c)) = orp_transfer::read_calibration_code(&code) {
                send::apply_calibration(app, p, c as usize);
                app.set_bench_state(format!("Setting {code} applied to your sends (Send tab).").into());
            }
        })
    });
    app.on_start_sending(|| with_app(send::start));
    send::show_settings(&app);
    app.on_delete(|| {
        engine::RECEIVED.with(|r| *r.borrow_mut() = None);
        with_app(|app| app.set_screen(Screen::Home));
    });
    app.on_screen_change(|screen| {
        thread_local! {
            static PREVIOUS: std::cell::Cell<Screen> = const { std::cell::Cell::new(Screen::Home) };
        }
        let previous = PREVIOUS.with(|p| p.replace(screen));
        if screen != Screen::Sending {
            send::stop();
        }
        if screen == Screen::Home && matches!(previous, Screen::Capture | Screen::Code | Screen::SlowMotion) {
            // Back from a reception screen: the reception is forgotten, and a
            // slow-motion video still being read stops.
            #[cfg(target_os = "android")]
            sources::cancel_reading();
            with_app(engine::abandon);
        } else if matches!(screen, Screen::Home | Screen::Capture) {
            // Leaving the "received" screen, or a new reading: start from scratch.
            with_app(engine::restart_if_finished);
        }
        #[cfg(target_os = "android")]
        if screen == Screen::Capture {
            sources::open_camera();
        } else if screen != Screen::Code {
            sources::close_camera();
        }
        let _ = screen;
    });
    engine::log("OptiRelay native started.");
    #[cfg(target_os = "android")]
    android::request_camera();
    app.run()
}

/// Back from the shooting screen (JSON: path, frameRate, width, height, duration — or error).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn slow_motion_finished(json: &str) {
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let field = |name: &str| -> Option<String> {
        match value.get(name)? {
            serde_json::Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        }
    };
    let test = TEST_REQUEST.swap(false, std::sync::atomic::Ordering::SeqCst) || value.get("test").is_some();
    if test {
        with_app(|app| {
            app.set_screen(Screen::Home);
            app.set_current_tab(2);
            app.set_bench_tab(1);
            if let Some(e) = field("error") {
                app.set_test_state(e.into());
            }
        });
        #[cfg(target_os = "android")]
        if let Some(path) = field("path") {
            sources::read_test(path);
        }
        return;
    }
    let calibration = CALIBRATION_REQUESTED.swap(false, std::sync::atomic::Ordering::SeqCst) || value.get("calibration").is_some();
    if calibration {
        with_app(|app| {
            app.set_screen(Screen::Home);
            app.set_current_tab(2);
            if let Some(e) = field("error") {
                app.set_bench_state(e.into());
            }
        });
        #[cfg(target_os = "android")]
        if let Some(path) = field("path") {
            sources::read_calibration(path);
        }
        return;
    }
    with_app(|app| {
        engine::restart_if_finished(app);
        app.set_receive_mode(1);
        app.set_screen(Screen::SlowMotion);
        if let Some(e) = field("error") {
            app.set_slow_motion_message(e.into());
            app.set_slow_motion_step(0);
        }
    });
    #[cfg(target_os = "android")]
    if let Some(path) = field("path") {
        sources::read_slow_motion(path);
    }
}

/// File chosen in the Android picker.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn file_chosen(name: String, mime_type: String, data: Vec<u8>) {
    send::file_chosen(orp_transfer::TransferredFile { name, mime_type, data });
}

/// Answer to the camera permission request.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn camera_permission_result(granted: bool) {
    if !granted {
        with_app(|app| app.set_capture_advice("Camera denied: OptiRelay cannot read the sending screen.".into()));
    }
}

#[cfg(target_os = "android")]
mod sources {
    //! The two image sources: the filmed video, the live camera.

    use super::*;
    use orp_optics::pipeline::TmPipeline;
    use orp_optics::tm_receiver::TmReceiverOptions;
    use orp_optics::render::ImageRGBA;
    use orp_transfer::AdaptiveReader;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    static CANCEL: AtomicBool = AtomicBool::new(false);
    /// The live analysis thread is busy: the camera converts nothing.
    static BUSY: AtomicBool = AtomicBool::new(false);
    /// Analysis at the sensor's full resolution (dense mosaic) rather than reduced.
    static FULL_RESOLUTION: AtomicBool = AtomicBool::new(false);
    /// Ordinary analysis width; beyond it, the image is reduced.
    const REDUCED_WIDTH: usize = 1920;
    /// Below this (analyzed pixels per module), switch to full resolution.
    const FINE_MODULES: f64 = 8.0;

    pub fn cancel_reading() {
        CANCEL.store(true, Ordering::SeqCst);
    }

    /// Reads the filmed video in a separate thread, image by image; the frames
    /// go to the shared receiver, the progress to the screen.
    pub fn read_slow_motion(path: String) {
        CANCEL.store(false, Ordering::SeqCst);
        with_app(|app| {
            app.set_slow_motion_step(1);
            app.set_slow_motion_title("Reading the video".into());
            app.set_slow_motion_share(0.0);
            app.set_slow_motion_help("The phone analyzes the images, not in real time. You can put it down.".into());
        });
        let generation = engine::generation();
        std::thread::spawn(move || {
            let start = Instant::now();
            let mut reader = AdaptiveReader::new();
            let mut image = ImageRGBA { width: 0, height: 0, data: Vec::new() };
            let mut last = Instant::now();
            let mut filmed = 0.0f64;
            let mut code_aborted = false;
            // Sending states read from the video: the sender's clock.
            let mut tracking = orp_transfer::SenderTracker::default();
            let symbols_before = engine::receiver().lock().unwrap().session().progress().received_symbols;
            let result = video_android::read_video(&path, |v| {
                if CANCEL.load(Ordering::SeqCst) {
                    return false;
                }
                let t = v.instant_ms / 1000.0;
                filmed = t;
                // File complete: no need to read the rest. Code still not
                // read after the first seconds of grid: no point either.
                let phase = engine::receiver().lock().unwrap().phase;
                if phase == orp_transfer::ReceivePhase::Finished {
                    return false;
                }
                if phase == orp_transfer::ReceivePhase::Code && reader.code_timed_out(t) {
                    code_aborted = true;
                    return false;
                }
                let part = if v.duration_ms > 0.0 { (v.instant_ms / v.duration_ms) as f32 } else { 0.0 };
                if reader.should_analyze(t) {
                    image.width = v.width as usize;
                    image.height = v.height as usize;
                    v.rgba_into(&mut image.data);
                    for r in reader.analyze(t, &image) {
                        if let Some(frame) = r.frame.filter(|t| t.is_new) {
                            if let Some(state) = orp_transfer::read_state(&frame.bytes) {
                                tracking.note(t, state);
                            }
                            engine::on_frame_read(&frame.bytes, "slow-motion", generation);
                        }
                    }
                }
                if last.elapsed().as_millis() >= 250 {
                    last = Instant::now();
                    let p = reader.progress();
                    let elapsed = start.elapsed().as_secs_f64();
                    let _ = slint::invoke_from_event_loop(move || {
                        if engine::generation() != generation {
                            return;
                        }
                        with_app(|app| {
                            app.set_slow_motion_share(part);
                            app.set_slow_motion_filmed(format!("{:.1} s", p.position).into());
                            app.set_slow_motion_grids(p.grids.to_string().into());
                            app.set_slow_motion_frames(p.valid_count.to_string().into());
                            app.set_slow_motion_help(
                                format!(
                                    "{} images read, {} analyzed in {:.0} s. You can put the phone down.",
                                    p.seen_images, p.analyzed_images, elapsed
                                )
                                .into(),
                            );
                        })
                    });
                }
                true
            });
            let p = reader.progress();
            let elapsed = start.elapsed().as_secs_f64();
            let resume = match &result {
                Ok(i) => format!(
                    "Video read: {} images ({:.1} s filmed), {} analyzed in {:.0} s, {} valid frames.",
                    i.images, i.duration_s, p.analyzed_images, elapsed, p.valid_count
                ),
                Err(_) if code_aborted => orp_transfer::CODE_NOT_READ_MESSAGE.to_string(),
                Err(_) if engine::receiver().lock().unwrap().phase == orp_transfer::ReceivePhase::Finished => {
                    format!("File complete at {filmed:.1} s of video, after {elapsed:.0} s of reading: the rest is skipped.")
                }
                Err(e) => format!("Reading interrupted: {e}"),
            };
            engine::log(&resume);
            let summary = tracking.summary(reader.first_grid.unwrap_or(0.0), filmed);
            if let Some(b) = &summary {
                engine::log(&format!(
                    "video aligned with the sender: from {} to {}; transmission rate {:?} symbols/s",
                    orp_transfer::clock(b.start_s),
                    orp_transfer::clock(b.end_s),
                    b.sending_throughput.map(|d| d.round())
                ));
            }
            let _ = slint::invoke_from_event_loop(move || {
                // Reception abandoned while reading (back key): nothing to show.
                if engine::generation() != generation {
                    return;
                }
                with_app(|app| {
                    app.set_slow_motion_share(1.0);
                    app.set_slow_motion_step(2);
                    engine::show_blocks(app);
                    app.set_slow_motion_title("Video read".into());
                    app.set_slow_motion_help(resume.into());
                    if app.get_screen() == Screen::Received {
                        return;
                    }
                    let r = engine::receiver();
                    let r = r.lock().unwrap();
                    let message = match r.phase {
                        orp_transfer::ReceivePhase::Code => orp_transfer::CODE_NOT_READ_MESSAGE.to_string(),
                        orp_transfer::ReceivePhase::Verification => "Compare the verification code to continue.".to_string(),
                        _ => {
                            let received_count = r.session().progress().received_symbols as f64;
                            // REAL progress, block by block: the file is
                            // complete only if all its blocks are.
                            let blocks = orp_transfer::block_summary(&r.session().blocks());
                            let part = (100.0 * blocks.part).min(99.0);
                            let block_states = if blocks.nb > 1 { format!(" ({}/{} blocks complete)", blocks.complete_count, blocks.nb) } else { String::new() };
                            let code = app.get_code_readable();
                            // Alignment with the sender: what share of the covered
                            // transmission has this phone read? That is what
                            // tells how long to film — not the sender's gauge,
                            // which assumes perfect reading.
                            let new_symbols = (received_count - symbols_before as f64).max(0.0);
                            let (pace, alignment) = match &summary {
                                Some(b) if b.sending_throughput.is_some() && b.end_s > b.start_s.max(0.0) => {
                                    let throughput = b.sending_throughput.unwrap();
                                    let sent = throughput * (b.end_s - b.start_s.max(0.0));
                                    let efficiency = (new_symbols / sent.max(1.0)).min(1.0);
                                    (
                                        throughput * efficiency,
                                        format!(
                                            "This video covers the transmission from {} to {} (sender's counter); the phone read ≈ {:.0}% of the transmitted symbols — the sender's “to film” gauge assumes 100%. ",
                                            orp_transfer::clock(b.start_s),
                                            orp_transfer::clock(b.end_s),
                                            100.0 * efficiency
                                        ),
                                    )
                                }
                                Some(b) => (
                                    if filmed > 0.0 { new_symbols / filmed } else { 0.0 },
                                    format!("This video covers the transmission from {} to {} (sender's counter). ", orp_transfer::clock(b.start_s), orp_transfer::clock(b.end_s)),
                                ),
                                None => (if filmed > 0.0 { new_symbols / filmed } else { 0.0 }, String::new()),
                            };
                            if pace > 0.0 {
                                // With SLACK: the next video must contain,
                                // statistically, what the late block is missing.
                                let next = orp_transfer::advised_duration(&r.session().blocks(), pace)
                                    .unwrap_or(blocks.to_receive / pace)
                                    .ceil()
                                    .clamp(5.0, 60.0);
                                app.set_slow_motion_next(next as i32);
                                app.set_receive_info(
                                    format!("Transfer in progress: ≈ {part:.0}% received{block_states} (code {code}). “Film” completes it — the sender must still show this code.").into(),
                                );
                                format!(
                                    "{alignment}Received ≈ {part:.0}% of the file{block_states}, kept. Next: LEAVE the transmission running on the sender \
                                     (it must still show code {code}) — stopping or restarting it changes the code and starts over. \
                                     Then “Film the rest”: ≈ {next:.0} s."
                                )
                            } else {
                                app.set_slow_motion_next(0);
                                format!(
                                    "Received ≈ {part:.0}% of the file{block_states}; nothing new in this video. Is the transmission (code {code}) still running \
                                     on the sender? If it was stopped, restart it: the transfer will start over (new code)."
                                )
                            }
                        }
                    };
                    app.set_slow_motion_message(message.into());
                })
            });
        });
    }

    /// Reads the filmed calibration series: trial by trial, frames read,
    /// useful throughput, recommendation and short code (Test bench tab).
    pub fn read_calibration(path: String) {
        CANCEL.store(false, Ordering::SeqCst);
        with_app(|app| {
            app.set_bench_state("Reading the filmed series…".into());
            app.set_bench_recommendation("".into());
            app.set_bench_code("".into());
        });
        std::thread::spawn(move || {
            let start = Instant::now();
            let mut reader = AdaptiveReader::new();
            let mut measurement = orp_transfer::CalibrationMeasurement::default();
            let mut image = ImageRGBA { width: 0, height: 0, data: Vec::new() };
            let mut last = Instant::now();
            let result = video_android::read_video(&path, |v| {
                if CANCEL.load(Ordering::SeqCst) {
                    return false;
                }
                let t = v.instant_ms / 1000.0;
                if reader.should_analyze(t) {
                    image.width = v.width as usize;
                    image.height = v.height as usize;
                    v.rgba_into(&mut image.data);
                    for r in reader.analyze(t, &image) {
                        if let Some(frame) = r.frame.filter(|t| t.is_new) {
                            measurement.add(&frame.bytes);
                        }
                    }
                }
                if last.elapsed().as_millis() >= 300 {
                    last = Instant::now();
                    let text = format!(
                        "Reading {:.0}% · {} calibration frames read",
                        100.0 * v.instant_ms / v.duration_ms.max(1.0),
                        measurement.total()
                    );
                    let _ = slint::invoke_from_event_loop(move || with_app(|app| app.set_bench_state(text.into())));
                }
                true
            });
            let elapsed = start.elapsed().as_secs_f64();
            let recommendation = measurement.recommendation();
            let lines: Vec<(String, f32, String, bool)> = measurement
                .results()
                .into_iter()
                .map(|r| {
                    let name = if r.trial.columns == 1 {
                        format!("{} ms · 1", r.trial.period)
                    } else {
                        format!("{} ms · {}×{}", r.trial.period, r.trial.columns, r.trial.columns)
                    };
                    let useful = if r.frames_read > 0 { format!("{}/s", engine::readable_size(r.throughput)) } else { "—".into() };
                    let retained = recommendation.as_ref().map(|x| x.trial.id == r.trial.id).unwrap_or(false);
                    (name, r.part as f32, useful, retained)
                })
                .collect();
            let state = match (&result, &recommendation) {
                (Err(e), _) => format!("Reading interrupted: {e}"),
                (Ok(_), None) => "No calibration frame read: was the sending screen in the frame during the series?".to_string(),
                (Ok(i), Some(_)) => format!("{} calibration frames read ({} images, {elapsed:.0} s of processing).", measurement.total(), i.images),
            };
            engine::log(&state);
            let recommendation = recommendation.map(|r| {
                let name = if r.trial.columns == 1 { "1 grid".to_string() } else { format!("{0} × {0}", r.trial.columns) };
                (
                    format!("{} ms · {name} · ≈ {}/s", r.trial.period, engine::readable_size(r.throughput)),
                    orp_transfer::code_calibration(r.trial.period, r.trial.columns),
                )
            });
            let _ = slint::invoke_from_event_loop(move || {
                with_app(|app| {
                    let trials: Vec<CalibrationTrial> = lines
                        .into_iter()
                        .map(|(name, part, useful, retained)| CalibrationTrial { name: name.into(), part, useful: useful.into(), retained })
                        .collect();
                    app.set_bench_trials(slint::ModelRc::new(slint::VecModel::from(trials)));
                    app.set_bench_state(state.into());
                    if let Some((text, code)) = recommendation {
                        app.set_bench_recommendation(text.into());
                        app.set_bench_code(code.into());
                    }
                })
            });
        });
    }

    /// TRANSFER TEST: reads the filmed bench transmission, with a separate
    /// receiver (code accepted automatically: public bench passphrase), and gives a
    /// measurement report in the Test bench › Transfer test tab.
    pub fn read_test(path: String) {
        CANCEL.store(false, Ordering::SeqCst);
        with_app(|app| {
            app.set_test_state("Reading the video…".into());
            app.set_test_measurements(slint::ModelRc::default());
        });
        std::thread::spawn(move || {
            let start = Instant::now();
            let mut reader = AdaptiveReader::new();
            let mut receiver = orp_transfer::Receiver::new();
            let mut image = ImageRGBA { width: 0, height: 0, data: Vec::new() };
            let mut last = Instant::now();
            let mut filmed = 0.0f64;
            let mut max_grids = 0usize;
            let mut t_code: Option<f64> = None;
            let mut file: Option<(orp_transfer::TransferredFile, f64)> = None;
            let mut tracking = orp_transfer::SenderTracker::default();
            let result = video_android::read_video(&path, |v| {
                if CANCEL.load(Ordering::SeqCst) || file.is_some() {
                    return false;
                }
                let t = v.instant_ms / 1000.0;
                filmed = t;
                if t_code.is_none() && reader.code_timed_out(t) {
                    return false;
                }
                if reader.should_analyze(t) {
                    image.width = v.width as usize;
                    image.height = v.height as usize;
                    v.rgba_into(&mut image.data);
                    let results = reader.analyze(t, &image);
                    max_grids = max_grids.max(results.iter().filter(|r| r.location.is_some()).count());
                    for r in results {
                        let Some(frame) = r.frame.filter(|x| x.is_new) else { continue };
                        if let Some(state) = orp_transfer::read_state(&frame.bytes) {
                            tracking.note(t, state);
                        }
                        let mut events = receiver.process(&frame.bytes).unwrap_or_default();
                        let mut i = 0;
                        while i < events.len() {
                            match &events[i] {
                                orp_transfer::Event::CodeRead { .. } => {
                                    t_code.get_or_insert(t);
                                    events.extend(receiver.confirm().unwrap_or_default());
                                }
                                orp_transfer::Event::File(f) => file = Some((f.clone(), t)),
                                _ => {}
                            }
                            i += 1;
                        }
                    }
                }
                if last.elapsed().as_millis() >= 300 {
                    last = Instant::now();
                    let text = format!(
                        "Reading {:.0}% · {} frames accepted",
                        100.0 * v.instant_ms / v.duration_ms.max(1.0),
                        receiver.accepted
                    );
                    let _ = slint::invoke_from_event_loop(move || with_app(|app| app.set_test_state(text.into())));
                }
                true
            });
            let computation = start.elapsed().as_secs_f64();
            let p = reader.progress();
            let s = receiver.session().progress();
            let k = receiver.info.as_ref().map(|i| i.k_total).unwrap_or(0);
            let stream_size = receiver.info.as_ref().map(|i| i.stream_size).unwrap_or(0);
            let decimal = |x: f64, d: usize| format!("{x:.d$}");
            // Useful throughput: file bytes per FILMED second, since the code.
            let (end, bytes) = match &file {
                Some((_, t)) => (*t, stream_size as f64),
                None => (filmed, s.received_symbols as f64 * orp_core::SYMBOL_SIZE as f64),
            };
            let throughput = t_code.map(|t0| bytes / (end - t0).max(0.1)).unwrap_or(0.0);
            let lines: Vec<(String, String)> = vec![
                ("Filmed video".into(), format!("{} s · {} images", decimal(filmed, 1), p.seen_images)),
                ("Images analyzed".into(), format!("{} · {} ms/image", p.analyzed_images, decimal(computation * 1000.0 / p.analyzed_images.max(1) as f64, 0))),
                ("Grids seen".into(), max_grids.to_string()),
                ("Valid frames / pairs".into(), format!("{} / {}", p.valid_count, p.pairs)),
                ("Mixed images (transition)".into(), p.mixed_count.to_string()),
                ("Initialization code".into(), t_code.map(|t| format!("read at {} s", decimal(t, 1))).unwrap_or_else(|| "not read".into())),
                ("Frames accepted".into(), receiver.accepted.to_string()),
                ("Replays · forged · corrupted".into(), format!("{} · {} · {}", s.replays, s.forged, s.corrupted)),
                ("Symbols received".into(), if k > 0 { format!("{} / {} ({:.0}%)", s.received_symbols, k, (100.0 * s.received_symbols as f64 / k as f64).min(100.0)) } else { "—".into() }),
                ("Useful throughput (filmed time)".into(), if throughput > 0.0 { format!("{}/s", engine::readable_size(throughput)) } else { "—".into() }),
                ("Processing time".into(), format!("{} s", decimal(computation, 0))),
            ];
            let mut lines = lines;
            // Alignment on the sender's clock (states read from the video).
            if let Some(b) = tracking.summary(reader.first_grid.unwrap_or(0.0), end) {
                lines.push(("Coverage (sender counter)".into(), format!("{} → {}", orp_transfer::clock(b.start_s), orp_transfer::clock(b.end_s))));
                if let Some(d) = b.sending_throughput {
                    let sent = d * (b.end_s - b.start_s.max(0.0)).max(0.1);
                    let read_items = s.received_symbols as f64;
                    lines.push(("Transmitted symbols read".into(), format!("{:.0}%", (100.0 * read_items / sent).min(100.0))));
                }
            }
            let (text, ok) = match (&file, &result) {
                (Some((f, t)), _) => (
                    format!("Received and verified: {} ({}) at {} s of video.", f.name, engine::readable_size(f.data.len() as f64), decimal(*t, 1)),
                    true,
                ),
                (None, Err(e)) if !e.contains("cancelled") => (format!("Reading interrupted: {e}"), false),
                (None, _) if t_code.is_none() => (orp_transfer::CODE_NOT_READ_MESSAGE.into(), false),
                (None, _) => (format!("Incomplete: {:.0}% of the file received. Film for longer.", if k > 0 { 100.0 * s.received_symbols as f64 / k as f64 } else { 0.0 }), false),
            };
            engine::log(&format!("transfer test: {text}"));
            let _ = slint::invoke_from_event_loop(move || {
                with_app(|app| {
                    let measurements: Vec<MeasurementRow> = lines.into_iter().map(|(l, v)| MeasurementRow { label: l.into(), value: v.into() }).collect();
                    app.set_test_measurements(slint::ModelRc::new(slint::VecModel::from(measurements)));
                    app.set_test_result(text.into());
                    app.set_test_ok(ok);
                    app.set_test_state("".into());
                })
            });
        });
    }

    // ── Live camera ─────────────────────────────────────────────────────────

    thread_local! {
        static CAMERA: RefCell<Option<camera_android::LiveCamera>> = const { RefCell::new(None) };
    }

    pub fn open_camera() {
        if CAMERA.with(|c| c.borrow().is_some()) {
            return;
        }
        // Analysis thread: it takes the ready image and the camera skips the others.
        let (tx, rx) = mpsc::sync_channel::<ImageRGBA>(1);
        let generation = engine::generation();
        std::thread::spawn(move || {
            let mut pipeline = TmPipeline::new(&TmReceiverOptions::default());
            let mut smoother = orp_transfer::FramingSmoother::default();
            let mut stable = 0u32;
            let mut lock_set = false;
            let start = Instant::now();
            let mut view_size = (0usize, 0usize);
            let (mut without_grid, mut poll) = (0u32, false);
            // Error rate: outcome of the last R/P pairs formed (valid frame
            // or not), all grids together.
            let mut pairs: std::collections::VecDeque<bool> = std::collections::VecDeque::new();
            while let Ok(image) = rx.recv() {
                BUSY.store(true, Ordering::SeqCst);
                // Scale change (full resolution ↔ reduced): the
                // tracked geometry is in pixels of the previous image.
                if (image.width, image.height) != view_size {
                    view_size = (image.width, image.height);
                    pipeline.reset();
                }
                let t = start.elapsed().as_secs_f64() * 1000.0;
                let results = pipeline.process(&image, t);
                // Modules too fine at the reduced scale (dense mosaic):
                // full resolution; back to reduced when they become
                // wide again. No effect below 1,920 px wide.
                // A dense mosaic may only be FOUND at full
                // resolution: with no grid seen for 20 images, we probe it,
                // and come back if nothing shows up there either.
                let px = results.iter().filter_map(|r| r.location.map(|l| l.px_per_module)).fold(f64::INFINITY, f64::min);
                let full = FULL_RESOLUTION.load(Ordering::SeqCst);
                let wide_sensor = (camera_android::SIZE.load(Ordering::SeqCst) >> 32) as usize > REDUCED_WIDTH;
                let mut toggle = None;
                if px.is_finite() {
                    without_grid = 0;
                    poll = false;
                    if !full && px < FINE_MODULES {
                        toggle = Some(true);
                    } else if full && px > 4.0 * FINE_MODULES {
                        toggle = Some(false);
                    }
                } else if wide_sensor {
                    without_grid += 1;
                    if without_grid >= if full && !poll { 60 } else { 20 } {
                        without_grid = 0;
                        poll = !full;
                        toggle = Some(!full);
                    }
                }
                if let Some(full) = toggle.filter(|_| wide_sensor) {
                    FULL_RESOLUTION.store(full, Ordering::SeqCst);
                    let px = if px.is_finite() { format!("{px:.1} px modules") } else { "no grid seen".into() };
                    engine::log(&format!("camera: {px}, analyzing at {}.", if full { "full resolution" } else { "half resolution" }));
                }
                let first = results.first();
                let located = results.iter().any(|r| r.location.is_some());
                // R↔P switch image: it does not count for framing.
                let mixed = first
                    .and_then(|r| r.subframe.as_ref())
                    .map(|s| s.type_ == orp_optics::temporal::SubframeKind::Mixed)
                    .unwrap_or(false);
                let raw = first.map(|r| r.advice).unwrap_or("");
                let advice = smoother.track(if located && mixed { None } else { Some(if located { raw } else { "Aim at the screen: keep the three large corner squares in the frame." }) });
                // Outline of each grid, in viewfinder coordinates (portrait).
                let contour = grid_outline(&results, image.width as f64, image.height as f64);
                // Outline reference frame: the ANALYZED image, rotated to portrait. It
                // goes from half to full resolution depending on the mosaic:
                // a fixed reference frame drew the outlines twice too large.
                let guide = match camera_android::ORIENTATION.load(Ordering::SeqCst) {
                    90 | 270 => (image.height as f32, image.width as f32),
                    _ => (image.width as f32, image.height as f32),
                };
                for r in &results {
                    if r.frame.is_some() {
                        pairs.push_back(true);
                    } else if r.invalid_pair {
                        pairs.push_back(false);
                    }
                    if let Some(frame) = r.frame.as_ref().filter(|t| t.is_new) {
                        engine::on_frame_read(&frame.bytes, "live", generation);
                    }
                }
                while pairs.len() > 200 {
                    pairs.pop_front();
                }
                let errors = if pairs.len() >= 10 {
                    let rate = 100.0 * pairs.iter().filter(|ok| !**ok).count() as f64 / pairs.len() as f64;
                    format!("{rate:.1}%")
                } else {
                    "—".to_string()
                };
                // Grid stable for 8 images: white balance and exposure locked.
                stable = if located { stable + 1 } else { 0 };
                let should_lock = !lock_set && stable >= 8;
                lock_set |= should_lock;
                BUSY.store(false, Ordering::SeqCst);
                let _ = slint::invoke_from_event_loop(move || {
                    if should_lock {
                        let ok = CAMERA.with(|c| c.borrow_mut().as_mut().map(|c| c.set_lock(true)).unwrap_or(false));
                        engine::log(if ok { "camera: white balance and exposure locked." } else { "camera: lock refused." });
                        with_app(|app| app.set_capture_lock(ok));
                    }
                    with_app(|app| {
                        let good = located && advice.is_empty();
                        app.set_capture_good(good);
                        app.set_capture_guide_width(guide.0);
                        app.set_capture_guide_height(guide.1);
                        app.set_capture_outline(contour.into());
                        app.set_capture_errors(errors.into());
                        app.set_capture_advice(if good { "Framing OK. Hold still.".to_string() } else { advice }.into());
                    })
                });
            }
        });
        let mut rgba = Vec::new();
        let mut last_seen = Instant::now();
        let mut views = 0u64;
        let callback = Box::new(move |image: &camera_android::CameraImage| {
            views += 1;
            if views == 1 || views % 150 == 0 {
                engine::log(&format!("camera: image {views}, {}×{}, mean luminance {:.0}", image.width, image.height, image.mean_luminance()));
            }
            // Preview (≈ 30 fps is enough for the viewfinder).
            if last_seen.elapsed().as_millis() >= 33 {
                last_seen = Instant::now();
                let (l, h, rgb) = image.preview((image.width / 640).max(3));
                let buffer = slint::SharedPixelBuffer::<slint::Rgb8Pixel>::clone_from_slice(&rgb, l, h);
                let _ = slint::invoke_from_event_loop(move || with_app(|app| app.set_camera_preview(slint::Image::from_rgb8(buffer))));
            }
            // Analysis: only if the thread is free (channel of size 1).
            if BUSY.load(Ordering::SeqCst) {
                return;
            }
            // Beyond 1,920 px (4K sensor), image reduced ×2 as long as the
            // modules are large enough: 4 times fewer pixels to analyze.
            let factor = if image.width > REDUCED_WIDTH && !FULL_RESOLUTION.load(Ordering::SeqCst) { image.width.div_ceil(REDUCED_WIDTH) } else { 1 };
            image.reduced_rgba(factor, &mut rgba);
            let (width, height) = image.reduced_size(factor);
            let image_rgba = ImageRGBA { width, height, data: std::mem::take(&mut rgba) };
            if let Err(mpsc::TrySendError::Full(rendered) | mpsc::TrySendError::Disconnected(rendered)) = tx.try_send(image_rgba) {
                rgba = rendered.data;
            }
        });
        // 4K if the sensor delivers it in YUV: the reading limit goes from
        // 3 × 3 to 7 × 7 grids; 60 fps if possible (17 ms readable live).
        FULL_RESOLUTION.store(false, Ordering::SeqCst);
        match camera_android::LiveCamera::open(3840, 2160, 60, callback) {
            Ok(c) => CAMERA.with(|cam| *cam.borrow_mut() = Some(c)),
            Err(e) => {
                engine::log(&format!("camera: {e}"));
                with_app(|app| app.set_capture_advice(format!("Camera unavailable: {e}").into()));
            }
        }
    }

    pub fn close_camera() {
        CAMERA.with(|c| c.borrow_mut().take());
        with_app(|app| {
            app.set_capture_lock(false);
            app.set_capture_outline("".into());
        });
    }

    /// SVG path of the outlines of the located grids, in the viewfinder frame
    /// (image rotated to portrait according to the sensor orientation).
    fn grid_outline(results: &[orp_optics::tm_receiver::TmImageResult], l: f64, h: f64) -> String {
        use orp_optics::location::apply_h;
        let orientation = camera_android::ORIENTATION.load(Ordering::SeqCst);
        let rotate = |[x, y]: [f64; 2]| -> [f64; 2] {
            match orientation {
                90 => [h - 1.0 - y, x],
                270 => [y, l - 1.0 - x],
                180 => [l - 1.0 - x, h - 1.0 - y],
                _ => [x, y],
            }
        };
        let mut svg_path = String::new();
        for r in results {
            let Some(loc) = &r.location else { continue };
            for (i, (mx, my)) in [(0.0, 0.0), (41.0, 0.0), (41.0, 41.0), (0.0, 41.0)].into_iter().enumerate() {
                let [x, y] = rotate(apply_h(&loc.h, mx, my));
                svg_path.push_str(&format!("{}{x:.0} {y:.0} ", if i == 0 { "M" } else { "L" }));
            }
            svg_path.push_str("Z ");
        }
        svg_path
    }
}

/// Android entry point (NativeActivity: `MainActivity`).
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: slint::android::AndroidApp) {
    android::retain(app.clone());
    slint::android::init(app).expect("initialisation Slint Android");
    launch().expect("interface OptiRelay");
}
