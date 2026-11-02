//! Color calibration (§5.3, F-05): the test pattern is captured, each data
//! module is assigned to its nearest nominal class, and the REAL centroid of
//! each class is estimated in Lab.

use orp_core::Codec;

use crate::cielab::{classifier, rgb_to_lab, Lab};
use crate::decoder::{
    affine_from_triplet, apply_affine, choose_triplet, detect_markers, sample,
    Affine, CalibratedPalette, DetectionThreshold,
};
use crate::grid::{structural_grid, data_modules, role_of, ModuleRole, GRID_SIZE};
use crate::js;
use crate::palettes::palette_for;
use crate::render::ImageRGBA;
use crate::OpticsError;

/// Estimates the calibrated palette from the capture of a test pattern (`encode_test_pattern`).
pub fn calibrate(
    image: &ImageRGBA,
    codec: Codec,
    affine: Option<&Affine>,
) -> Result<CalibratedPalette, OpticsError> {
    let t = match affine {
        Some(a) => *a,
        None => {
            let triplet = choose_triplet(&detect_markers(image, DetectionThreshold::Otsu)).ok_or(
                OpticsError::NotFound(
                    "calibrate: finder patterns not found in the test pattern",
                ),
            )?;
            affine_from_triplet(triplet[0], triplet[1], triplet[2])
        }
    };
    let palette = palette_for(codec);
    let structure = structural_grid(codec);

    // Pixel/module scale: distance between the centers of the TL and TR markers.
    let p0 = apply_affine(&t, 3.5, 3.5);
    let p1 = apply_affine(&t, 37.5, 3.5);
    let radius = 1f64.max(0.32 * (js::hypot(p1[0] - p0[0], p1[1] - p0[1]) / 34.0));

    // ── Channel drift estimated on the PILOTS (§5.1): gain per channel.
    let mut gains = [1.0f64; 3];
    {
        let mut sum_sn = [0.0f64; 3];
        let mut sum_nn = [0.0f64; 3];
        for py in 0..GRID_SIZE {
            for px in 0..GRID_SIZE {
                if role_of(px, py) != ModuleRole::Pilot {
                    continue;
                }
                let nominal = palette[structure[py * GRID_SIZE + px] as usize];
                let [mx, my] = apply_affine(&t, px as f64 + 0.5, py as f64 + 0.5);
                let seen = sample(image, mx, my, radius);
                let seen_values = [seen.r, seen.g, seen.b];
                for c in 0..3 {
                    sum_sn[c] += seen_values[c] * nominal[c] as f64;
                    sum_nn[c] += nominal[c] as f64 * nominal[c] as f64;
                }
            }
        }
        for c in 0..3 {
            if sum_nn[c] > 0.0 {
                gains[c] = 1.6f64.min(0.4f64.max(sum_sn[c] / sum_nn[c]));
            }
        }
    }
    let initial: Vec<Lab> = palette
        .iter()
        .map(|c| {
            rgb_to_lab([
                c[0] as f64 * gains[0],
                c[1] as f64 * gains[1],
                c[2] as f64 * gains[2],
            ])
        })
        .collect();

    let mut sums = vec![(0.0f64, 0.0f64, 0.0f64, 0usize); initial.len()];
    let mut samples: Vec<Lab> = Vec::with_capacity(data_modules().len());
    for &[x, y] in data_modules() {
        let [px, py] = apply_affine(&t, x as f64 + 0.5, y as f64 + 0.5);
        let c = sample(image, px, py, radius);
        let lab = rgb_to_lab([c.r, c.g, c.b]);
        samples.push(lab);
        let s = &mut sums[classifier(&lab, &initial).index];
        s.0 += lab.l;
        s.1 += lab.a;
        s.2 += lab.b;
        s.3 += 1;
    }
    let mean = |s: &(f64, f64, f64, usize)| Lab {
        l: s.0 / s.3 as f64,
        a: s.1 / s.3 as f64,
        b: s.2 / s.3 as f64,
    };
    let mut centroids: Vec<Lab> = sums
        .iter()
        .map(|s| {
            if s.3 > 0 {
                mean(s)
            } else {
                Lab {
                    l: 0.0,
                    a: 0.0,
                    b: 0.0,
                }
            }
        })
        .collect();
    // A few Lloyd iterations.
    for _ in 0..3 {
        let mut recount = vec![(0.0f64, 0.0f64, 0.0f64, 0usize); centroids.len()];
        for lab in &samples {
            let r = &mut recount[classifier(lab, &centroids).index];
            r.0 += lab.l;
            r.1 += lab.a;
            r.2 += lab.b;
            r.3 += 1;
        }
        centroids = recount
            .iter()
            .zip(&centroids)
            .map(|(r, c)| if r.3 > 0 { mean(r) } else { *c })
            .collect();
    }
    // SELF-CONSISTENT confidence: margins against the ESTIMATED centroids.
    let mut sum_confidence = 0.0;
    for lab in &samples {
        sum_confidence += classifier(lab, &centroids).confidence;
    }
    let n = samples.len();
    Ok(CalibratedPalette {
        codec,
        centroids,
        confidence: if n > 0 {
            sum_confidence / n as f64
        } else {
            0.0
        },
    })
}

/// Validates a color mode over a series of trial images (§5.3-4): the
/// calibration of EACH image must reach the threshold (default 0.5).
pub fn validate_mode(
    codec: Codec,
    captures: &[ImageRGBA],
    affines: &[Option<Affine>],
    threshold: f64,
) -> Result<(bool, Vec<f64>), OpticsError> {
    let mut confidences = Vec::with_capacity(captures.len());
    for (i, img) in captures.iter().enumerate() {
        confidences.push(calibrate(img, codec, affines.get(i).and_then(|a| a.as_ref()))?.confidence);
    }
    let valid = !confidences.is_empty() && confidences.iter().all(|&c| c >= threshold);
    Ok((valid, confidences))
}
