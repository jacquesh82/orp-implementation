//! mulberry32 pseudo-random generator (fountain.ts) — frozen, same sequence
//! as the TS. JavaScript's `| 0`, `Math.imul` and `>>> 0` are all modulo-2³²
//! arithmetic: u32 with wrapping overflow.

#[derive(Debug, Clone)]
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Next draw in [0, 1), identical to `mulberry32(seed)()` in TS.
    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let a = self.state;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

/// Source of random bytes injected into `CryptoRust`.
pub trait RandomSource {
    fn fill(&mut self, buffer: &mut [u8]);
}

/// The system's cryptographic randomness (getrandom).
pub struct SystemRandom;

impl RandomSource for SystemRandom {
    fn fill(&mut self, buffer: &mut [u8]) {
        getrandom::getrandom(buffer).expect("system randomness unavailable");
    }
}

/// REPRODUCIBLE, NON-cryptographic stream — tests and vectors only:
/// byte = ⌊draw × 256⌋, like `CryptoDeterministe` in
/// native/vectors/generate-core.ts.
pub struct MulberryRandom(Mulberry32);

impl MulberryRandom {
    pub fn new(seed: u32) -> Self {
        Self(Mulberry32::new(seed))
    }
}

impl RandomSource for MulberryRandom {
    fn fill(&mut self, buffer: &mut [u8]) {
        for o in buffer {
            *o = (self.0.next_f64() * 256.0) as u8;
        }
    }
}
