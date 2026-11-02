//! Renders every screen offscreen, at phone size, to PNG (visual check):
//! `cargo run --example captures -- <dir>`.
//! Slint software renderer: no window, no desktop dependency.

use optirelay::{App, Screen};
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::Rgb8Pixel;
use slint::platform::{Platform, WindowAdapter, WindowEvent};
use slint::ComponentHandle;
use std::rc::Rc;
use std::time::Instant;

struct CapturePlatform {
    window: Rc<MinimalSoftwareWindow>,
    start: Instant,
}

impl Platform for CapturePlatform {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.window.clone())
    }
    fn duration_since_start(&self) -> std::time::Duration {
        self.start.elapsed()
    }
}

const SCALE: f32 = 2.0;
const L: u32 = (390.0 * SCALE) as u32;
const H: u32 = (844.0 * SCALE) as u32;

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "captures".into());
    std::fs::create_dir_all(&dir).unwrap();
    let window = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
    slint::platform::set_platform(Box::new(CapturePlatform { window: window.clone(), start: Instant::now() })).unwrap();
    window.dispatch_event(WindowEvent::ScaleFactorChanged { scale_factor: SCALE });
    window.set_size(slint::PhysicalSize::new(L, H));

    let app = App::new().unwrap();
    app.show().unwrap();
    let states: Vec<(&str, Box<dyn Fn(&App)>)> = vec![
        ("1-receive", Box::new(|a: &App| a.set_current_tab(0))),
        ("1b-receive-continue", Box::new(|a: &App| {
            a.set_receive_mode(1);
            a.set_receive_info("Transfer in progress: ≈ 93% received (4/5 blocks complete) (code 976 188). “Film” completes it — the sender must still show this code.".into());
            let blocks: Vec<optirelay::BlockView> = [(1.0, true), (1.0, true), (0.62, false), (1.0, true), (1.0, true)]
                .into_iter()
                .map(|(part, complete)| optirelay::BlockView { part, complete })
                .collect();
            a.set_block_view(slint::ModelRc::new(slint::VecModel::from(blocks)));
        })),
        ("1c-slow-motion-continue", Box::new(|a: &App| {
            a.set_slow_motion_next(24);
            let blocks: Vec<optirelay::BlockView> = [(1.0, true), (1.0, true), (0.62, false), (1.0, true), (1.0, true)]
                .into_iter()
                .map(|(part, complete)| optirelay::BlockView { part, complete })
                .collect();
            a.set_block_view(slint::ModelRc::new(slint::VecModel::from(blocks)));
            a.set_file_title("4/5 blocks · ≈ 93%".into());
            a.set_receive_info("Transfer in progress: ≈ 93% received (4/5 blocks complete) (code 976 188).".into());
            a.set_slow_motion_step(2);
            a.set_slow_motion_share(1.0);
            a.set_slow_motion_title("Video read".into());
            a.set_slow_motion_message("Received ≈ 33% of the file, kept. Next: LEAVE the transmission running on the sender (it must still show code 976 188) — stopping or restarting it changes the code and starts over. Then “Film the rest”: ≈ 24 s.".into());
            a.set_screen(Screen::SlowMotion);
        })),
        ("1d-back", Box::new(|a: &App| {
            a.set_receive_info("".into());
            a.set_slow_motion_next(0);
            a.set_block_view(slint::ModelRc::default());
            a.set_receive_mode(0);
            a.set_screen(Screen::Home);
        })),
        ("2-send", Box::new(|a: &App| a.set_current_tab(1))),
        ("3-menu", Box::new(|a: &App| {
            a.set_current_tab(0);
            a.set_menu_open(true);
        })),
        ("4-capture", Box::new(|a: &App| {
            a.set_menu_open(false);
            a.set_capture_lock(true);
            a.set_capture_good(true);
            a.set_capture_advice("Framing OK. Hold still.".into());
            // A grid seen slightly at an angle, in the middle of the sensor.
            a.set_capture_outline("M250 620 L850 650 L830 1260 L230 1220 Z ".into());
            a.set_screen(Screen::Capture);
        })),
        ("4b-strong-code", Box::new(|a: &App| {
            let (r, _) = orp_transfer::batch_images(&[orp_transfer::pairing_frame(&[7u8; 65]).unwrap()], 1, 8).unwrap();
            a.set_response_code(slint::Image::from_rgba8(slint::SharedPixelBuffer::clone_from_slice(&r.data, r.width as u32, r.height as u32)));
            a.set_code_has_response(true);
            a.set_screen(Screen::Code);
        })),
        ("5-code", Box::new(|a: &App| a.set_screen(Screen::Code))),
        ("6-slow-motion", Box::new(|a: &App| {
            a.set_receive_mode(1);
            a.set_screen(Screen::SlowMotion);
        })),
        ("7-received", Box::new(|a: &App| a.set_screen(Screen::Received))),
        ("8-bench", Box::new(|a: &App| {
            a.set_screen(Screen::Home);
            a.set_current_tab(2);
        })),
        ("9-test", Box::new(|a: &App| a.set_bench_tab(1))),
        ("10-log", Box::new(|a: &App| {
            let lines: Vec<slint::SharedString> = vec![
                "00:01:08  transfer test: Initialization code not read in the first seconds: reading stopped.".into(),
                "00:00:02  OptiRelay native started.".into(),
            ];
            a.set_log_lines(slint::ModelRc::new(slint::VecModel::from(lines)));
            a.set_screen(Screen::Log);
        })),
    ];
    let mut buffer = vec![Rgb8Pixel::default(); (L * H) as usize];
    for (name, set) in &states {
        set(&app);
        slint::platform::update_timers_and_animations();
        window.request_redraw();
        window.draw_if_needed(|renderer| {
            renderer.render(&mut buffer, L as usize);
        });
        let bytes: Vec<u8> = buffer.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
        image::save_buffer(format!("{dir}/{name}.png"), &bytes, L, H, image::ExtendedColorType::Rgb8).unwrap();
    }
}
