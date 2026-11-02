//! Camera capture simulation — acceptance instrument (§10.1): rotation,
//! scale, translation, perspective, color matrix, hue, veil, blur, Gaussian
//! noise. Deterministic (seed). This is NOT a validation on real hardware:
//! it is the base that lets the pipeline be tested beforehand.

use orp_core::Mulberry32;

use crate::js;
use crate::palettes::RgbColor;
use crate::render::{render, ImageRGBA, RenderOptions};

#[derive(Debug, Clone, PartialEq)]
pub struct SimulationOptions {
    /// Global scale factor (default 1).
    pub scale: f64,
    /// Rotation in degrees (default 0).
    pub rotation_degrees: f64,
    /// Translation in pixels (default [0, 0]).
    pub translation: [f64; 2],
    /// Per-channel gains — the hue of the screen/camera pair (default [1, 1, 1]).
    pub gains: [f64; 3],
    /// Box blur radius (default 0).
    pub blur: usize,
    /// Standard deviation of the Gaussian noise per channel (default 0).
    pub noise: f64,
    /// Noise seed (default 42).
    pub seed: u32,
    /// Pixels per module of the source rendering (default 8).
    pub module_size: usize,
    /// Perspective (keystone): projective coefficients [p, q] relative to the image half-size.
    pub perspective: [f64; 2],
    /// 3×3 screen→camera color matrix (crosstalk), applied before the gains.
    pub matrix: Option<[[f64; 3]; 3]>,
    /// Additive veil per channel, after the gains.
    pub veil: [f64; 3],
}

impl Default for SimulationOptions {
    fn default() -> Self {
        Self {
            scale: 1.0,
            rotation_degrees: 0.0,
            translation: [0.0, 0.0],
            gains: [1.0, 1.0, 1.0],
            blur: 0,
            noise: 0.0,
            seed: 42,
            module_size: 8,
            perspective: [0.0, 0.0],
            matrix: None,
            veil: [0.0, 0.0, 0.0],
        }
    }
}

/// Renders the grid then degrades it like a real capture.
pub fn simulate_capture(
    grid: &[u8],
    palette: &[RgbColor],
    options: &SimulationOptions,
) -> ImageRGBA {
    degrade_image(
        &render(
            grid,
            palette,
            &RenderOptions {
                module_size: options.module_size,
                quiet_zone: 2,
            },
        ),
        options,
    )
}

/// Degrades an ALREADY rendered image (a mosaic, for instance).
pub fn degrade_image(base: &ImageRGBA, options: &SimulationOptions) -> ImageRGBA {
    let scale = options.scale;
    let angle = (options.rotation_degrees * std::f64::consts::PI) / 180.0;
    let cos = angle.cos() / scale;
    let sin = angle.sin() / scale;
    let [tx, ty] = options.translation;
    let gains = options.gains;
    let [pp, pq] = options.perspective;
    let veil = options.veil;
    let (bl, bh) = (base.width, base.height);
    let src = &base.data;

    // Inverse resampling: each output pixel reads back the source.
    let mut output = vec![0u8; src.len()];
    let cx = bl as f64 / 2.0;
    let cy = bh as f64 / 2.0;
    for y in 0..bh {
        for x in 0..bl {
            let dx = x as f64 - cx - tx;
            let dy = y as f64 - cy - ty;
            let mut fx = cx + dx * cos + dy * sin;
            let mut fy = cy - dx * sin + dy * cos;
            if pp != 0.0 || pq != 0.0 {
                // Centered homography: w = 1 + p·u + q·v (u, v ∈ [−1, 1]).
                let w = 1.0 + (pp * (fx - cx)) / cx + (pq * (fy - cy)) / cy;
                fx = cx + (fx - cx) / w;
                fy = cy + (fy - cy) / w;
            }
            let o = (y * bl + x) * 4;
            if fx.is_nan() || fy.is_nan() {
                // TS: NaN indices → `undefined` reads → NaN channels → 0.
                output[o..o + 3].fill(0);
                output[o + 3] = 255;
                continue;
            }
            if !(fx >= 0.0 && fy >= 0.0 && fx < (bl - 1) as f64 && fy < (bh - 1) as f64) {
                output[o..o + 4].fill(255);
                continue;
            }
            // Bilinear interpolation.
            let x0 = fx.floor() as usize;
            let y0 = fy.floor() as usize;
            let ax = fx - x0 as f64;
            let ay = fy - y0 as f64;
            let i00 = (y0 * bl + x0) * 4;
            let i01 = ((y0 + 1) * bl + x0) * 4;
            let mut raw = [0f64; 3];
            for channel in 0..3 {
                let p00 = src[i00 + channel] as f64;
                let p10 = src[i00 + 4 + channel] as f64;
                let p01 = src[i01 + channel] as f64;
                let p11 = src[i01 + 4 + channel] as f64;
                let top = p00 + ax * (p10 - p00);
                let bottom = p01 + ax * (p11 - p01);
                raw[channel] = top + ay * (bottom - top);
            }
            for channel in 0..3 {
                let shuffle = match &options.matrix {
                    Some(m) => {
                        m[channel][0] * raw[0] + m[channel][1] * raw[1] + m[channel][2] * raw[2]
                    }
                    None => raw[channel],
                };
                output[o + channel] = js::clamp_u8(shuffle * gains[channel] + veil[channel]);
            }
            output[o + 3] = 255;
        }
    }

    let mut image = ImageRGBA {
        width: bl,
        height: bh,
        data: output,
    };
    if options.blur > 0 {
        image = blur_image(&image, options.blur);
    }
    if options.noise > 0.0 {
        gaussian_noise(&mut image, options.noise, options.seed);
    }
    image
}

/// Box blur of integer radius (exact integer sum: same mean as the TS).
fn blur_image(image: &ImageRGBA, radius: usize) -> ImageRGBA {
    let (width, height) = (image.width, image.height);
    let src = &image.data;
    let mut output = vec![0u8; src.len()];
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius).min(height - 1);
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(width - 1);
            let n = ((y1 - y0 + 1) * (x1 - x0 + 1)) as f64;
            let mut sum = [0u32; 3];
            for sy in y0..=y1 {
                for sx in x0..=x1 {
                    let o = (sy * width + sx) * 4;
                    sum[0] += src[o] as u32;
                    sum[1] += src[o + 1] as u32;
                    sum[2] += src[o + 2] as u32;
                }
            }
            let o = (y * width + x) * 4;
            for c in 0..3 {
                output[o + c] = js::clamp_u8(sum[c] as f64 / n);
            }
            output[o + 3] = 255;
        }
    }
    ImageRGBA {
        width,
        height,
        data: output,
    }
}

/// Gaussian noise (Box-Muller over mulberry32), in place.
fn gaussian_noise(image: &mut ImageRGBA, sigma: f64, seed: u32) {
    let mut rng = Mulberry32::new(seed);
    let mut next_gaussian = || {
        let u = 1e-9f64.max(rng.next_f64());
        let v = rng.next_f64();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    };
    for p in image.data.as_chunks_mut::<4>().0.iter_mut() {
        for c in 0..3 {
            p[c] = js::clamp_u8(p[c] as f64 + next_gaussian() * sigma);
        }
        p[3] = 255;
    }
}
