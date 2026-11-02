//! Overhead of the fountain decoder: symbols needed for a block of K.
use orp_core::{fountain_symbol, FountainDecoder, Mulberry32};
fn main() {
    for &k in &[63usize, 256, 834, 1024] {
        let mut a = Mulberry32::new(k as u32);
        let sources: Vec<Vec<u8>> = (0..k).map(|_| (0..96).map(|_| (a.next_f64() * 256.0) as u8).collect()).collect();
        let mut trials = Vec::new();
        for trial in 0..5u32 {
            let mut d = FountainDecoder::new(k).unwrap();
            let mut g = 1 + trial * 1_000_003;
            let mut n = 0;
            while !d.is_complete() {
                let s = fountain_symbol(&sources, k, g).unwrap();
                d.receive(g, &s).unwrap();
                // SCATTERED seeds: 1 in ~3, like a partial reception.
                g += 1 + (a.next_f64() * 5.0) as u32;
                n += 1;
                if n > 4 * k { break; }
            }
            trials.push(n as f64 / k as f64);
        }
        println!("K = {k}: symbols needed / K = {:?}", trials.iter().map(|x| (x * 100.0).round() / 100.0).collect::<Vec<_>>());
    }
}
