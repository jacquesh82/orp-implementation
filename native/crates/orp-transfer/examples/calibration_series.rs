//! SYNTHETIC calibration series (pipeline check, without screen or camera):
//! RGBA 1920×1080 images at 60 fps on standard output, following the bench
//! timeline (preamble, trials, pauses). To encode with ffmpeg:
//! `cargo run --release -p orp-transfer --example calibration_series | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 60 -i - series.mp4`

use orp_transfer::{batch_images, calibration_frame, CALIBRATION_TRIALS, PAUSE_CALIBRATION};
use std::io::Write;

const L: usize = 1920;
const H: usize = 1080;
const CADENCE: f64 = 60.0;

fn set(background: &mut [u8], image: &orp_optics::render::ImageRGBA) {
    let (ox, oy) = ((L - image.width) / 2, (H - image.height) / 2);
    for y in 0..image.height {
        let s = &image.data[y * image.width * 4..(y + 1) * image.width * 4];
        background[((oy + y) * L + ox) * 4..((oy + y) * L + ox + image.width) * 4].copy_from_slice(s);
    }
}

fn main() {
    let mut output = std::io::BufWriter::new(std::io::stdout().lock());
    let mut background = vec![0u8; L * H * 4];
    let mut write_frame = |image: Option<&orp_optics::render::ImageRGBA>, gray: u8| {
        for p in background.chunks_exact_mut(4) {
            p.copy_from_slice(&[gray, gray, gray, 255]);
        }
        if let Some(i) = image {
            set(&mut background, i);
        }
        output.write_all(&background).unwrap();
    };
    // Preamble: 4 s, one frame looping at 100 ms.
    let (r, p) = batch_images(&[calibration_frame(0, 0)], 1, 7).unwrap();
    for n in 0..(4.0 * CADENCE) as usize {
        let sub = (n as f64 / CADENCE * 1000.0 / 100.0) as usize;
        write_frame(Some(if sub % 2 == 0 { &r } else { &p }), 30);
    }
    for (i, trial) in CALIBRATION_TRIALS.iter().enumerate() {
        if i > 0 {
            for _ in 0..(PAUSE_CALIBRATION as f64 / 1000.0 * CADENCE) as usize {
                write_frame(None, 128);
            }
        }
        let cells = (trial.columns * trial.columns) as usize;
        let images = (trial.duration as f64 / 1000.0 * CADENCE) as usize;
        let mut current_batch = usize::MAX;
        let mut pair = None;
        for n in 0..images {
            let sub = (n as f64 / CADENCE * 1000.0 / trial.period as f64) as usize;
            let batch = sub / 2;
            if batch != current_batch {
                current_batch = batch;
                let frames: Vec<Vec<u8>> = (0..cells).map(|k| calibration_frame(trial.id, (batch * cells + k) as u32)).collect();
                pair = Some(batch_images(&frames, trial.columns as usize, 7).unwrap());
            }
            let (r, p) = pair.as_ref().unwrap();
            write_frame(Some(if sub % 2 == 0 { r } else { p }), 30);
        }
    }
}
