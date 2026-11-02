//! Image-by-image diagnostic of a video excerpt:
//! `cargo run --release -p orp-transfer --example diag -- <video> <start s> <duration s>`
use orp_optics::pipeline::TmPipeline;
use orp_optics::tm_receiver::TmReceiverOptions;
use orp_optics::render::ImageRGBA;
use std::io::Read;
use std::process::{Command, Stdio};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (video, start, duration) = (&a[1], &a[2], &a[3]);
    let mut ff = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", start, "-i", video, "-t", duration, "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stream = ff.stdout.take().unwrap();
    let mut pipeline = TmPipeline::new(&TmReceiverOptions { averaging: true, ..TmReceiverOptions::default() });
    let mut image = ImageRGBA { width: 1920, height: 1080, data: vec![0; 1920 * 1080 * 4] };
    let mut n = 0u32;
    let (mut valid_count, mut total_grids) = (0, 0);
    while stream.read_exact(&mut image.data).is_ok() {
        let t = n as f64 * 1000.0 / 240.0;
        n += 1;
        let all = pipeline.process(&image, t);
        let locs: Vec<_> = all.iter().filter_map(|r| r.location.as_ref()).collect();
        total_grids += locs.len();
        valid_count += all.iter().filter(|r| r.frame.is_some()).count();
        if n % 24 == 0 {
            let types: Vec<String> = all.iter().map(|r| r.subframe.as_ref().map(|s| format!("{:?}", s.type_)).unwrap_or("-".into())).collect();
            let px: Vec<String> = locs.iter().map(|l| format!("{:.1}", l.px_per_module)).collect();
            println!("{:.2} s: {} grids, px/module {:?}, types {:?}, advice \"{}\"", t / 1000.0, locs.len(), px, types, all.first().map(|r| r.advice).unwrap_or(""));
        }
    }
    println!("{n} images, {:.1} grids/image on average, {valid_count} valid frames", total_grids as f64 / n.max(1) as f64);
}
