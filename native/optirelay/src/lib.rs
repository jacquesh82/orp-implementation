//! OptiRelay native: two functions, Receive and Send, with the security of
//! OptiRelay Studio built in (one-time code typed on the receiver, 6-digit
//! verification code). Slint interface and the ORP protocol in Rust
//! (orp-core, orp-optics, orp-transfer); image source: the live camera
//! (NDK Camera2).

slint::include_modules!();

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod camera_android;
mod engine;
mod send;

use slint::ComponentHandle;
use std::cell::RefCell;

thread_local! {
    /// The window, for callbacks from the threads and from the Android host.
    static APP: RefCell<Option<slint::Weak<App>>> = const { RefCell::new(None) };
}

pub(crate) fn with_app(f: impl FnOnce(&App)) {
    APP.with(|a| {
        if let Some(app) = a.borrow().as_ref().and_then(|w| w.upgrade()) {
            f(&app);
        }
    });
}

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
    app.on_submit_code(|typed| with_app(|app| engine::submit_code(app, &typed)));
    app.on_format_code(|typed| orp_transfer::code_as_typed(&typed).into());
    app.on_confirm_code(|| with_app(engine::confirm_code));
    app.on_retype_code(|| with_app(engine::retype_code));
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
        with_app(|app| app.set_received_message(message.into()));
    });
    app.on_share(|| {
        engine::RECEIVED.with(|r| {
            if let Some(f) = r.borrow().as_ref() {
                #[cfg(target_os = "android")]
                if !android::share(&f.name, &f.mime_type, &f.data) {
                    with_app(|app| app.set_received_message("Android refused to share.".into()));
                }
                #[cfg(not(target_os = "android"))]
                with_app(|app| app.set_received_message(format!("Sharing “{}”: Android only.", f.name).into()));
            }
        })
    });
    app.on_delete(|| {
        engine::RECEIVED.with(|r| *r.borrow_mut() = None);
        with_app(|app| app.set_screen(Screen::Home));
    });
    app.on_choose_file(|| {
        #[cfg(target_os = "android")]
        android::choose_file();
        #[cfg(not(target_os = "android"))]
        {
            // Desktop: OPTIRELAY_FILE, otherwise a short text.
            let f = std::env::var("OPTIRELAY_FILE")
                .ok()
                .and_then(|c| {
                    let data = std::fs::read(&c).ok()?;
                    let name = std::path::Path::new(&c).file_name()?.to_string_lossy().into_owned();
                    Some(orp_transfer::TransferredFile { name, mime_type: "application/octet-stream".into(), data })
                })
                .unwrap_or_else(|| orp_transfer::TransferredFile {
                    name: "message.txt".into(),
                    mime_type: "text/plain;charset=utf-8".into(),
                    data: b"Hello world, from OptiRelay native.".to_vec(),
                });
            send::file_chosen(f);
        }
    });
    app.on_send_mode_changed(|| with_app(send::show_settings));
    app.on_start_sending(|| with_app(send::start));
    send::show_settings(&app);
    app.on_screen_change(|screen| {
        thread_local! {
            static PREVIOUS: std::cell::Cell<Screen> = const { std::cell::Cell::new(Screen::Home) };
        }
        let previous = PREVIOUS.with(|p| p.replace(screen));
        if screen != Screen::Sending {
            send::stop();
        }
        if screen == Screen::Home && matches!(previous, Screen::Capture | Screen::Code) {
            // Back from a reception screen: the reception is forgotten.
            with_app(engine::abandon);
        } else if screen == Screen::Capture && previous == Screen::Home {
            // A new reading after a received file: start from scratch.
            with_app(engine::restart_if_finished);
        }
        // The camera stays open on the Code screen: the data frames read
        // while the code is typed are kept.
        #[cfg(target_os = "android")]
        if screen == Screen::Capture {
            camera::open_camera();
        } else if screen != Screen::Code {
            camera::close_camera();
        }
    });
    engine::log("OptiRelay native started.");
    #[cfg(target_os = "android")]
    android::request_camera();
    app.run()
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
mod camera {
    //! The live camera: preview, grid reading, framing advice.

    use super::*;
    use orp_optics::pipeline::TmPipeline;
    use orp_optics::render::ImageRGBA;
    use orp_optics::tm_receiver::TmReceiverOptions;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    /// The live analysis thread is busy: the camera converts nothing.
    static BUSY: AtomicBool = AtomicBool::new(false);
    /// Analysis at the sensor's full resolution (dense grid) rather than reduced.
    static FULL_RESOLUTION: AtomicBool = AtomicBool::new(false);
    /// Ordinary analysis width; beyond it, the image is reduced.
    const REDUCED_WIDTH: usize = 1920;
    /// Below this (analyzed pixels per module), switch to full resolution.
    const FINE_MODULES: f64 = 8.0;

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
                        engine::on_frame_read(&frame.bytes, generation);
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
