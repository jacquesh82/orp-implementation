//! Optical decoder v0.1: captured image → bytes of the data area.
//!
//! Pipeline (§5.4): luminance → Otsu (or local) binarization → detection of
//! the three finder markers (1:1:3:1:1 pattern) → AFFINE transform from the
//! three centers → sampling of the center of each module → colorimetric
//! classification with a confidence margin.

use std::collections::HashSet;

use orp_core::Codec;

use crate::cielab::{classifier, lab_of, rgb_to_lab, Lab};
use crate::grid::{data_modules, MARKERS, GRID_SIZE};
use crate::js;
use crate::palettes::{bits_per_module, palette_for};
use crate::render::ImageRGBA;
use crate::OpticsError;

#[derive(Debug, Clone, PartialEq)]
pub struct CalibratedPalette {
    pub codec: Codec,
    /// One Lab centroid per palette index.
    pub centroids: Vec<Lab>,
    /// Mean confidence of the calibration (0..1) — the "score" of F-05.
    pub confidence: f64,
}

#[derive(Debug, Clone, Default)]
pub struct DecodeOptions<'a> {
    pub palette: Option<&'a CalibratedPalette>,
    /// Confidence threshold below which a module counts as "uncertain" (default 0.1).
    pub confidence_threshold: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodeResult {
    /// Bytes of the data area, in the order of `data_modules()` (MSB first).
    pub bytes: Vec<u8>,
    /// Mean classification confidence of the data modules (0..1).
    pub mean_confidence: f64,
    /// Fraction of modules below the confidence threshold (0..1).
    pub uncertain_fraction: f64,
}

// ── Luminance and binarization ────────────────────────────────────────────

/// Luminance per pixel (Float32Array in TS: computed in double, stored as f32).
pub fn luminance(image: &ImageRGBA) -> Vec<f32> {
    image
        .data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64) as f32)
        .collect()
}

/// Otsu threshold — automatic black/white separation.
pub fn otsu_threshold(l: &[f32]) -> f64 {
    let mut histogram = [0f64; 256];
    for &v in l {
        histogram[js::round(v as f64).clamp(0.0, 255.0) as usize] += 1.0;
    }
    let total = l.len() as f64;
    let mut sum = 0.0;
    for (i, h) in histogram.iter().enumerate() {
        sum += i as f64 * h;
    }
    let mut sum_b = 0.0;
    let mut weight_b = 0.0;
    let mut best = 0;
    let mut variance_max = -1.0;
    for t in 0..256 {
        weight_b += histogram[t];
        if weight_b == 0.0 {
            continue;
        }
        let weight_f = total - weight_b;
        if weight_f == 0.0 {
            break;
        }
        sum_b += t as f64 * histogram[t];
        let mean_b = sum_b / weight_b;
        let mean_f = (sum - sum_b) / weight_f;
        let variance = weight_b * weight_f * (mean_b - mean_f) * (mean_b - mean_f);
        if variance > variance_max {
            variance_max = variance;
            best = t;
        }
    }
    best as f64
}

fn binarize(l: &[f32], threshold: f64) -> Vec<u8> {
    l.iter().map(|&v| (v as f64 > threshold) as u8).collect()
}

/// Adaptive binarization (Bradley): white if the luminance exceeds 85 % of
/// the local mean.
fn binarize_local(l: &[f32], width: usize, height: usize) -> Vec<u8> {
    let radius = 7usize.max(js::round(width.min(height) as f64 / 16.0) as usize);
    let w1 = width + 1;
    let mut integral = vec![0f64; w1 * (height + 1)];
    for y in 0..height {
        let mut line = 0f64;
        for x in 0..width {
            line += l[y * width + x] as f64;
            integral[(y + 1) * w1 + x + 1] = integral[y * w1 + x + 1] + line;
        }
    }
    let mut b = vec![0u8; l.len()];
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = height.min(y + radius + 1);
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let x1 = width.min(x + radius + 1);
            let sum = integral[y1 * w1 + x1] - integral[y0 * w1 + x1] - integral[y1 * w1 + x0]
                + integral[y0 * w1 + x0];
            let n = ((x1 - x0) * (y1 - y0)) as f64;
            b[y * width + x] = (l[y * width + x] as f64 * n > sum * 0.85) as u8;
        }
    }
    b
}

// ── Finder marker detection ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkerCandidate {
    pub x: f64,
    pub y: f64,
    /// Length (px) of the 1:1:3:1:1 pattern on the scan line.
    pub score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DetectionThreshold {
    /// Global Otsu (default).
    #[default]
    Otsu,
    /// Sliding mean — non-uniform lighting.
    Local,
}

/// Searches for the 1:1:3:1:1 pattern on the binarized rows, checked
/// vertically, recentered to subpixel precision.
pub fn detect_markers(image: &ImageRGBA, threshold: DetectionThreshold) -> Vec<MarkerCandidate> {
    let l = luminance(image);
    let b = match threshold {
        DetectionThreshold::Local => binarize_local(&l, image.width, image.height),
        DetectionThreshold::Otsu => binarize(&l, otsu_threshold(&l)),
    };
    let (width, height) = (image.width, image.height);
    let mut candidates = Vec::new();
    let mut visited: HashSet<i64> = HashSet::new();

    for y in 0..height {
        let row = &b[y * width..(y + 1) * width];
        let mut x = 0;
        while x < width {
            if row[x] != 0 {
                x += 1;
                continue;
            }
            // Start of a sequence of black runs: measures 5 runs 1:1:3:1:1.
            let mut ranges = [0usize; 5];
            let mut nb = 0;
            let mut cursor = x;
            for p in 0..5 {
                let start = cursor;
                let expected = if p % 2 == 0 { 0 } else { 1 };
                while cursor < width && row[cursor] == expected {
                    cursor += 1;
                }
                ranges[nb] = cursor - start;
                nb += 1;
                if cursor >= width && p < 4 {
                    break;
                }
            }
            if nb == 5 {
                let total: usize = ranges.iter().sum();
                if (14..=600).contains(&total) && check_ratio(&ranges) {
                    let total = total as f64;
                    let cx = x as f64 + total / 2.0;
                    let unit = total / 7.0;
                    // Recenter vertically: only the CENTER row lines up
                    // the 7 modules of the marker.
                    let (cy, score) = center_vertically(
                        &b,
                        width,
                        height,
                        js::round(cx) as i64,
                        y as f64,
                        unit,
                    );
                    if score >= 6 {
                        let key = js::round(cx / 4.0) as i64 * 1000 + js::round(cy / 4.0) as i64;
                        if visited.insert(key) {
                            // Subpixel refinement: centroid of the black 3×3 core.
                            let [rx, ry] = refine_center(&b, width, height, cx, cy, unit);
                            candidates.push(MarkerCandidate {
                                x: rx,
                                y: ry,
                                score: total,
                            });
                        }
                    }
                }
            }
            // Skip: a pattern necessarily starts at the BEGINNING of a black run.
            x += if nb >= 2 {
                ranges[0] + ranges[1]
            } else {
                ranges[0] + 1
            };
        }
    }
    candidates
}

fn check_ratio(ranges: &[usize; 5]) -> bool {
    let [a, c, d, e, f] = ranges.map(|v| v as f64);
    let unit = (a + c + e + f) / 4.0;
    let nearest = |v: f64, destination: f64| (v - destination).abs() <= 1f64.max(0.45 * destination);
    nearest(a, unit)
        && nearest(c, unit)
        && nearest(d, 3.0 * unit)
        && nearest(e, unit)
        && nearest(f, unit)
}

/// Centroid of the black pixels of the 3×3 core — subpixel precision.
fn refine_center(
    b: &[u8],
    width: usize,
    height: usize,
    cx: f64,
    cy: f64,
    unit: f64,
) -> [f64; 2] {
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut n = 0usize;
    let radius = 1.6 * unit;
    let x0 = (cx - radius).floor().max(0.0) as usize;
    let x1 = ((width - 1) as f64).min((cx + radius).ceil()) as i64;
    let y0 = (cy - radius).floor().max(0.0) as usize;
    let y1 = ((height - 1) as f64).min((cy + radius).ceil()) as i64;
    let mut y = y0 as i64;
    while y <= y1 {
        let mut x = x0 as i64;
        while x <= x1 {
            if b[y as usize * width + x as usize] == 0 {
                sum_x += x as f64 + 0.5;
                sum_y += y as f64 + 0.5;
                n += 1;
            }
            x += 1;
        }
        y += 1;
    }
    if n == 0 {
        return [cx, cy];
    }
    [sum_x / n as f64, sum_y / n as f64]
}

fn center_vertically(
    b: &[u8],
    width: usize,
    height: usize,
    x: i64,
    cy0: f64,
    unit: f64,
) -> (f64, u32) {
    // The 3×3 core forms a black block of 3 modules along the column: we
    // search around the scan line for the black block whose length is
    // closest to 3·unit.
    let column = |y: i64| -> Option<u8> {
        if y < 0 || y >= height as i64 || x < 0 || x >= width as i64 {
            None
        } else {
            Some(b[y as usize * width + x as usize])
        }
    };
    let start = 0f64.max(js::round(cy0 - 5.0 * unit)) as i64;
    let end = ((height as f64) - 1.0).min(js::round(cy0 + 5.0 * unit)) as i64;
    // (center, block length)
    let mut best: Option<(f64, f64)> = None;
    let mut y = start;
    while y <= end {
        if column(y) == Some(0) {
            let begin = y;
            while y <= end && column(y) == Some(0) {
                y += 1;
            }
            let length = (y - begin) as f64;
            if best
                .is_none_or(|(_, l)| (length - 3.0 * unit).abs() < (l - 3.0 * unit).abs())
            {
                best = Some(((begin + y) as f64 / 2.0, length));
            }
        } else {
            y += 1;
        }
    }
    let Some((cy, _)) = best else {
        return (cy0, 0);
    };
    // Validates the 7-module pattern around the center found.
    const EXPECTED: [u8; 7] = [0, 1, 0, 0, 0, 1, 0];
    let mut score = 0;
    for (m, &a) in EXPECTED.iter().enumerate() {
        let yy = js::round(cy + (m as f64 - 3.0) * unit) as i64;
        if column(yy) == Some(a) {
            score += 1;
        }
    }
    (cy, score)
}

/// Three ordered marker centers: [TL, TR, BL].
pub type Triplet = [[f64; 2]; 3];

/// Acceptance test of ONE triple, taken in index order (p0 < p1 < p2): the
/// error (pythagorean + isosceles) and the ordered [TL, TR, BL] triplet, or
/// None when the triple is not a plausible grid.
fn evaluate_triple(p0: &MarkerCandidate, p1: &MarkerCandidate, p2: &MarkerCandidate) -> Option<(Triplet, f64)> {
    let pts = [p0, p1, p2];
    let d = |p: &MarkerCandidate, q: &MarkerCandidate| js::hypot(p.x - q.x, p.y - q.y);
    // A module smaller than 5 px cannot be decoded.
    let side1 = js::hypot(p0.x - p1.x, p0.y - p1.y);
    let side2 = js::hypot(p0.x - p2.x, p0.y - p2.y);
    if side1.min(side2) / 34.0 < 5.0 {
        return None;
    }
    // (length, opposite vertex), sorted by descending length (stable sort).
    let mut sides = [(d(p1, p2), 0usize), (d(p0, p2), 1), (d(p0, p1), 2)];
    js::sort(&mut sides, |a, b| b.0 - a.0);
    let hypotenuse = sides[0].0;
    let c1 = sides[1].0;
    let c2 = sides[2].0;
    let pythagoras_error =
        (hypotenuse * hypotenuse - (c1 * c1 + c2 * c2)).abs() / (hypotenuse * hypotenuse);
    let isosceles_error = (c1 - c2).abs() / c1.max(c2);
    let error = pythagoras_error + isosceles_error;
    if pythagoras_error > 0.15 || isosceles_error > 0.2 {
        return None;
    }
    let opposite = sides[0].1;
    let vertex = pts[opposite];
    let mut others = (0..3).filter(|&idx| idx != opposite).map(|idx| pts[idx]);
    let (p, q) = (others.next().unwrap(), others.next().unwrap());
    // Scale consistency: module size of the triangle (side / 34) against the
    // one the markers measure (horizontal pattern of 7 modules /
    // max(|cos θ|, |sin θ|)) — otherwise the top-left markers of three
    // NEIGHBORING grids of a mosaic form an equally perfect triangle.
    let theta = (p.y - vertex.y).atan2(p.x - vertex.x);
    let tilt = theta.cos().abs().max(theta.sin().abs());
    let marker_module = ((p0.score + p1.score + p2.score) / 21.0) * tilt;
    let module_triangle = (c1 + c2) / 2.0 / 34.0;
    if (module_triangle / marker_module - 1.0).abs() > 0.18 {
        return None;
    }
    // TL = vertex opposite the hypotenuse; TR / BL from the sign of the cross
    // product (image frame, y pointing down).
    let cross = (p.x - vertex.x) * (q.y - vertex.y) - (p.y - vertex.y) * (q.x - vertex.x);
    let (tr, bl) = if cross > 0.0 { (p, q) } else { (q, p) };
    Some(([[vertex.x, vertex.y], [tr.x, tr.y], [bl.x, bl.y]], error))
}

// Bounds of the plausible-triple enumeration, DERIVED from the acceptance
// test (≥ 5 % margin, no accepted triple is ever missed — same constants as
// the TS, see packages/optical/src/decoder.ts):
// - the leg from the vertex to the LOWER-index other marker is ≥ 170 px
//   (min-side test: the lowest index of the triple is the vertex or it);
// - mean leg m ∈ [0.9, 1.125] × leg and m ∈ [0.82, 1.18] × 34 · tilt · S / 21
//   (S: sum of the 3 scores, tilt ∈ [√2/2, 1]): a leg lies in [0.834 S, 2.123 S];
// - |cos| of the right angle ≤ 0.181, legs ratio ∈ [0.8, 1.25]: the third
//   marker lies within 0.337 × leg of the second one turned by ±90°.
// These bounds only prune: the exact test alone decides.
const MIN_LEG: f64 = 169.0;
const LEG_PER_SCORE_MIN: f64 = 0.79;
const LEG_PER_SCORE_MAX: f64 = 2.23;
const THIRD_RADIUS: f64 = 0.36;
const LEG_RATIO_MIN: f64 = 0.78;
const LEG_RATIO_MAX: f64 = 1.28;
const MAX_COS: f64 = 0.2;
/// Mean leg / S: [0.82 · 34 · √2/2 / 21, 1.18 · 34 / 21] = [0.939, 1.910], ± 3 %.
const MEAN_LEG_PER_SCORE_MIN: f64 = 0.91;
const MEAN_LEG_PER_SCORE_MAX: f64 = 1.97;

/// Calls `visit(i, j, k)` (i < j < k) for a SUPERSET of the triples that
/// `evaluate_triple` accepts — instead of the n³/6 triples: each candidate as
/// the right-angle vertex, each second marker at a compatible distance, the
/// third one only searched in a disc around its predicted position (uniform
/// grid of cells). A triple may be visited more than once.
fn for_each_plausible_triple(c: &[MarkerCandidate], mut visit: impl FnMut(usize, usize, usize)) {
    let n = c.len();
    if n < 3 {
        return;
    }
    let (mut min_score, mut max_score) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for k in c {
        min_score = min_score.min(k.score);
        max_score = max_score.max(k.score);
        min_x = min_x.min(k.x);
        min_y = min_y.min(k.y);
        max_x = max_x.max(k.x);
        max_y = max_y.max(k.y);
    }
    // Cells ≈ the search radius of a typical grid (leg ≈ 4.6 scores); inside
    // a cell, candidates by decreasing score (then index).
    let mut scores: Vec<f64> = c.iter().map(|k| k.score).collect();
    scores.sort_by(f64::total_cmp);
    let cell = 8f64.max(THIRD_RADIUS * 4.6 * scores[n >> 1]);
    let columns = ((max_x - min_x) / cell).floor() as usize + 1;
    let rows = ((max_y - min_y) / cell).floor() as usize + 1;
    let cell_count = columns * rows;
    let cell_of: Vec<usize> = c
        .iter()
        .map(|k| ((k.y - min_y) / cell).floor() as usize * columns + ((k.x - min_x) / cell).floor() as usize)
        .collect();
    let mut start = vec![0usize; cell_count + 1];
    for &k in &cell_of {
        start[k + 1] += 1;
    }
    for i in 0..cell_count {
        start[i + 1] += start[i];
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&p, &q| c[q].score.total_cmp(&c[p].score).then(p.cmp(&q)));
    let mut fill = start[..cell_count].to_vec();
    let mut items = vec![0usize; n];
    for &i in &order {
        items[fill[cell_of[i]]] = i;
        fill[cell_of[i]] += 1;
    }
    let cell_max: Vec<f64> = (0..cell_count)
        .map(|i| if start[i + 1] > start[i] { c[items[start[i]]].score } else { f64::NEG_INFINITY })
        .collect();

    // Score window of the third marker, implied by the leg-ratio and scale
    // tests below (1 % margin).
    let third_min = (1.0 + LEG_RATIO_MIN) / 2.0 / MEAN_LEG_PER_SCORE_MAX * 0.99;
    let third_max = (1.0 + LEG_RATIO_MAX) / 2.0 / MEAN_LEG_PER_SCORE_MIN * 1.01;
    for v in 0..n {
        let (vx, vy) = (c[v].x, c[v].y);
        for p in 0..n {
            if p == v {
                continue;
            }
            let (dx, dy) = (c[p].x - vx, c[p].y - vy);
            let leg2 = dx * dx + dy * dy;
            if leg2 < MIN_LEG * MIN_LEG {
                continue;
            }
            let pair = c[v].score + c[p].score;
            let low = (pair + min_score) * LEG_PER_SCORE_MIN;
            let high = (pair + max_score) * LEG_PER_SCORE_MAX;
            if leg2 < low * low || leg2 > high * high {
                continue;
            }
            let leg = leg2.sqrt();
            let score_min = third_min * leg - pair;
            let score_max = third_max * leg - pair;
            let r = THIRD_RADIUS * leg;
            for sign in [1.0, -1.0] {
                // Second marker turned by ±90° around the vertex.
                let (qx, qy) = (vx - sign * dy, vy + sign * dx);
                let cx0 = ((qx - r - min_x) / cell).floor().max(0.0) as usize;
                let cx1 = ((qx + r - min_x) / cell).floor().min(columns as f64 - 1.0);
                let cy0 = ((qy - r - min_y) / cell).floor().max(0.0) as usize;
                let cy1 = ((qy + r - min_y) / cell).floor().min(rows as f64 - 1.0);
                if cx1 < 0.0 || cy1 < 0.0 {
                    continue;
                }
                let (cx1, cy1) = (cx1 as usize, cy1 as usize);
                for cy in cy0..=cy1 {
                    for cx in cx0..=cx1 {
                        let idx = cy * columns + cx;
                        if cell_max[idx] < score_min {
                            continue;
                        }
                        for &q in &items[start[idx]..start[idx + 1]] {
                            let sq = c[q].score;
                            if sq < score_min {
                                break;
                            }
                            if sq > score_max || q <= p || q == v {
                                continue;
                            }
                            let (ex, ey) = (c[q].x - qx, c[q].y - qy);
                            if ex * ex + ey * ey > r * r {
                                continue;
                            }
                            // Cheap necessary tests before the exact one.
                            let (fx, fy) = (c[q].x - vx, c[q].y - vy);
                            let other = (fx * fx + fy * fy).sqrt();
                            if other < LEG_RATIO_MIN * leg || other > LEG_RATIO_MAX * leg {
                                continue;
                            }
                            if (dx * fx + dy * fy).abs() > MAX_COS * leg * other {
                                continue;
                            }
                            let mean = (leg + other) / 2.0;
                            let sum = pair + sq;
                            if mean < MEAN_LEG_PER_SCORE_MIN * sum || mean > MEAN_LEG_PER_SCORE_MAX * sum {
                                continue;
                            }
                            // Indices in increasing order: the test is evaluated
                            // on the triple in candidate order.
                            let lo = v.min(p).min(q);
                            let hi = v.max(p).max(q);
                            visit(lo, v + p + q - lo - hi, hi);
                        }
                    }
                }
            }
        }
    }
}

/// An accepted triple: candidate indices (i < j < k), error, ordered triplet.
#[derive(Debug, Clone, Copy)]
struct TripleFit {
    ijk: [usize; 3],
    error: f64,
    triplet: Triplet,
}

/// Total order of the choice: smallest error, then first triple in (i, j, k)
/// order — that of an exhaustive scan.
fn before(a: &TripleFit, b: &TripleFit) -> std::cmp::Ordering {
    a.error.total_cmp(&b.error).then(a.ijk.cmp(&b.ijk))
}

fn fit_of(c: &[MarkerCandidate], i: usize, j: usize, k: usize) -> Option<TripleFit> {
    evaluate_triple(&c[i], &c[j], &c[k]).map(|(triplet, error)| TripleFit { ijk: [i, j, k], error, triplet })
}

/// Chooses the L-shaped triplet (TL, TR, BL) closest to an isosceles right
/// triangle at the scale of the markers (first in candidate order on a tie).
pub fn choose_triplet(candidates: &[MarkerCandidate]) -> Option<Triplet> {
    let mut best: Option<TripleFit> = None;
    for_each_plausible_triple(candidates, |i, j, k| {
        if let Some(f) = fit_of(candidates, i, j, k) {
            if best.is_none_or(|b| before(&f, &b).is_lt()) {
                best = Some(f);
            }
        }
    });
    best.map(|f| f.triplet)
}

/// Every grid of a mosaic, one triangle after the other: the best triplet,
/// then the best one among the candidates that remain once every marker
/// INSIDE the grid found is discarded. Same result as `choose_triplet` called
/// again on the remaining candidates, but the triples are enumerated and
/// tested only ONCE: removing candidates changes neither the test of a triple
/// nor the order of two triples.
pub fn choose_triplets(candidates: &[MarkerCandidate], maximum: usize) -> Vec<Triplet> {
    let mut fits: Vec<TripleFit> = Vec::new();
    for_each_plausible_triple(candidates, |i, j, k| {
        if let Some(f) = fit_of(candidates, i, j, k) {
            fits.push(f);
        }
    });
    fits.sort_by(before);
    fits.dedup_by(|b, a| before(a, b).is_eq());
    let mut alive = vec![true; candidates.len()];
    let mut chosen: Vec<Triplet> = Vec::new();
    let mut cursor = 0;
    let n = GRID_SIZE as f64;
    while chosen.len() < maximum {
        while cursor < fits.len() && !fits[cursor].ijk.iter().all(|&i| alive[i]) {
            cursor += 1;
        }
        if cursor == fits.len() {
            break;
        }
        let triplet = fits[cursor].triplet;
        chosen.push(triplet);
        let Affine { a, b, c, d, e, f } = affine_from_triplet(triplet[0], triplet[1], triplet[2]);
        let det = a * d - b * c;
        for (k, live) in candidates.iter().zip(alive.iter_mut()) {
            let mx = (d * (k.x - e) - c * (k.y - f)) / det;
            let my = (a * (k.y - f) - b * (k.x - e)) / det;
            if !(mx < -2.0 || my < -2.0 || mx > n + 2.0 || my > n + 2.0) {
                *live = false;
            }
        }
    }
    chosen
}

// ── Affine transform and sampling ─────────────────────────────────────────

/// image = A · module + t, module in grid units (module center = integer + 0.5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

fn marker_center(i: usize) -> [f64; 2] {
    [MARKERS[i][0] as f64 + 0.5, MARKERS[i][1] as f64 + 0.5]
}

/// Solves the affine from three module → image correspondences.
pub fn affine_from_triplet(tl: [f64; 2], tr: [f64; 2], bl: [f64; 2]) -> Affine {
    let [mx0, my0] = marker_center(0);
    let [mx1, my1] = marker_center(1);
    let [mx2, my2] = marker_center(2);
    let det = (mx1 - mx0) * (my2 - my0) - (mx2 - mx0) * (my1 - my0);
    let ix0 = tl[0];
    let iy0 = tl[1];
    let dx1 = (tr[0] - ix0) / det;
    let dx2 = (bl[0] - ix0) / det;
    let dy1 = (tr[1] - iy0) / det;
    let dy2 = (bl[1] - iy0) / det;
    let a = dx1 * (mx1 - mx0) + dx2 * (mx2 - mx0);
    let c = dx1 * (my1 - my0) + dx2 * (my2 - my0);
    let b = dy1 * (mx1 - mx0) + dy2 * (mx2 - mx0);
    let d = dy1 * (my1 - my0) + dy2 * (my2 - my0);
    Affine {
        a,
        b,
        c,
        d,
        e: ix0 - a * mx0 - c * my0,
        f: iy0 - b * mx0 - d * my0,
    }
}

pub fn apply_affine(t: &Affine, x: f64, y: f64) -> [f64; 2] {
    [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f]
}

/// Mean RGB of a sample spot.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MeanRgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

/// Mean RGB of a disc of the given radius around an image point.
pub fn sample(image: &ImageRGBA, px: f64, py: f64, radius: f64) -> MeanRgb {
    if px.is_nan() || py.is_nan() || radius.is_nan() {
        return MeanRgb::default(); // as in TS: no iteration, n = 0
    }
    let mut r = 0u32;
    let mut g = 0u32;
    let mut b = 0u32;
    let mut n = 0u32;
    let x0 = (px - radius).floor().max(0.0);
    let x1 = ((image.width as f64) - 1.0).min((px + radius).ceil());
    let y0 = (py - radius).floor().max(0.0);
    let y1 = ((image.height as f64) - 1.0).min((py + radius).ceil());
    let r2 = radius * radius;
    let mut y = y0;
    while y <= y1 {
        let dy2 = (y - py) * (y - py);
        let base = y as usize * image.width;
        let mut x = x0;
        while x <= x1 {
            if (x - px) * (x - px) + dy2 <= r2 {
                let o = (base + x as usize) * 4;
                r += image.data[o] as u32;
                g += image.data[o + 1] as u32;
                b += image.data[o + 2] as u32;
                n += 1;
            }
            x += 1.0;
        }
        y += 1.0;
    }
    if n == 0 {
        return MeanRgb::default();
    }
    let n = n as f64;
    MeanRgb {
        r: r as f64 / n,
        g: g as f64 / n,
        b: b as f64 / n,
    }
}

// ── Full decoding ─────────────────────────────────────────────────────────

/// Decodes the data area of a captured image for a given codec.
pub fn decode_grid(
    image: &ImageRGBA,
    codec: Codec,
    options: &DecodeOptions,
) -> Result<DecodeResult, OpticsError> {
    let candidates = detect_markers(image, DetectionThreshold::Otsu);
    let triplet = choose_triplet(&candidates).ok_or(OpticsError::NotFound(
        "decoder: finder patterns not found",
    ))?;
    let affine = affine_from_triplet(triplet[0], triplet[1], triplet[2]);
    Ok(decode_with_affine(image, codec, &affine, options))
}

/// Variant with a known affine.
pub fn decode_with_affine(
    image: &ImageRGBA,
    codec: Codec,
    affine: &Affine,
    options: &DecodeOptions,
) -> DecodeResult {
    let palette = palette_for(codec);
    let nominal: Vec<Lab>;
    let centroids: &[Lab] = match options.palette {
        Some(p) => &p.centroids,
        None => {
            nominal = palette.iter().map(|&c| lab_of(c)).collect();
            &nominal
        }
    };
    let confidence_threshold = options.confidence_threshold.unwrap_or(0.1);
    let bits = bits_per_module(codec);
    let sample_size = 0.32; // radius of the sample spot, in modules

    let [m0x, m0y] = marker_center(0);
    let [m1x, m1y] = marker_center(1);
    let tl = apply_affine(affine, m0x, m0y);
    let tr = apply_affine(affine, m1x, m1y);
    let px_per_module = js::hypot(tr[0] - tl[0], tr[1] - tl[1]) / (GRID_SIZE - 7) as f64;
    let radius = 1f64.max(sample_size * px_per_module);

    let modules = data_modules();
    let mut sum_confidence = 0.0;
    let mut uncertain = 0usize;
    let mut stream: Vec<u8> = Vec::with_capacity(modules.len() * bits);
    for &[x, y] in modules {
        let [px, py] = apply_affine(affine, x as f64 + 0.5, y as f64 + 0.5);
        let c = sample(image, px, py, radius);
        let lab = rgb_to_lab([c.r, c.g, c.b]);
        let cl = classifier(&lab, centroids);
        sum_confidence += cl.confidence;
        if cl.confidence < confidence_threshold {
            uncertain += 1;
        }
        for b in (0..bits).rev() {
            stream.push(((cl.index >> b) & 1) as u8);
        }
    }
    let bytes = stream
        .chunks(8)
        .map(|piece| {
            let mut o = 0u8;
            for b in 0..8 {
                o = (o << 1) | piece.get(b).copied().unwrap_or(0);
            }
            o
        })
        .collect();
    let n = modules.len() as f64;
    DecodeResult {
        bytes,
        mean_confidence: if n > 0.0 { sum_confidence / n } else { 0.0 },
        uncertain_fraction: if n > 0.0 { uncertain as f64 / n } else { 0.0 },
    }
}
