//! Renders every screen offscreen, at phone size, to PNG (visual check):
//! `cargo run --example captures -- <dir>`.
//! Slint software renderer: no window, no desktop dependency.

use optirelay::{App, CodeStep, Screen};
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
    let digits = |a: &App, sas: &str| {
        let d: Vec<slint::SharedString> = sas.chars().map(|c| c.to_string().into()).collect();
        a.set_code_digits(slint::ModelRc::new(slint::VecModel::from(d)));
        a.set_code_readable(orp_transfer::shown_sas(sas).into());
    };
    let grid = |columns: usize| {
        let (r, _) = orp_transfer::batch_images(&[orp_transfer::pairing_frame(&[7u8; 65]).unwrap()], columns, 17).unwrap();
        slint::Image::from_rgba8(slint::SharedPixelBuffer::clone_from_slice(&r.data, r.width as u32, r.height as u32))
    };
    let states: Vec<(&str, Box<dyn Fn(&App)>)> = vec![
        ("1-home", Box::new(|_: &App| {})),
        ("2-capture", Box::new(|a: &App| {
            a.set_capture_lock(true);
            a.set_capture_good(true);
            a.set_capture_advice("Framing OK. Hold still.".into());
            a.set_capture_title("Receiving".into());
            a.set_capture_part(0.42);
            a.set_capture_detail("412 / 980 SYMBOLS".into());
            a.set_capture_frames("206".into());
            a.set_capture_throughput("128 B/s".into());
            a.set_capture_mode("TM4".into());
            a.set_capture_errors("3.1%".into());
            a.set_code_readable("976 188".into());
            // A grid seen slightly at an angle, in the middle of the sensor.
            a.set_capture_outline("M250 620 L850 650 L830 1260 L230 1220 Z ".into());
            a.set_screen(Screen::Capture);
        })),
        ("3-code-type", Box::new(|a: &App| {
            a.set_code_readable("".into());
            a.set_code_step(CodeStep::TypeCode);
            a.set_code_note("11 B announced. Frames already read are kept.".into());
            a.set_screen(Screen::Code);
        })),
        ("3b-code-wrong", Box::new(|a: &App| {
            a.set_code_error("The frames do not open with this code: it is not the sender's. Type it again.".into());
        })),
        ("4-code-compare", Box::new(move |a: &App| {
            a.set_code_error("".into());
            digits(a, "976188");
            a.set_code_step(CodeStep::Compare);
        })),
        ("4b-code-response", Box::new(move |a: &App| {
            a.set_response_code(grid(1));
            a.set_code_step(CodeStep::Response);
        })),
        ("5-received", Box::new(|a: &App| {
            a.set_received_name("message.txt".into());
            a.set_received_size("11 B".into());
            a.set_received_mode("TM4".into());
            a.set_received_text_preview("“Hello world”".into());
            a.set_screen(Screen::Received);
        })),
        ("6-send", Box::new(|a: &App| {
            a.set_send_name("photo.jpg".into());
            a.set_send_detail("59.7 KB / ~7 min ON SCREEN".into());
            a.set_send_chosen(true);
            a.set_screen(Screen::Send);
        })),
        ("7-sending", Box::new(move |a: &App| {
            a.set_sending_grid(grid(1));
            a.set_sending_code(orp_transfer::shown_code(&orp_transfer::random_code()).into());
            a.set_sending_sas("976 188".into());
            a.set_sending_hud("TM4 / 250 MS / FRAME 12 / 18 S / 59.8 KB STREAM".into());
            a.set_screen(Screen::Sending);
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
