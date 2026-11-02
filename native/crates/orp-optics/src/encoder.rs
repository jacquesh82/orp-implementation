//! Optical encoder: ORP frames (bytes) → grid of palette indices, and the
//! calibration test pattern. Bit writing is frozen (docs §9): MSB first, data
//! modules in the order of `data_modules()`, bits per module according to the
//! codec; padding beyond the frame is index 0.

use orp_core::{
    symbol_capacity, build_frame, Codec, FrameHeader, OrpError, Mulberry32, Version,
    FLAG_PAIRING, SYMBOL_SIZE,
};

use crate::grid::{structural_grid, data_modules, GRID_SIZE};
use crate::palettes::{bits_per_module, palette_for};

/// GRID_SIZE² palette indices.
pub type Grid = Vec<u8>;

/// Fixed seed of the v0.1 test pattern.
pub const TEST_PATTERN_SEED: u32 = 0x4f52_5031;

/// Writes a byte stream into the data modules (MSB first).
pub fn write_bytes_to_grid(grid: &mut [u8], bytes: &[u8], codec: Codec) {
    let bits = bits_per_module(codec);
    let mut remaining_bit = 0;
    let mut current_byte = 0u8;
    let mut cursor = 0;
    for &[x, y] in data_modules() {
        let mut index = 0u8;
        for _ in 0..bits {
            if remaining_bit == 0 {
                current_byte = bytes.get(cursor).copied().unwrap_or(0);
                cursor += 1;
                remaining_bit = 8;
            }
            index = (index << 1) | ((current_byte >> (remaining_bit - 1)) & 1);
            remaining_bit -= 1;
        }
        grid[y * GRID_SIZE + x] = index;
    }
}

/// Assembles the complete grid of a data frame.
pub fn encode_frame(
    header: &FrameHeader,
    payload: &[u8],
    tag: Option<&[u8]>,
) -> Result<Grid, OrpError> {
    let raw = build_frame(header, payload, tag)?;
    Ok(encode_raw_frame(&raw, header.codec))
}

/// Encodes an ALREADY built frame (complete bytes, RS parities included).
pub fn encode_raw_frame(raw: &[u8], codec: Codec) -> Grid {
    let mut grid = structural_grid(codec);
    write_bytes_to_grid(&mut grid, raw, codec);
    grid
}

/// Calibration test pattern (§5.3): uniform pseudo-random data over the
/// palette, pilots in order. This is NOT an ORP frame.
pub fn encode_test_pattern(codec: Codec, seed: u32) -> Grid {
    let mut grid = structural_grid(codec);
    let size = palette_for(codec).len() as f64;
    let mut rng = Mulberry32::new(seed);
    for &[x, y] in data_modules() {
        grid[y * GRID_SIZE + x] = (rng.next_f64() * size).floor() as u8;
    }
    grid
}

/// Pairing code (init or response): dedicated frame in COLOR_4, payload
/// framed to a whole number of symbols (1 to 4).
pub fn encode_pairing_code(payload: &[u8]) -> Result<Grid, OrpError> {
    let nb = payload.len().div_ceil(SYMBOL_SIZE).clamp(1, 4);
    let mut framed = vec![0u8; nb * SYMBOL_SIZE];
    let n = payload.len().min(framed.len());
    framed[..n].copy_from_slice(&payload[..n]);
    let header = FrameHeader {
        version: Version {
            major: 0,
            minor: 1,
        },
        codec: Codec::Color4,
        flags: FLAG_PAIRING,
        token: 0,
        block: 0,
        k: 1,
        symbol_count: nb as u8,
        seed: 0,
    };
    encode_frame(&header, &framed, None)
}

/// Prepares a data frame ready to encode: clamps `symbol_count` to the codec
/// capacity (the `symbol_count` of the given header is ignored).
pub fn frame_for_codec(header: &FrameHeader, payload: &[u8]) -> (FrameHeader, Vec<u8>) {
    let max = symbol_capacity(header.codec);
    let nb = max.min(payload.len().div_ceil(SYMBOL_SIZE));
    let mut framed = vec![0u8; nb * SYMBOL_SIZE];
    let n = payload.len().min(framed.len());
    framed[..n].copy_from_slice(&payload[..n]);
    (
        FrameHeader {
            symbol_count: nb as u8,
            ..header.clone()
        },
        framed,
    )
}
