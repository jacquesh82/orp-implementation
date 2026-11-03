//! Grid location — framing (OPTI-07).
//!
//! Affine from the three markers → prediction of a FOURTH point (5×5
//! alignment pattern placed by the TM representation) → local template
//! search, centroid refinement → exact four-point HOMOGRAPHY. When no pattern
//! is found, the homography degenerates into the affine.

use crate::decoder::{
    affine_from_triplet, choose_triplet, choose_triplets, detect_markers, sample, Affine,
    MarkerCandidate, DetectionThreshold, Triplet,
};
use crate::grid::MARKERS;
use crate::js;
use crate::render::ImageRGBA;

/// 3×3 homography (row by row): module (x, y) → image pixel.
pub type Homography = [f64; 9];

pub fn homography_from_affine(t: &Affine) -> Homography {
    [t.a, t.c, t.e, t.b, t.d, t.f, 0.0, 0.0, 1.0]
}

#[inline]
pub fn apply_h(h: &Homography, x: f64, y: f64) -> [f64; 2] {
    let w = h[6] * x + h[7] * y + h[8];
    [
        (h[0] * x + h[1] * y + h[2]) / w,
        (h[3] * x + h[4] * y + h[5]) / w,
    ]
}

/// Exact homography from four correspondences (h8 = 1).
pub fn homography_from_4(source: &[[f64; 2]; 4], destination: &[[f64; 2]; 4]) -> Option<Homography> {
    let mut m = [[0f64; 9]; 8];
    for i in 0..4 {
        let [x, y] = source[i];
        let [u, v] = destination[i];
        m[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        m[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    // Gaussian elimination with partial pivoting on the augmented 8×8 system.
    for col in 0..8 {
        let mut pivot = col;
        for r in col + 1..8 {
            if m[r][col].abs() > m[pivot][col].abs() {
                pivot = r;
            }
        }
        if m[pivot][col].abs() < 1e-12 {
            return None;
        }
        m.swap(col, pivot);
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = m[r][col] / m[col][col];
            if f == 0.0 {
                continue;
            }
            for k in col..9 {
                m[r][k] -= f * m[col][k];
            }
        }
    }
    let mut h = [1.0f64; 9];
    for i in 0..8 {
        h[i] = m[i][8] / m[i][i];
    }
    Some(h)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Location {
    /// Retained module → pixel transform (homography, or affine as a fallback).
    pub h: Homography,
    pub affine: Affine,
    /// Image centers of the TL, TR, BL markers.
    pub markers: Triplet,
    /// Image center of the alignment pattern, if it was found.
    pub alignment: Option<[f64; 2]>,
    /// Gap (in modules) between the affine prediction and the pattern found.
    pub perspective_gap: f64,
    /// Apparent size of a module (px), between TL and TR.
    pub px_per_module: f64,
    /// Black/white luminance threshold measured on the markers.
    pub threshold: f64,
}

fn luma_at(image: &ImageRGBA, [px, py]: [f64; 2], radius: f64) -> f64 {
    let c = sample(image, px, py, radius);
    0.299 * c.r + 0.587 * c.g + 0.114 * c.b
}

/// Locates the grid in a captured image. `alignment`: module index of the
/// center of the expected 5×5 pattern (absent: affine only). `tracking`: a
/// recent location whose nearest markers are reused.
pub fn locate(
    image: &ImageRGBA,
    alignment: Option<[usize; 2]>,
    tracking: Option<&Location>,
) -> Option<Location> {
    let candidates = detect_markers(image, DetectionThreshold::Otsu);
    // TRACKING: a P subframe (colored data) produces dozens of false
    // patterns; the "best triangle" can then be a false one.
    let mut triplet = tracking.and_then(|s| track(&candidates, s));
    if triplet.is_none() {
        triplet = choose_triplet(&candidates);
    }
    if triplet.is_none() {
        triplet = choose_triplet(&detect_markers(image, DetectionThreshold::Local));
    }
    let triplet = triplet?;
    if let Some(s) = tracking {
        if !coherent(&triplet, s) {
            return None; // false triangle: better nothing
        }
    }
    Some(locate_from_triplet(image, &triplet, alignment))
}

/// All the grids of an image (mosaic), sorted into rows then columns.
/// Grids searched at most: a 7 × 7 mosaic (limit of a 4K camera).
pub const MAX_GRIDS: usize = 49;

pub fn locate_all(
    image: &ImageRGBA,
    alignment: Option<[usize; 2]>,
    maximum: usize,
) -> Vec<Location> {
    // GLOBAL threshold (Otsu) first, then LOCAL threshold: when the image holds
    // a lot of true black (screen edge, background), Otsu settles between that
    // black and the rest, and the dark-gray markers of a mosaic fall on the
    // light side. The threshold that finds the most grids is kept — Otsu on a
    // tie (same rule as the TS).
    // Every triplet gives a location: the choice is made on the triplets, and
    // only the retained ones are located (alignment search).
    let global = choose_triplets(&detect_markers(image, DetectionThreshold::Otsu), maximum);
    let locales = choose_triplets(&detect_markers(image, DetectionThreshold::Local), maximum);
    let chosen = if locales.len() > global.len() { locales } else { global };
    // Triangles chosen one by one, every marker INSIDE a found grid discarded
    // before looking for the next one (decoder::choose_triplets).
    let mut found: Vec<Location> = chosen
        .iter()
        .map(|triplet| locate_from_triplet(image, triplet, alignment))
        .collect();
    if found.is_empty() {
        return found;
    }
    let line = js::min(found.iter().map(|l| l.px_per_module)) * 20.0;
    js::sort(&mut found, |a, b| {
        let dy = a.markers[0][1] - b.markers[0][1];
        if dy.abs() > line {
            dy
        } else {
            a.markers[0][0] - b.markers[0][0]
        }
    });
    found
}

/// Copy of a window of the image.
fn crop(image: &ImageRGBA, x0: usize, y0: usize, x1: usize, y1: usize) -> ImageRGBA {
    let width = x1 - x0;
    let height = y1 - y0;
    let mut data = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let start = ((y0 + y) * image.width + x0) * 4;
        data.extend_from_slice(&image.data[start..start + width * 4]);
    }
    ImageRGBA {
        width,
        height,
        data,
    }
}

/// Marker found again in a window around its expected position.
fn marker_around(image: &ImageRGBA, mx: f64, my: f64, module: f64) -> Option<[f64; 2]> {
    let radius = (8.0 * module).ceil();
    let x0 = 0f64.max((mx - radius).floor());
    let y0 = 0f64.max((my - radius).floor());
    let x1 = (image.width as f64).min((mx + radius).ceil());
    let y1 = (image.height as f64).min((my + radius).ceil());
    if x1 - x0 < 4.0 * module || y1 - y0 < 4.0 * module {
        return None;
    }
    let window = crop(image, x0 as usize, y0 as usize, x1 as usize, y1 as usize);
    for threshold in [DetectionThreshold::Otsu, DetectionThreshold::Local] {
        let mut best: Option<[f64; 2]> = None;
        let mut distance = 1.5 * module;
        for c in detect_markers(&window, threshold) {
            let size = c.score / 7.0 / module; // pattern length on the row: ≥ 7 modules
            if !(0.7..=1.6).contains(&size) {
                continue;
            }
            let d = js::hypot(c.x + x0 - mx, c.y + y0 - my);
            if d < distance {
                distance = d;
                best = Some([c.x + x0, c.y + y0]);
            }
        }
        if best.is_some() {
            return best;
        }
    }
    None
}

/// FAST TRACKING of an already located grid: its three markers are searched
/// only in small windows (±8 modules). If none moved by more than `still`
/// module (0.08 by default), the previous location is returned as is. None
/// if a marker is missing.
pub fn track_location(
    image: &ImageRGBA,
    previous: &Location,
    alignment: Option<[usize; 2]>,
    still: f64,
) -> Option<Location> {
    let m = previous.px_per_module;
    let mut found_points = [[0f64; 2]; 3];
    let mut gap = 0f64;
    for (i, &[mx, my]) in previous.markers.iter().enumerate() {
        let t = marker_around(image, mx, my, m)?;
        gap = gap.max(js::hypot(t[0] - mx, t[1] - my) / m);
        found_points[i] = t;
    }
    if gap < still {
        return Some(*previous);
    }
    if !coherent(&found_points, previous) {
        return None;
    }
    Some(locate_from_triplet(image, &found_points, alignment))
}

/// Default "still" threshold of `track_location` (modules).
pub const TRACKING_STILL: f64 = 0.08;

/// Full searches and fast trackings performed (diagnostics).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackedCount {
    pub completes: u64,
    pub fast: u64,
}

/// Location in a STREAM: known grids tracked through windows, full search
/// periodically or as soon as a tracked grid is lost.
#[derive(Debug, Clone)]
pub struct GridTracker {
    known: Vec<Location>,
    last_completed: f64,
    alignment: Option<[usize; 2]>,
    /// Interval (ms) between two full searches when everything is tracked.
    full_period: f64,
    pub count: TrackedCount,
}

impl GridTracker {
    pub fn new(alignment: Option<[usize; 2]>, full_period: f64) -> Self {
        Self {
            known: Vec::new(),
            last_completed: f64::NEG_INFINITY,
            alignment,
            full_period,
            count: TrackedCount::default(),
        }
    }

    pub fn locate(&mut self, image: &ImageRGBA, t: f64) -> &[Location] {
        if !self.known.is_empty()
            && t - self.last_completed < self.full_period
            && t >= self.last_completed
        {
            let all_tracked: Option<Vec<Location>> = self
                .known
                .iter()
                .map(|l| track_location(image, l, self.alignment, TRACKING_STILL))
                .collect();
            // (`collect` stops at the first lost grid: same result as the TS,
            // which tracks them all before concluding)
            if let Some(s) = all_tracked {
                self.count.fast += 1;
                self.known = s;
                return &self.known;
            }
        }
        self.count.completes += 1;
        self.last_completed = t;
        let mut found = locate_all(image, self.alignment, MAX_GRIDS);
        for old in &self.known {
            let tl = old.markers[0];
            // (as in TS: grids taken over by tracking count too)
            let reviewed = found.iter().any(|l| {
                js::hypot(l.markers[0][0] - tl[0], l.markers[0][1] - tl[1])
                    < 20.0 * old.px_per_module
            });
            if reviewed {
                continue;
            }
            if let Some(tracked) =
                track_location(image, old, self.alignment, TRACKING_STILL)
            {
                found.push(tracked);
            }
        }
        self.known = found;
        &self.known
    }

    pub fn forget(&mut self) {
        self.known.clear();
        self.last_completed = f64::NEG_INFINITY;
    }
}

fn locate_from_triplet(
    image: &ImageRGBA,
    triplet: &Triplet,
    alignment: Option<[usize; 2]>,
) -> Location {
    let affine = affine_from_triplet(triplet[0], triplet[1], triplet[2]);
    let px_per_module =
        js::hypot(triplet[1][0] - triplet[0][0], triplet[1][1] - triplet[0][1]) / 34.0;
    let to_image = |x: f64, y: f64| -> [f64; 2] {
        [
            affine.a * x + affine.c * y + affine.e,
            affine.b * x + affine.d * y + affine.f,
        ]
    };

    // LOCAL black/white threshold: marker cores (black) and inner white ring
    // at ±2 modules from the center.
    let mut blacks = Vec::with_capacity(3);
    let mut whites = Vec::with_capacity(12);
    for [mx, my] in MARKERS {
        let cx = mx as f64 + 0.5;
        let cy = my as f64 + 0.5;
        blacks.push(luma_at(
            image,
            to_image(cx, cy),
            1f64.max(0.8 * px_per_module),
        ));
        for [dx, dy] in [[-2.0, 0.0], [2.0, 0.0], [0.0, -2.0], [0.0, 2.0]] {
            whites.push(luma_at(
                image,
                to_image(cx + dx, cy + dy),
                1f64.max(0.25 * px_per_module),
            ));
        }
    }
    let (black_median, white_median) = (js::median(&blacks), js::median(&whites));
    let threshold = (black_median + white_median) / 2.0;

    let base = Location {
        h: homography_from_affine(&affine),
        affine,
        markers: *triplet,
        alignment: None,
        perspective_gap: 0.0,
        px_per_module,
        threshold,
    };
    let Some(al) = alignment else { return base };
    if white_median - black_median < 30.0 {
        return base;
    }
    let (ax, ay) = (al[0] as f64 + 0.5, al[1] as f64 + 0.5);
    let Some((center, gap)) =
        find_alignment(image, &to_image, ax, ay, px_per_module, threshold)
    else {
        return base;
    };
    let source = [
        [MARKERS[0][0] as f64 + 0.5, MARKERS[0][1] as f64 + 0.5],
        [MARKERS[1][0] as f64 + 0.5, MARKERS[1][1] as f64 + 0.5],
        [MARKERS[2][0] as f64 + 0.5, MARKERS[2][1] as f64 + 0.5],
        [ax, ay],
    ];
    match homography_from_4(&source, &[triplet[0], triplet[1], triplet[2], center]) {
        Some(h) if sane_homography(&h) => Location {
            h,
            alignment: Some(center),
            perspective_gap: gap,
            ..base
        },
        _ => base,
    }
}

/// A triplet found outside tracking must stay plausible: same size (±25 %), TL within 8 modules.
fn coherent(triplet: &Triplet, tracking: &Location) -> bool {
    let size = js::hypot(triplet[1][0] - triplet[0][0], triplet[1][1] - triplet[0][1]) / 34.0;
    if (size - tracking.px_per_module).abs() > 0.25 * tracking.px_per_module {
        return false;
    }
    js::hypot(
        triplet[0][0] - tracking.markers[0][0],
        triplet[0][1] - tracking.markers[0][1],
    ) < 8.0 * tracking.px_per_module
}

fn track(candidates: &[MarkerCandidate], tracking: &Location) -> Option<Triplet> {
    let tolerance = 1.5 * tracking.px_per_module;
    let mut found_points = [[0f64; 2]; 3];
    for (i, &[mx, my]) in tracking.markers.iter().enumerate() {
        let mut best: Option<&MarkerCandidate> = None;
        let mut distance = tolerance;
        for c in candidates {
            let d = js::hypot(c.x - mx, c.y - my);
            if d < distance {
                distance = d;
                best = Some(c);
            }
        }
        let m = best?;
        found_points[i] = [m.x, m.y];
    }
    Some(found_points)
}

/// Rejects a homography that folds the grid (w ≤ 0 on a corner).
fn sane_homography(h: &Homography) -> bool {
    [[0.0, 0.0], [41.0, 0.0], [0.0, 41.0], [41.0, 41.0]]
        .iter()
        .all(|&[x, y]| h[6] * x + h[7] * y + h[8] > 0.05)
}

/// Template search for the 5×5 alignment pattern (black ring, white ring,
/// black center) around the affine prediction: ±10 modules, 3×3 scales,
/// luminance lattice with a ¼-module step.
fn find_alignment(
    image: &ImageRGBA,
    to_image: &dyn Fn(f64, f64) -> [f64; 2],
    cx: f64,
    cy: f64,
    px_per_module: f64,
    threshold: f64,
) -> Option<([f64; 2], f64)> {
    const STEP: i64 = 4; // samples per module
    const RANGE: i64 = 10; // search modules on each side
    const SCALES: [f64; 3] = [0.82, 1.0, 1.2];
    let step = STEP as f64;
    let half = ((RANGE as f64 + 2.5 * SCALES[2]) * step).ceil() as i64;
    let side = 2 * half + 1;
    let mut black = vec![0u8; (side * side) as usize];
    let radius = 1f64.max(0.15 * px_per_module);
    let (width, height) = (image.width as f64, image.height as f64);
    for j in 0..side {
        for i in 0..side {
            let [px, py] = to_image(cx + (i - half) as f64 / step, cy + (j - half) as f64 / step);
            let k = (j * side + i) as usize;
            if px < 0.0 || py < 0.0 || px >= width || py >= height {
                black[k] = 2; // outside the image: matches nothing
                continue;
            }
            black[k] = (luma_at(image, [px, py], radius) < threshold) as u8;
        }
    }
    // Templates: lattice offsets of the 25 cells for each pair of scales.
    let mut templates: Vec<[(i64, u8); 25]> = Vec::with_capacity(9);
    for sx in SCALES {
        for sy in SCALES {
            let mut cells = [(0i64, 0u8); 25];
            let mut n = 0;
            for v in -2i64..=2 {
                for u in -2i64..=2 {
                    let di = js::round(u as f64 * sx * step) as i64;
                    let dj = js::round(v as f64 * sy * step) as i64;
                    let expected = if u.abs().max(v.abs()) == 1 { 0 } else { 1 };
                    cells[n] = (dj * side + di, expected);
                    n += 1;
                }
            }
            templates.push(cells);
        }
    }
    let mut best: i32 = -1;
    let mut positions: Vec<(i64, i64)> = Vec::new();
    for oj in -RANGE * STEP..=RANGE * STEP {
        for oi in -RANGE * STEP..=RANGE * STEP {
            let base = (half + oj) * side + half + oi;
            // Quick cut: the center must be black.
            if black[base as usize] != 1 {
                continue;
            }
            // Best template score. A template is abandoned as soon as it can
            // no longer reach max(score, best): the score stays exact whenever
            // it is ≥ best — the only case where it counts.
            let mut score = 0;
            for cells in &templates {
                if score == 25 {
                    break;
                }
                let floor = score.max(best);
                let mut s = 0;
                for (m, &(offset, expected)) in cells.iter().enumerate() {
                    if black[(base + offset) as usize] == expected {
                        s += 1;
                    } else if s + 24 - (m as i32) < floor {
                        break;
                    }
                }
                if s > score {
                    score = s;
                }
            }
            if score > best {
                best = score;
                positions.clear();
                positions.push((oi, oj));
            } else if score == best {
                positions.push((oi, oj));
            }
        }
    }
    if best < 23 {
        return None;
    }
    // Plateau of the best score: only the neighborhood (≤ 1 module) of the
    // first position is averaged — two disjoint plateaus = ambiguous pattern.
    let (ri, rj) = positions[0];
    let neighbors: Vec<(i64, i64)> = positions
        .iter()
        .copied()
        .filter(|&(i, j)| (i - ri).abs() <= STEP && (j - rj).abs() <= STEP)
        .collect();
    if (neighbors.len() as f64) < positions.len() as f64 / 2.0 {
        return None;
    }
    let nv = neighbors.len() as f64;
    let ox = neighbors.iter().fold(0.0, |a, &(i, _)| a + i as f64) / nv / step;
    let oy = neighbors.iter().fold(0.0, |a, &(_, j)| a + j as f64) / nv / step;
    let [mut px, mut py] = to_image(cx + ox, cy + oy);
    // Refinement: centroid of the dark pixels of the center (radius 1.2 modules).
    for _ in 0..2 {
        let r = 1.2 * px_per_module;
        let (mut mx, mut my, mut m) = (0.0f64, 0.0f64, 0usize);
        let y_start = 0f64.max((py - r).floor());
        let y_end = (height - 1.0).min((py + r).ceil());
        let x_start = 0f64.max((px - r).floor());
        let x_end = (width - 1.0).min((px + r).ceil());
        let mut y = y_start;
        while y <= y_end {
            let mut x = x_start;
            while x <= x_end {
                let (ex, ey) = (x + 0.5 - px, y + 0.5 - py);
                if ex * ex + ey * ey <= r * r {
                    let o = (y as usize * image.width + x as usize) * 4;
                    let d = &image.data;
                    let l = 0.299 * d[o] as f64 + 0.587 * d[o + 1] as f64 + 0.114 * d[o + 2] as f64;
                    if l < threshold {
                        mx += x + 0.5;
                        my += y + 0.5;
                        m += 1;
                    }
                }
                x += 1.0;
            }
            y += 1.0;
        }
        if m == 0 {
            return None;
        }
        px = mx / m as f64;
        py = my / m as f64;
    }
    let [ax, ay] = to_image(cx, cy);
    Some(([px, py], js::hypot(px - ax, py - ay) / px_per_module))
}
