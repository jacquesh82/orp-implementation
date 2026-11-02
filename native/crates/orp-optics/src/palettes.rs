//! Nominal palettes of the ORP-C8 codecs (§5.1, D-008) — starting sRGB
//! values, never decoding classes: calibration (OPTI-04) estimates the REAL
//! classes from the test pattern captured by the camera.

use orp_core::Codec;

pub type RgbColor = [u8; 3];

pub const BLACK: RgbColor = [0, 0, 0];
pub const WHITE: RgbColor = [255, 255, 255];

const PALETTE_MONO_2: [RgbColor; 2] = [BLACK, WHITE];
const PALETTE_COLOR_4: [RgbColor; 4] = [
    [0, 0, 0],       // 00 — black
    [255, 255, 255], // 01 — white
    [229, 57, 53],   // 10 — red
    [30, 136, 229],  // 11 — blue
];
const PALETTE_COLOR_8: [RgbColor; 8] = [
    [0, 0, 0],       // 000 — black
    [255, 255, 255], // 001 — white
    [229, 57, 53],   // 010 — red
    [30, 136, 229],  // 011 — blue
    [253, 216, 53],  // 100 — yellow
    [67, 160, 71],   // 101 — green
    [142, 36, 170],  // 110 — magenta
    [0, 172, 193],   // 111 — cyan
];

/// Nominal palette of a codec — the index IS the value of the module bits.
pub fn palette_for(codec: Codec) -> &'static [RgbColor] {
    match codec {
        Codec::Mono2 => &PALETTE_MONO_2,
        Codec::Color4 => &PALETTE_COLOR_4,
        Codec::Color8 => &PALETTE_COLOR_8,
    }
}

/// Bits per data module (§5.5): 1, 2 or 3.
pub fn bits_per_module(codec: Codec) -> usize {
    match codec {
        Codec::Mono2 => 1,
        Codec::Color4 => 2,
        Codec::Color8 => 3,
    }
}
