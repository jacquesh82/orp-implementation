//! Choice of the marker triplets: the pruned enumeration (decoder.rs) must
//! give EXACTLY the result of the former exhaustive scan over every triple —
//! kept here as the reference — and stay fast on large mosaics (same tests as
//! packages/optical/test/triplet-choice.spec.ts).

mod common;

use std::time::Instant;

use common::*;
use orp_core::{Codec, Mulberry32};
use orp_optics::grid::GRID_SIZE;
use orp_optics::location::MAX_GRIDS;
use orp_optics::*;

/// VERBATIM copy of the former exhaustive O(n³) choose_triplet — the reference.
fn reference_choose_triplet(candidates: &[MarkerCandidate]) -> Option<Triplet> {
    let mut best_fit: Option<(Triplet, f64)> = None;
    let d = |p: &MarkerCandidate, q: &MarkerCandidate| js::hypot(p.x - q.x, p.y - q.y);
    for i in 0..candidates.len() {
        for j in i + 1..candidates.len() {
            for k in j + 1..candidates.len() {
                let pts = [&candidates[i], &candidates[j], &candidates[k]];
                // A module smaller than 5 px cannot be decoded.
                let side1 = js::hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                let side2 = js::hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y);
                if side1.min(side2) / 34.0 < 5.0 {
                    continue;
                }
                // (length, opposite vertex), sorted by descending length (stable sort).
                let mut sides = [
                    (d(pts[1], pts[2]), 0usize),
                    (d(pts[0], pts[2]), 1),
                    (d(pts[0], pts[1]), 2),
                ];
                js::sort(&mut sides, |a, b| b.0 - a.0);
                let hypotenuse = sides[0].0;
                let c1 = sides[1].0;
                let c2 = sides[2].0;
                let pythagoras_error = (hypotenuse * hypotenuse - (c1 * c1 + c2 * c2)).abs()
                    / (hypotenuse * hypotenuse);
                let isosceles_error = (c1 - c2).abs() / c1.max(c2);
                let error = pythagoras_error + isosceles_error;
                if pythagoras_error > 0.15 || isosceles_error > 0.2 {
                    continue;
                }
                let opposite = sides[0].1;
                // Scale consistency: module size of the triangle (side / 34)
                // against the one the markers measure (horizontal pattern of
                // 7 modules / max(|cos θ|, |sin θ|)).
                {
                    let vertex = pts[opposite];
                    let other = pts[(0..3).find(|&idx| idx != opposite).unwrap()];
                    let theta = (other.y - vertex.y).atan2(other.x - vertex.x);
                    let tilt = theta.cos().abs().max(theta.sin().abs());
                    let marker_module =
                        ((pts[0].score + pts[1].score + pts[2].score) / 21.0) * tilt;
                    let module_triangle = (c1 + c2) / 2.0 / 34.0;
                    if (module_triangle / marker_module - 1.0).abs() > 0.18 {
                        continue;
                    }
                }
                if best_fit.is_none_or(|(_, e)| error < e) {
                    // TL = vertex opposite the hypotenuse; TR / BL from the sign
                    // of the cross product (image frame, y pointing down).
                    let vertex = pts[opposite];
                    let others: Vec<&MarkerCandidate> = (0..3)
                        .filter(|&idx| idx != opposite)
                        .map(|idx| pts[idx])
                        .collect();
                    let (p, q) = (others[0], others[1]);
                    let cross =
                        (p.x - vertex.x) * (q.y - vertex.y) - (p.y - vertex.y) * (q.x - vertex.x);
                    let (tr, bl) = if cross > 0.0 { (p, q) } else { (q, p) };
                    best_fit = Some(([[vertex.x, vertex.y], [tr.x, tr.y], [bl.x, bl.y]], error));
                }
            }
        }
    }
    best_fit.map(|(t, _)| t)
}


/// The former greedy loop of locate_from_candidates, on the reference choice.
fn reference_choose_triplets(candidates: &[MarkerCandidate], maximum: usize) -> Vec<Triplet> {
    let mut remaining = candidates.to_vec();
    let mut chosen = Vec::new();
    let n = GRID_SIZE as f64;
    while chosen.len() < maximum {
        let Some(triplet) = reference_choose_triplet(&remaining) else {
            break;
        };
        chosen.push(triplet);
        let Affine { a, b, c, d, e, f } = affine_from_triplet(triplet[0], triplet[1], triplet[2]);
        let det = a * d - b * c;
        remaining.retain(|k| {
            let mx = (d * (k.x - e) - c * (k.y - f)) / det;
            let my = (a * (k.y - f) - b * (k.x - e)) / det;
            mx < -2.0 || my < -2.0 || mx > n + 2.0 || my > n + 2.0
        });
    }
    chosen
}

fn shuffle(rng: &mut Mulberry32, v: &mut [MarkerCandidate]) {
    for i in (1..v.len()).rev() {
        let j = (rng.next_f64() * (i + 1) as f64).floor() as usize;
        v.swap(i, j);
    }
}

/// Triangles drawn AROUND the acceptance limits (angle, legs ratio, scale).
fn border_candidates(rng: &mut Mulberry32) -> Vec<MarkerCandidate> {
    let mut out = Vec::new();
    let triangles = 1 + (rng.next_f64() * 2.0).floor() as usize;
    for _ in 0..triangles {
        let (vx, vy) = (rng.next_f64() * 1000.0, rng.next_f64() * 1000.0);
        // A third of the legs near the 5 px/module floor (170 px).
        let leg = if rng.next_f64() < 0.33 { 125.0 + rng.next_f64() * 75.0 } else { 120.0 + rng.next_f64() * 500.0 };
        let phi = rng.next_f64() * 2.0 * std::f64::consts::PI;
        let lambda = 0.7 + rng.next_f64() * 0.65;
        let delta = (rng.next_f64() - 0.5) * 32f64.to_radians();
        let side = if rng.next_f64() < 0.5 { 1.0 } else { -1.0 };
        let psi = phi + side * (std::f64::consts::FRAC_PI_2 + delta);
        let tilt = phi.cos().abs().max(phi.sin().abs());
        let marker_module = leg * (1.0 + lambda) / 2.0 / 34.0 / (0.75 + rng.next_f64() * 0.5);
        let sum = 21.0 * marker_module / tilt;
        let w = [0.2 + rng.next_f64(), 0.2 + rng.next_f64(), 0.2 + rng.next_f64()];
        let total = w[0] + w[1] + w[2];
        let points = [
            (vx, vy),
            (vx + leg * phi.cos(), vy + leg * phi.sin()),
            (vx + lambda * leg * psi.cos(), vy + lambda * leg * psi.sin()),
        ];
        for (i, (x, y)) in points.into_iter().enumerate() {
            out.push(MarkerCandidate { x, y, score: (sum * w[i] / total).max(1.0) });
        }
    }
    let extra = (rng.next_f64() * 4.0).floor() as usize;
    for _ in 0..extra {
        let (x, y) = (rng.next_f64() * 1000.0, rng.next_f64() * 1000.0);
        out.push(MarkerCandidate { x, y, score: 14.0 + rng.next_f64() * 150.0 });
    }
    shuffle(rng, &mut out);
    out
}

/// Markers of synthetic grids, each detected 1 to 3 times, plus noise.
fn mosaic_candidates(rng: &mut Mulberry32, grids: usize, noise: usize) -> Vec<MarkerCandidate> {
    let mut out = Vec::new();
    for _ in 0..grids {
        let u = 4.5 + rng.next_f64() * 8.0;
        let theta = rng.next_f64() * 2.0 * std::f64::consts::PI;
        let (ox, oy) = (rng.next_f64() * 1600.0, rng.next_f64() * 1600.0);
        let tilt = theta.cos().abs().max(theta.sin().abs());
        for (mx, my) in [(3.5, 3.5), (37.5, 3.5), (3.5, 37.5)] {
            let x = ox + u * (mx * theta.cos() - my * theta.sin());
            let y = oy + u * (mx * theta.sin() + my * theta.cos());
            let copies = 1 + (rng.next_f64() * 3.0).floor() as usize;
            for _ in 0..copies {
                let (jx, jy) = ((rng.next_f64() - 0.5) * 1.2, (rng.next_f64() - 0.5) * 1.2);
                let score = (7.0 * u / tilt * (0.9 + 0.2 * rng.next_f64())).round();
                out.push(MarkerCandidate { x: x + jx, y: y + jy, score });
            }
        }
    }
    for _ in 0..noise {
        let (x, y) = (rng.next_f64() * 2000.0, rng.next_f64() * 2000.0);
        out.push(MarkerCandidate { x, y, score: 14.0 + (rng.next_f64() * 186.0).floor() });
    }
    shuffle(rng, &mut out);
    out
}

#[test]
fn triplet_choice_around_the_acceptance_limits() {
    let mut rng = Mulberry32::new(11);
    let mut accepted = 0;
    for _ in 0..4000 {
        let c = border_candidates(&mut rng);
        let expected = reference_choose_triplet(&c);
        accepted += expected.is_some() as usize;
        assert_eq!(choose_triplet(&c), expected);
        assert_eq!(choose_triplets(&c, 49), reference_choose_triplets(&c, 49));
    }
    assert!(accepted > 400 && accepted < 3600, "{accepted} accepted");
}

#[test]
fn triplet_choice_random_mosaics() {
    let mut rng = Mulberry32::new(12);
    for _ in 0..120 {
        let grids = 1 + (rng.next_f64() * 6.0).floor() as usize;
        let noise = (rng.next_f64() * 40.0).floor() as usize;
        let c = mosaic_candidates(&mut rng, grids, noise);
        assert_eq!(choose_triplet(&c), reference_choose_triplet(&c));
        assert_eq!(choose_triplets(&c, 49), reference_choose_triplets(&c, 49));
    }
}

fn channel(seed: u32) -> SimulationOptions {
    SimulationOptions { rotation_degrees: 4.0, scale: 0.92, gains: [1.2, 0.85, 1.1], noise: 5.0, seed, ..Default::default() }
}

fn mosaic(columns: usize) -> (Vec<Vec<u8>>, ImageRGBA, ImageRGBA) {
    let frames: Vec<Vec<u8>> = (0..(columns * columns) as u32).map(|i| mosaic_frame(Codec::Color8, 100 + i)).collect();
    let o = RenderOptions { module_size: 7, quiet_zone: 2 };
    let r: Vec<Vec<u8>> = frames.iter().map(|t| reference_subframe(t, Codec::Color8).unwrap()).collect();
    let p: Vec<Vec<u8>> = frames.iter().map(|t| payload_subframe(t, Codec::Color8).unwrap()).collect();
    let img_r = degrade_image(&render_mosaic(&r, &PALETTE_TM, columns, &o), &channel(1));
    let img_p = degrade_image(&render_mosaic(&p, &PALETTE_TM, columns, &o), &channel(2));
    (frames, img_r, img_p)
}

#[test]
fn triplet_choice_real_detections_3x3_p() {
    let (_, _, img_p) = mosaic(3);
    for threshold in [DetectionThreshold::Otsu, DetectionThreshold::Local] {
        let c = detect_markers(&img_p, threshold);
        assert!(c.len() > 80);
        let expected = reference_choose_triplets(&c, 49);
        assert_eq!(expected.len(), 9);
        assert_eq!(choose_triplets(&c, 49), expected);
        assert_eq!(choose_triplet(&c), Some(expected[0]));
    }
}

/// Measured (P subframe, i5-13600K), release / debug: 5×5 ≈ 75 / 330 ms,
/// 7×7 ≈ 170 / 700 ms — against 2.6 s (release) for 5×5 with the former
/// exhaustive choice. Bounds hold in debug with a wide margin.
#[test]
fn large_mosaics_located_and_decoded_in_bounded_time() {
    for (columns, bound) in [(5usize, 1500.0), (7, 3000.0)] {
        let n = columns * columns;
        let (frames, img_r, img_p) = mosaic(columns);
        let locs_r = locate_all(&img_r, Some(TM_ALIGNMENT), MAX_GRIDS);
        assert_eq!(locs_r.len(), n, "{columns}×{columns} R");
        let t0 = Instant::now();
        let locs_p = locate_all(&img_p, Some(TM_ALIGNMENT), MAX_GRIDS);
        let elapsed = t0.elapsed().as_secs_f64() * 1e3;
        assert_eq!(locs_p.len(), n, "{columns}×{columns} P");
        assert!(elapsed < bound, "{columns}×{columns}: locate_all(P) {elapsed:.0} ms ≥ {bound} ms");
        let mut receiver = TmMosaicReceiver::default();
        receiver.process(&img_r, &locs_r, 0.0);
        let decoded: Vec<Vec<u8>> = receiver
            .process(&img_p, &locs_p, 250.0)
            .into_iter()
            .filter_map(|x| x.frame.map(|t| t.bytes))
            .collect();
        assert_eq!(decoded.len(), n, "{columns}×{columns} decoded");
        for (t, d) in frames.iter().zip(&decoded) {
            assert_eq!(&d[..t.len()], &t[..]);
        }
    }
}
