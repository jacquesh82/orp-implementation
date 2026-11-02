//! Decoder alone, seeds following the PATTERN of the interleaved session: per
//! round of 20 seeds (4 symbols × 5 blocks), a block has 4 consecutive seeds;
//! 30 % of the frames kept. Compared with frames kept in slices (videos).
use orp_core::{fountain_symbol, FountainDecoder, Mulberry32};
fn measure(k: usize, keep: impl Fn(u32, &mut Mulberry32) -> bool) -> f64 {
    let mut a = Mulberry32::new(9);
    let sources: Vec<Vec<u8>> = (0..k).map(|_| (0..96).map(|_| (a.next_f64() * 256.0) as u8).collect()).collect();
    let mut d = FountainDecoder::new(k).unwrap();
    let mut n = 0;
    let mut round = 0u32;
    while !d.is_complete() && n < 6 * k {
        let base = 1 + round * 20;
        round += 1;
        if !keep(round, &mut a) {
            continue;
        }
        for i in 0..4 {
            let g = base + i;
            d.receive(g, &fountain_symbol(&sources, k, g).unwrap()).unwrap();
            n += 1;
        }
    }
    n as f64 / k as f64
}
fn main() {
    let k = 1024;
    println!("rounds kept at random, 30 % : {:.2} × K", measure(k, |_, a| a.next_f64() < 0.3));
    println!("all rounds                     : {:.2} × K", measure(k, |_, _| true));
    println!("videos (40 % of the time, 30 %): {:.2} × K", measure(k, |t, a| (t % 180) < 72 && a.next_f64() < 0.3));
}
