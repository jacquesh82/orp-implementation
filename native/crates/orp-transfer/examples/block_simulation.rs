//! How many symbols does it REALLY take to finish a large file?
//! Real sending (ORP session), burst losses (separate videos),
//! real reception. `cargo run --release -p orp-transfer --example block_simulation`
use orp_core::session::{TransmissionOptions, SenderSession, PairingMode};
use orp_core::{Codec, CryptoRust, Mulberry32};
use orp_transfer::{pack, pairing_frame, Event, TransferredFile, Receiver, BENCH_PASSPHRASE};

fn main() {
    let mut random = Mulberry32::new(42);
    let data: Vec<u8> = (0..400_000).map(|_| (random.next_f64() * 256.0) as u8).collect();
    let file = TransferredFile { name: "gros.bin".into(), mime_type: "application/octet-stream".into(), data };
    let mut em = SenderSession::new(Box::new(CryptoRust::new()), TransmissionOptions { codecs: vec![Codec::Color8], pairing: PairingMode::Passphrase, ..Default::default() }).unwrap();
    em.prepare(&pack(&file)).unwrap();
    em.receive_passphrase(BENCH_PASSPHRASE).unwrap();
    em.confirm_sas().unwrap();
    em.calibrate(Some(Codec::Color8)).unwrap();
    let init = pairing_frame(&em.init_code().unwrap()).unwrap();
    em.start(0).unwrap();
    let mut rec = Receiver::new();
    rec.process(&init).unwrap();
    rec.confirm().unwrap();
    let info = rec.info.clone().unwrap();
    println!("k_total {} in {} blocks", info.k_total, info.block_count);
    let mut loss = Mulberry32::new(7);
    let mut per_block: std::collections::BTreeMap<u32, (u32, u32)> = Default::default();
    let mut complete_count = 0;
    let mut sent = 0u64;
    for n in 0..200_000u64 {
        let t = em.next_frame().unwrap().unwrap();
        sent += 1;
        // 60 s videos every ~150 s (6 frames/s); within a video, 30 % read.
        let in_video = (n % 900) < 360;
        if !in_video || loss.next_f64() > 0.30 {
            continue;
        }
        if let Ok(l) = orp_core::read_frame(&t) {
            let e = per_block.entry(l.header.block).or_insert((l.header.k as u32, 0));
            e.1 += l.header.symbol_count as u32;
        }
        for e in rec.process(&t).unwrap() {
            if let Event::File(f) = e {
                for (b, (k, n)) in &per_block {
                    println!("  block {b}: K {k}, {n} symbols received ({:.2} × K)", *n as f64 / *k as f64);
                }
                let p = rec.session().progress();
                println!("FILE after {sent} frames sent; {} symbols received = {:.2} × k_total", p.received_symbols, p.received_symbols as f64 / info.k_total as f64);
                assert_eq!(f, file);
                return;
            }
        }
        let p = rec.session().progress();
        if p.completed_blocks != complete_count {
            complete_count = p.completed_blocks;
            println!("  {complete_count} block(s) complete after {} symbols received ({:.2} × k) — {:?}", p.received_symbols, p.received_symbols as f64 / info.k_total as f64, per_block.values().map(|(k, n)| format!("{:.2}", *n as f64 / *k as f64)).collect::<Vec<_>>());
        }
        if n % 20_000 == 0 && n > 0 {
            let p = rec.session().progress();
            println!("{n} frames sent: {} symbols received ({:.2} × k), complete blocks {}/{}", p.received_symbols, p.received_symbols as f64 / info.k_total as f64, p.completed_blocks, p.block_count);
        }
    }
    let p = rec.session().progress();
    println!("NEVER FINISHED: {} symbols ({:.2} × k), complete blocks {}/{}", p.received_symbols, p.received_symbols as f64 / info.k_total as f64, p.completed_blocks, p.block_count);
}
