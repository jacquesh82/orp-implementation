//! Replays a real video (decoded by ffmpeg) through the native pipeline:
//! `cargo run --release -p orp-transfer --example replay -- <video.mp4> [--code XXXX-XXXX-XXXX] [--all-images]`
//! (`--all-images` analyzes every image; `--code`: the code the sender
//! showed, typed as on the phone.) The verification code is confirmed
//! automatically.

use orp_optics::render::ImageRGBA;
use orp_transfer::{Event, AdaptiveReader, Receiver};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let video = args.get(1).expect("video path");
    let every_image = args.iter().any(|a| a == "--all-images");
    let code = args.iter().position(|a| a == "--code").and_then(|i| args.get(i + 1)).cloned();
    let output = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video])
        .output()
        .expect("ffprobe");
    let infos = String::from_utf8_lossy(&output.stdout);
    let fields: Vec<&str> = infos.trim().split(',').collect();
    let (l, h): (usize, usize) = (fields[0].parse().unwrap(), fields[1].parse().unwrap());
    let cadence: f64 = {
        let (n, d) = fields[2].split_once('/').unwrap_or((fields[2], "1"));
        n.parse::<f64>().unwrap() / d.parse::<f64>().unwrap()
    };
    let mut ff = Command::new("ffmpeg")
        .args(["-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("ffmpeg");
    let mut stream = ff.stdout.take().unwrap();
    let mut reader = AdaptiveReader::new();
    reader.every_image = every_image;
    let mut receiver = Receiver::new();
    let mut image = ImageRGBA { width: l, height: h, data: vec![0; l * h * 4] };
    let start = Instant::now();
    let mut analysis = std::time::Duration::ZERO;
    let mut n = 0u64;
    let mut finished_at = None;
    let mut code_t = None;
    while stream.read_exact(&mut image.data).is_ok() {
        let t = n as f64 / cadence;
        n += 1;
        if !reader.should_analyze(t) {
            continue;
        }
        let d = Instant::now();
        let results = reader.analyze(t, &image);
        analysis += d.elapsed();
        for r in results {
            let Some(frame) = r.frame.filter(|t| t.is_new) else { continue };
            for e in receiver.process(&frame.bytes).expect("reception") {
                match e {
                    // Codes path: the SAS only comes with the sender's reveal
                    // code (which a recorded video may not contain).
                    Event::CodeRead { sas: None, stream_size, by_passphrase: false, .. } => {
                        code_t = Some(t);
                        println!("code read at {t:.2} s: {stream_size} B, codes path — waiting for the reveal code");
                    }
                    Event::CodeRead { sas: None, stream_size, by_passphrase: true, .. } => {
                        code_t = Some(t);
                        let Some(code) = &code else {
                            println!("code read at {t:.2} s: {stream_size} B, passphrase path — give the sender's code with --code");
                            continue;
                        };
                        let sas = receiver.pair_with_passphrase(code).expect("pairing");
                        println!("verification code {sas} at {t:.2} s — confirmed automatically");
                        for e in receiver.confirm().expect("confirmation") {
                            if let Event::File(f) = e {
                                finished_at = Some(t);
                                println!("FILE {} ({} B, {})", f.name, f.data.len(), f.mime_type);
                            }
                        }
                    }
                    Event::CodeRead { sas: Some(sas), .. } | Event::RevealRead { sas } => {
                        code_t.get_or_insert(t);
                        println!("verification code {sas} at {t:.2} s — confirmed automatically");
                        for e in receiver.confirm().expect("confirmation") {
                            if let Event::File(f) = e {
                                finished_at = Some(t);
                                println!("FILE {} ({} B, {})", f.name, f.data.len(), f.mime_type);
                            }
                        }
                    }
                    Event::File(f) => {
                        finished_at = Some(t);
                        println!("FILE {} ({} B, {}) at {t:.2} s", f.name, f.data.len(), f.mime_type);
                    }
                    Event::Rejected => println!("REJECTED: wrong digest"),
                    Event::NewSending => println!("new sending at {t:.2} s"),
                    Event::WrongCode => println!("WRONG CODE: the frames do not authenticate with --code"),
                    Event::Progress { .. } => {}
                }
            }
        }
    }
    let p = reader.progress();
    let s = receiver.session().progress();
    println!(
        "{} images, {} analyzed ({:.1} ms/image), {} valid, {} pairs, {} mixed; {} frames accepted, {} symbols, replays {}; code at {:?} s, finished at {:?} s; {:.1} s in total",
        p.seen_images,
        p.analyzed_images,
        analysis.as_secs_f64() * 1000.0 / p.analyzed_images.max(1) as f64,
        p.valid_count,
        p.pairs,
        p.mixed_count,
        receiver.accepted,
        s.received_symbols,
        s.replays,
        code_t.map(|t| (t * 100.0).round() / 100.0),
        finished_at.map(|t| (t * 100.0).round() / 100.0),
        start.elapsed().as_secs_f64()
    );
}
