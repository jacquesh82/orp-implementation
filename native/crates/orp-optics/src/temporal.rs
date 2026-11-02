//! TM4 / TM8 — differential temporal modulation (annex 10 bis of the ORP v0.1
//! protocol, REC-05 bench).
//!
//! Each frame is displayed as TWO alternating subframes:
//!   R (reference): structure + data and pilot areas in mid GRAY;
//!   P (payload)  : identical structure + each data module carries
//!                  gray ± A on each RGB channel (a "direction").
//! The receiver decodes the DIFFERENCE P − R per module.
//!
//!   TM8 — 3 bits/module: r = b2, g = b1, b = b0 (the 8 vertices of the cube).
//!   TM4 — 2 bits/module: 4 EVEN-PARITY vertices of the cube (tetrahedron),
//!         soft decision (maximum likelihood) — the fallback mode.
//!
//! Receiving pipeline: framing (homography, each subframe located
//! separately) → per-subframe photometry (black of the markers, white of the
//! quiet zone) → 3×3 color matrix estimated on the 16 pilots and inverted →
//! local gain (R gray at the module) → decision + confidence → classification
//! of subframes as R / P / MIXED (rolling shutter).
//!
//! The TS `Float32Array`s (data, pilots, soft values) are `Vec<f32>`:
//! computed in f64, stored rounded to f32, as in JS.

use std::sync::LazyLock;

use orp_core::{Codec, Mulberry32};

use crate::decoder::{sample, MeanRgb};
use crate::grid::{
    structural_grid, data_modules, role_of, ModuleRole, MARKERS, GRID_SIZE,
};
use crate::js;
use crate::location::{apply_h, locate, Location};
use crate::palettes::RgbColor;
use crate::render::{render, ImageRGBA, RenderOptions};
use crate::OpticsError;

/// Modulation amplitude around the gray (sRGB levels).
pub const AMPLITUDE_TM: u8 = 64;
const TM_GRAY: u8 = 128;
const N: usize = GRID_SIZE;

const fn direction(d: usize) -> RgbColor {
    const fn v(bit: usize) -> u8 {
        if bit != 0 {
            TM_GRAY + AMPLITUDE_TM
        } else {
            TM_GRAY - AMPLITUDE_TM
        }
    }
    [v((d >> 2) & 1), v((d >> 1) & 1), v(d & 1)]
}

/// TM palette: 0 black, 1 white (structure), 2 gray (R), 3..10 = directions.
pub const PALETTE_TM: [RgbColor; 11] = [
    [0, 0, 0],
    [255, 255, 255],
    [TM_GRAY, TM_GRAY, TM_GRAY],
    direction(0),
    direction(1),
    direction(2),
    direction(3),
    direction(4),
    direction(5),
    direction(6),
    direction(7),
];

const GRAY: u8 = 2; // palette index of the mid gray
const DIRECTION_BASE: u8 = 3; // first index of the 8 directions

/// Center (module indices) of the 5×5 alignment pattern — symmetric of MARKERS.
pub const TM_ALIGNMENT: [usize; 2] = [N - 4, N - 4];

pub fn in_tm_alignment(x: usize, y: usize) -> bool {
    x.abs_diff(TM_ALIGNMENT[0]) <= 2 && y.abs_diff(TM_ALIGNMENT[1]) <= 2
}

static TM_DATA_MODULES: LazyLock<Vec<[usize; 2]>> = LazyLock::new(|| {
    data_modules()
        .iter()
        .copied()
        .filter(|&[x, y]| !in_tm_alignment(x, y))
        .collect()
});

/// TM data modules: those of the v0.1 grid minus the alignment pattern (1398).
pub fn tm_data_modules() -> &'static [[usize; 2]] {
    &TM_DATA_MODULES
}

/// Scrambling mask (XOR) of the TM bytes — fixed sequence, `mulberry32(0x544d5041)`.
static TM_MASK: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let mut rng = Mulberry32::new(0x544d_5041);
    (0..(TM_DATA_MODULES.len() * 3).div_ceil(8))
        .map(|_| (rng.next_f64() * 256.0).floor() as u8)
        .collect()
});

/// The scrambling mask (diagnostics, vectors).
pub fn tm_mask() -> &'static [u8] {
    &TM_MASK
}

/// Pilots in order: [x, y, direction 0..7].
static TM_PILOTS: LazyLock<Vec<[usize; 3]>> = LazyLock::new(|| {
    let mut list = Vec::with_capacity(16);
    for y in 0..N {
        for x in 0..N {
            if role_of(x, y) != ModuleRole::Pilot {
                continue;
            }
            let rank = if x == N - 1 { y - 8 } else { x - 8 };
            list.push([x, y, rank & 7]);
        }
    }
    list
});

/// Signs (±1) sent by a direction on each channel.
fn signs(d: usize) -> [f64; 3] {
    let s = |b: usize| if b & 1 != 0 { 1.0 } else { -1.0 };
    [s(d >> 2), s(d >> 1), s(d)]
}

/// Bits per module: TM4 (frame codec COLOR_4) = 2, TM8 (COLOR_8) = 3.
pub fn bits_tm(codec: Codec) -> Result<usize, OpticsError> {
    match codec {
        Codec::Color4 => Ok(2),
        Codec::Color8 => Ok(3),
        Codec::Mono2 => Err(OpticsError::Invalid(
            "TM: only TM4 (COLOR_4) and TM8 (COLOR_8) exist".into(),
        )),
    }
}

pub fn tm_name(codec: Codec) -> Result<&'static str, OpticsError> {
    Ok(if bits_tm(codec)? == 2 { "TM4" } else { "TM8" })
}

/// Bytes a pair of subframes can carry.
pub fn tm_capacity(codec: Codec) -> Result<usize, OpticsError> {
    Ok((TM_DATA_MODULES.len() * bits_tm(codec)?) / 8)
}

/// TM4: 2-bit value → even-parity vertex (r, g, b).
const TM4_WORDS: [[u8; 3]; 4] = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];

/// TM palette index of a direction (r = b2, g = b1, b = b0).
pub fn index_direction(b2: u8, b1: u8, b0: u8) -> u8 {
    DIRECTION_BASE + ((b2 & 1) << 2) + ((b1 & 1) << 1) + (b0 & 1)
}

fn direction_of(value: u8, bits: usize) -> u8 {
    if bits == 3 {
        return index_direction(value >> 2, value >> 1, value);
    }
    let [r, g, b] = TM4_WORDS[(value & 3) as usize];
    index_direction(r, g, b)
}

/// R subframe (reference): structure + alignment, data and pilots in gray.
pub fn reference_subframe(raw: &[u8], codec: Codec) -> Result<Vec<u8>, OpticsError> {
    tm_frame(raw, codec, false)
}

/// P subframe (payload): each module carries its direction, the pilots sweep the 8 directions.
pub fn payload_subframe(raw: &[u8], codec: Codec) -> Result<Vec<u8>, OpticsError> {
    tm_frame(raw, codec, true)
}

fn tm_frame(raw: &[u8], codec: Codec, payload: bool) -> Result<Vec<u8>, OpticsError> {
    let bits = bits_tm(codec)?;
    let capacity = tm_capacity(codec)?;
    if raw.len() > capacity {
        return Err(OpticsError::Invalid(format!(
            "TM: frame of {} bytes > {} capacity of {}",
            raw.len(),
            tm_name(codec)?,
            capacity
        )));
    }
    // Structure identical to the static grid; pilots, alignment and data rewritten.
    let mut g = structural_grid(codec);
    for &[x, y, dir] in TM_PILOTS.iter() {
        g[y * N + x] = if payload {
            DIRECTION_BASE + dir as u8
        } else {
            GRAY
        };
    }
    for &[x, y] in data_modules() {
        let i = y * N + x;
        g[i] = if in_tm_alignment(x, y) {
            let ring = x
                .abs_diff(TM_ALIGNMENT[0])
                .max(y.abs_diff(TM_ALIGNMENT[1]));
            if ring == 1 {
                1
            } else {
                0
            } // black ring, white ring, black center
        } else {
            GRAY
        };
    }
    if !payload {
        return Ok(g);
    }
    // Bytes → modules (MSB first, order of TM_DATA_MODULES), SCRAMBLED
    // by the fixed pseudo-random mask (XOR).
    let mask = &*TM_MASK;
    let mut remaining_bit = 0;
    let mut current_byte = 0u8;
    let mut cursor = 0;
    for &[x, y] in TM_DATA_MODULES.iter() {
        let mut value = 0u8;
        for _ in 0..bits {
            if remaining_bit == 0 {
                current_byte = raw.get(cursor).copied().unwrap_or(0) ^ mask[cursor];
                cursor += 1;
                remaining_bit = 8;
            }
            value = (value << 1) | ((current_byte >> (remaining_bit - 1)) & 1);
            remaining_bit -= 1;
        }
        g[y * N + x] = direction_of(value, bits);
    }
    Ok(g)
}

/// The two subframes rendered as screen images (TM palette).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPair {
    pub reference: ImageRGBA,
    pub payload: ImageRGBA,
}

/// Renders BOTH subframes (TS default: 12 px per module, quiet zone 2).
pub fn render_tm_pair(
    raw: &[u8],
    codec: Codec,
    options: &RenderOptions,
) -> Result<RenderedPair, OpticsError> {
    Ok(RenderedPair {
        reference: render(&reference_subframe(raw, codec)?, &PALETTE_TM, options),
        payload: render(&payload_subframe(raw, codec)?, &PALETTE_TM, options),
    })
}

/// TM test pattern: deterministic pseudo-random data (fixed seed 0x4f525031
/// by default). Renders (reference, payload).
pub fn tm_test_pattern(codec: Codec, seed: u32) -> Result<(Vec<u8>, Vec<u8>), OpticsError> {
    let mut rng = Mulberry32::new(seed);
    let bytes: Vec<u8> = (0..tm_capacity(codec)?)
        .map(|_| (rng.next_f64() * 256.0).floor() as u8)
        .collect();
    Ok((
        reference_subframe(&bytes, codec)?,
        payload_subframe(&bytes, codec)?,
    ))
}

// ── Receiving ─────────────────────────────────────────────────────────────

/// Locates a TM subframe. If the alignment pattern is not found but a
/// previous location had it, and the markers have barely moved, its
/// perspective is kept.
pub fn locate_tm(image: &ImageRGBA, previous: Option<&Location>) -> Option<Location> {
    let loc = locate(image, Some(TM_ALIGNMENT), previous)?;
    if let (None, Some(prec)) = (loc.alignment, previous) {
        if prec.alignment.is_some() {
            let mut displacement = 0f64;
            for i in 0..3 {
                displacement = displacement.max(js::hypot(
                    loc.markers[i][0] - prec.markers[i][0],
                    loc.markers[i][1] - prec.markers[i][1],
                ));
            }
            if displacement < 0.5 * loc.px_per_module {
                return Some(Location {
                    h: prec.h,
                    alignment: prec.alignment,
                    perspective_gap: prec.perspective_gap,
                    ..loc
                });
            }
        }
    }
    Some(loc)
}

pub type RGB = [f64; 3];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TmPhotometry {
    /// Captured level of the structure black, per channel.
    pub black: RGB,
    /// Captured level of the structure white, per channel.
    pub white: RGB,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubframeKind {
    /// Gray reference.
    R,
    /// Colored payload.
    P,
    /// Switch caught in the middle of the readout (rolling shutter).
    Mixed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmSubframe {
    pub location: Location,
    pub type_: SubframeKind,
    /// Median chromatic activity of the blocks (normalized levels 0..255).
    pub activity: f64,
    /// Fraction of colored data blocks (0..1).
    pub colored_fraction: f64,
    /// Fraction of saturated data modules (one channel ≥ 250 raw).
    pub saturation: f64,
    pub photometry: TmPhotometry,
    /// Normalized RGB (black → 0, white → 255) per module of TM_DATA_MODULES.
    pub data: Vec<f32>,
    /// Normalized RGB of the 16 pilots.
    pub pilots: Vec<f32>,
}

const ACTIVITY_THRESHOLD: f64 = 14.0; // normalized levels: R ≈ 2-6 (noise), P ≈ 40-70

/// Samples a module at its center, with a spot of `radius_modules` modules at
/// the LOCAL scale (perspective). Module coordinates may fall outside the grid.
fn sample_module(
    image: &ImageRGBA,
    loc: &Location,
    x: f64,
    y: f64,
    radius_modules: f64,
) -> MeanRgb {
    let [px, py] = apply_h(&loc.h, x + 0.5, y + 0.5);
    let [qx, qy] = apply_h(&loc.h, x + 1.5, y + 0.5);
    let scale = js::hypot(qx - px, qy - py);
    sample(image, px, py, 1f64.max(radius_modules * scale))
}

fn measure_photometry(image: &ImageRGBA, loc: &Location) -> TmPhotometry {
    let mut blacks: Vec<RGB> = Vec::with_capacity(3);
    for [mx, my] in MARKERS {
        let c = sample_module(image, loc, mx as f64, my as f64, 0.8); // black 3×3 core
        blacks.push([c.r, c.g, c.b]);
    }
    // White: quiet zone (2 modules around the grid), failing that the inner
    // white ring of the markers.
    let mut whites: Vec<RGB> = Vec::with_capacity(44);
    let inside = |x: f64, y: f64| {
        let [px, py] = apply_h(&loc.h, x, y);
        let margin = loc.px_per_module;
        px > margin
            && py > margin
            && px < image.width as f64 - margin
            && py < image.height as f64 - margin
    };
    let n = N as f64;
    let mut k = 0usize;
    while k < N {
        let kf = k as f64;
        for [x, y] in [[-1.5, kf], [n + 0.5, kf], [kf, -1.5], [kf, n + 0.5]] {
            if !inside(x + 0.5, y + 0.5) {
                continue;
            }
            let c = sample_module(image, loc, x, y, 0.3);
            whites.push([c.r, c.g, c.b]);
        }
        k += 4;
    }
    if whites.len() < 8 {
        for [mx, my] in MARKERS {
            for [dx, dy] in [[-2.0, 0.0], [2.0, 0.0], [0.0, -2.0], [0.0, 2.0]] {
                let c = sample_module(image, loc, mx as f64 + dx, my as f64 + dy, 0.25);
                whites.push([c.r, c.g, c.b]);
            }
        }
    }
    let per_channel =
        |list: &[RGB], c: usize| js::median(&list.iter().map(|v| v[c]).collect::<Vec<_>>());
    TmPhotometry {
        black: [
            per_channel(&blacks, 0),
            per_channel(&blacks, 1),
            per_channel(&blacks, 2),
        ],
        white: [
            per_channel(&whites, 0),
            per_channel(&whites, 1),
            per_channel(&whites, 2),
        ],
    }
}

/// Samples, normalizes and CLASSIFIES a captured subframe.
pub fn analyze_subframe(image: &ImageRGBA, loc: &Location) -> TmSubframe {
    let photometry = measure_photometry(image, loc);
    let scale: [f64; 3] =
        std::array::from_fn(|c| 255.0 / 16f64.max(photometry.white[c] - photometry.black[c]));
    let normalize = |v: f64, c: usize| ((v - photometry.black[c]) * scale[c]) as f32;

    let modules = tm_data_modules();
    let mut data = vec![0f32; modules.len() * 3];
    let mut saturated = 0usize;
    for (m, &[x, y]) in modules.iter().enumerate() {
        let c = sample_module(image, loc, x as f64, y as f64, 0.3);
        if c.r >= 250.0 || c.g >= 250.0 || c.b >= 250.0 {
            saturated += 1;
        }
        data[m * 3] = normalize(c.r, 0);
        data[m * 3 + 1] = normalize(c.g, 1);
        data[m * 3 + 2] = normalize(c.b, 2);
    }
    let tm_pilots = &*TM_PILOTS;
    let mut pilots = vec![0f32; tm_pilots.len() * 3];
    for (i, &[x, y, _]) in tm_pilots.iter().enumerate() {
        let c = sample_module(image, loc, x as f64, y as f64, 0.3);
        pilots[i * 3] = normalize(c.r, 0);
        pilots[i * 3 + 1] = normalize(c.g, 1);
        pilots[i * 3 + 2] = normalize(c.b, 2);
    }

    // Classification: amplitude of the PILOTS (correlation Σ v·σ / 48 ≈ A·gain
    // in P, ≈ 0 in R), then by 4×4 blocks of the grid (MIXED if only some
    // blocks are colored).
    let mut pilot_amplitude = 0f64;
    let term_count = (tm_pilots.len() * 3) as f64;
    for (i, &[_, _, d]) in tm_pilots.iter().enumerate() {
        let s = signs(d);
        for c in 0..3 {
            pilot_amplitude += (pilots[i * 3 + c] as f64 * s[c]) / term_count;
        }
    }
    let mut blocks: Vec<[Vec<f64>; 3]> = (0..16)
        .map(|_| [Vec::new(), Vec::new(), Vec::new()])
        .collect();
    for (m, &[x, y]) in modules.iter().enumerate() {
        let block = ((y * 4) / N) * 4 + (x * 4) / N;
        for c in 0..3 {
            blocks[block][c].push(data[m * 3 + c] as f64);
        }
    }
    let mut activities: Vec<f64> = Vec::with_capacity(16);
    for block in &blocks {
        if block[0].len() < 16 {
            continue;
        }
        let mut sum = 0.0;
        for channel in block {
            let med = js::median(channel);
            sum += channel.iter().fold(0.0, |a, v| a + (v - med).abs()) / channel.len() as f64;
        }
        activities.push(sum / 3.0);
    }
    // Threshold of a colored block: relative to the pilot amplitude if the
    // subframe looks like P; otherwise relative to the quietest block (the noise).
    let similar_p = pilot_amplitude >= ACTIVITY_THRESHOLD;
    let quietest = js::min(activities.iter().copied());
    let block_threshold = if similar_p {
        0.45 * pilot_amplitude
    } else {
        ACTIVITY_THRESHOLD.max(2.0 * quietest)
    };
    let colored = activities.iter().filter(|&&a| a > block_threshold).count();
    let type_ = if similar_p && colored == activities.len() {
        SubframeKind::P
    } else if !similar_p && colored == 0 {
        SubframeKind::R
    } else {
        SubframeKind::Mixed
    };
    TmSubframe {
        location: *loc,
        type_,
        activity: js::median(&activities),
        colored_fraction: if activities.is_empty() {
            0.0
        } else {
            colored as f64 / activities.len() as f64
        },
        saturation: saturated as f64 / modules.len() as f64,
        photometry,
        data,
        pilots,
    }
}

/// Mean of several captures of the SAME subframe: data and pilots averaged,
/// the rest taken from the last one. Noise drops as √n.
pub fn average_subframes(list: &[&TmSubframe]) -> TmSubframe {
    let last = list[list.len() - 1];
    if list.len() == 1 {
        return last.clone();
    }
    let mut data = vec![0f32; last.data.len()];
    let mut pilots = vec![0f32; last.pilots.len()];
    for s in list {
        for (d, &v) in data.iter_mut().zip(&s.data) {
            *d = (*d as f64 + v as f64) as f32;
        }
        for (d, &v) in pilots.iter_mut().zip(&s.pilots) {
            *d = (*d as f64 + v as f64) as f32;
        }
    }
    let n = list.len() as f64;
    for d in data.iter_mut().chain(pilots.iter_mut()) {
        *d = (*d as f64 / n) as f32;
    }
    TmSubframe {
        data,
        pilots,
        ..last.clone_without_arrays()
    }
}

impl TmSubframe {
    /// Copy of the scalar fields (empty arrays) — avoids copying 16 KB for nothing.
    fn clone_without_arrays(&self) -> TmSubframe {
        TmSubframe {
            location: self.location,
            type_: self.type_,
            activity: self.activity,
            colored_fraction: self.colored_fraction,
            saturation: self.saturation,
            photometry: self.photometry,
            data: Vec::new(),
            pilots: Vec::new(),
        }
    }
}

/// Mean gap (normalized levels) between two captures: ≈ noise if same content, large otherwise.
pub fn subframe_gap(a: &TmSubframe, b: &TmSubframe) -> f64 {
    let mut sum = 0.0;
    for (x, y) in a.data.iter().zip(&b.data) {
        sum += (*x as f64 - *y as f64).abs();
    }
    sum / a.data.len() as f64
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmMeasurement {
    /// Soft values per module and channel (≈ ±1: sent sign × confidence).
    pub soft: Vec<f32>,
    /// Channel gains (diagonal of the matrix), relative to the nominal amplitude.
    pub gains: RGB,
    /// Crosstalk: largest off-diagonal term / diagonal.
    pub crosstalk: f64,
    /// RMS residual of the pilots after the model, relative to the mean gain.
    pub residual: f64,
    /// True if the full matrix was inverted (otherwise: diagonal gains only).
    pub full_matrix: bool,
}

/// Soft measurement of an R/P pair: color matrix on the pilots, inversion, local gain.
pub fn measure_tm_pair(reference: &TmSubframe, payload: &TmSubframe) -> TmMeasurement {
    let tm_pilots = &*TM_PILOTS;
    let n = tm_pilots.len();
    let nf = n as f64;
    let sig: Vec<[f64; 3]> = tm_pilots.iter().map(|&[_, _, d]| signs(d)).collect();
    // Δ pilots = G·σ + o — full factorial design ×2.
    let mut g = [[0f64; 3]; 3];
    let mut o = [0f64; 3];
    for i in 0..n {
        for c in 0..3 {
            let delta = payload.pilots[i * 3 + c] as f64 - reference.pilots[i * 3 + c] as f64;
            o[c] += delta / nf;
            for j in 0..3 {
                g[c][j] += (delta * sig[i][j]) / nf;
            }
        }
    }
    let mut residual2 = 0f64;
    for i in 0..n {
        for c in 0..3 {
            let model = g[c][0] * sig[i][0] + g[c][1] * sig[i][1] + g[c][2] * sig[i][2] + o[c];
            let e = payload.pilots[i * 3 + c] as f64 - reference.pilots[i * 3 + c] as f64 - model;
            residual2 += e * e;
        }
    }
    let diag: RGB = [g[0][0], g[1][1], g[2][2]];
    let mean_gain = 1e-6f64.max((diag[0].abs() + diag[1].abs() + diag[2].abs()) / 3.0);
    let mut crosstalk = 0f64;
    for c in 0..3 {
        for j in 0..3 {
            if c != j {
                crosstalk = crosstalk.max(g[c][j].abs() / 1e-6f64.max(diag[c].abs()));
            }
        }
    }

    // Inversion: full matrix if well conditioned, otherwise diagonal.
    let floor = 3.0; // normalized levels — below this, the channel is dead
    let det = g[0][0] * (g[1][1] * g[2][2] - g[1][2] * g[2][1])
        - g[0][1] * (g[1][0] * g[2][2] - g[1][2] * g[2][0])
        + g[0][2] * (g[1][0] * g[2][1] - g[1][1] * g[2][0]);
    let mut inverse: Option<[[f64; 3]; 3]> = None;
    if diag.iter().all(|&d| d > floor) && det > 0.25 * diag[0] * diag[1] * diag[2] {
        let cof = |r: usize, c: usize| {
            let lines: Vec<usize> = (0..3).filter(|&i| i != r).collect();
            let columns: Vec<usize> = (0..3).filter(|&i| i != c).collect();
            let (a, b) = (lines[0], lines[1]);
            let (p, q) = (columns[0], columns[1]);
            (if (r + c).is_multiple_of(2) { 1.0 } else { -1.0 })
                * (g[a][p] * g[b][q] - g[a][q] * g[b][p])
        };
        inverse = Some(std::array::from_fn(|r| {
            std::array::from_fn(|c| cof(c, r) / det)
        }));
    }
    let inv = inverse.unwrap_or_else(|| {
        std::array::from_fn(|r| {
            std::array::from_fn(|c| {
                if r == c {
                    1.0 / floor.max(diag[r])
                } else {
                    0.0
                }
            })
        })
    });

    // Local gain: R gray at the module / mean R gray at the pilots.
    let luma = |t: &[f32], i: usize| {
        0.299 * t[i * 3] as f64 + 0.587 * t[i * 3 + 1] as f64 + 0.114 * t[i * 3 + 2] as f64
    };
    let mut pilot_luma = 0f64;
    for i in 0..n {
        pilot_luma += luma(&reference.pilots, i) / nf;
    }

    let nb = TM_DATA_MODULES.len();
    let mut soft = vec![0f32; nb * 3];
    for m in 0..nb {
        let y: [f64; 3] = std::array::from_fn(|c| {
            payload.data[m * 3 + c] as f64 - reference.data[m * 3 + c] as f64 - o[c]
        });
        let lambda = if pilot_luma > 8.0 {
            2f64.min(0.5f64.max(luma(&reference.data, m) / pilot_luma))
        } else {
            1.0
        };
        for c in 0..3 {
            soft[m * 3 + c] =
                ((inv[c][0] * y[0] + inv[c][1] * y[1] + inv[c][2] * y[2]) / lambda) as f32;
        }
    }
    let nominal = AMPLITUDE_TM as f64; // expected amplitude in the normalized scale
    TmMeasurement {
        soft,
        gains: [diag[0] / nominal, diag[1] / nominal, diag[2] / nominal],
        crosstalk,
        residual: (residual2 / (nf * 3.0)).sqrt() / mean_gain,
        full_matrix: inverse.is_some(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecisionTM {
    pub bytes: Vec<u8>,
    /// Mean confidence of the modules (0..1): decision margin / amplitude.
    pub mean_confidence: f64,
    /// Fraction of modules below the confidence threshold (0..1).
    pub uncertain_fraction: f64,
}

/// Confidence threshold of an "uncertain" module.
pub const TM_UNCERTAIN_THRESHOLD: f64 = 0.25;

/// Hard decision from the soft values (possibly accumulated over several pairs).
pub fn decide_tm(soft: &[f32], codec: Codec) -> Result<DecisionTM, OpticsError> {
    let bits = bits_tm(codec)?;
    let nb = soft.len() / 3;
    let mut stream = vec![0u8; nb * bits];
    let mut sum_confidence = 0f64;
    let mut uncertain = 0usize;
    for m in 0..nb {
        let s0 = soft[m * 3] as f64;
        let s1 = soft[m * 3 + 1] as f64;
        let s2 = soft[m * 3 + 2] as f64;
        let mut confidence;
        if bits == 3 {
            stream[m * 3] = (s0 > 0.0) as u8;
            stream[m * 3 + 1] = (s1 > 0.0) as u8;
            stream[m * 3 + 2] = (s2 > 0.0) as u8;
            confidence = s0.abs().min(s1.abs()).min(s2.abs());
        } else {
            // Maximum likelihood among the 4 even-parity words.
            let mut best = f64::NEG_INFINITY;
            let mut second = f64::NEG_INFINITY;
            let mut value = 0u8;
            for (v, &[r, g, b]) in TM4_WORDS.iter().enumerate() {
                let score = (if r != 0 { s0 } else { -s0 })
                    + (if g != 0 { s1 } else { -s1 })
                    + (if b != 0 { s2 } else { -s2 });
                if score > best {
                    second = best;
                    best = score;
                    value = v as u8;
                } else if score > second {
                    second = score;
                }
            }
            stream[m * 2] = (value >> 1) & 1;
            stream[m * 2 + 1] = value & 1;
            confidence = (best - second) / 4.0; // neighboring words: 2 channels apart, ±1 each
        }
        confidence = 1f64.min(0f64.max(confidence));
        sum_confidence += confidence;
        if confidence < TM_UNCERTAIN_THRESHOLD {
            uncertain += 1;
        }
    }
    let mask = &*TM_MASK;
    let bytes = (0..stream.len() / 8)
        .map(|i| {
            let mut o = 0u8;
            for b in 0..8 {
                o = (o << 1) | stream[i * 8 + b];
            }
            o ^ mask.get(i).copied().unwrap_or(0)
        })
        .collect();
    let nbf = nb as f64;
    Ok(DecisionTM {
        bytes,
        mean_confidence: if nb > 0 { sum_confidence / nbf } else { 0.0 },
        uncertain_fraction: if nb > 0 { uncertain as f64 / nbf } else { 0.0 },
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct TmResult {
    pub decision: DecisionTM,
    pub measurement: TmMeasurement,
    pub location: Location,
}

/// Decodes a complete pair of images (reference then payload).
pub fn decoder_tm(
    reference: &ImageRGBA,
    payload: &ImageRGBA,
    codec: Codec,
) -> Result<TmResult, OpticsError> {
    let loc_r = locate_tm(reference, None).ok_or(OpticsError::NotFound(
        "TM: finder patterns not found in the reference subframe",
    ))?;
    let loc_p = locate_tm(payload, Some(&loc_r)).unwrap_or(loc_r);
    let measurement = measure_tm_pair(
        &analyze_subframe(reference, &loc_r),
        &analyze_subframe(payload, &loc_p),
    );
    let decision = decide_tm(&measurement.soft, codec)?;
    Ok(TmResult {
        decision,
        measurement,
        location: loc_r,
    })
}
