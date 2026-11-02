//! CIELAB space (D65/2°) — ΔE76 (Euclidean) distance, classification with a
//! confidence margin (§5.3).

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

fn srgb_to_linear(c: f64) -> f64 {
    let v = c / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn f(t: f64) -> f64 {
    let threshold = 216.0 / 24389.0;
    if t > threshold {
        t.cbrt()
    } else {
        (24389.0 / 27.0 * t + 16.0) / 116.0
    }
}

/// sRGB (0..255, real values allowed) → Lab.
pub fn rgb_to_lab([r, g, b]: [f64; 3]) -> Lab {
    let rl = srgb_to_linear(r);
    let gl = srgb_to_linear(g);
    let bl = srgb_to_linear(b);
    // XYZ D65 (linear sRGB → XYZ, standard matrix).
    let x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
    let y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
    let z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041;
    // D65 reference white.
    let fx = f(x / 0.95047);
    let fy = f(y / 1.0);
    let fz = f(z / 1.08883);
    Lab {
        l: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
    }
}

/// Lab of a palette color.
pub fn lab_of(c: [u8; 3]) -> Lab {
    rgb_to_lab([c[0] as f64, c[1] as f64, c[2] as f64])
}

/// ΔE76 — Euclidean distance in Lab.
pub fn distance_lab(a: &Lab, b: &Lab) -> f64 {
    let dl = a.l - b.l;
    let da = a.a - b.a;
    let db = a.b - b.b;
    (dl * dl + da * da + db * db).sqrt()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Classification {
    pub index: usize,
    /// (d2 − d1) / (d2 + d1) ∈ [0, 1] — relative margin between the two nearest classes.
    pub confidence: f64,
}

/// Nearest class among the centroids, with its confidence margin.
pub fn classifier(color: &Lab, centroids: &[Lab]) -> Classification {
    let mut best_fit = 0;
    let mut d1 = f64::INFINITY;
    let mut d2 = f64::INFINITY;
    for (i, c) in centroids.iter().enumerate() {
        let d = distance_lab(color, c);
        if d < d1 {
            d2 = d1;
            d1 = d;
            best_fit = i;
        } else if d < d2 {
            d2 = d;
        }
    }
    let sum = d1 + d2;
    Classification {
        index: best_fit,
        confidence: if sum > 0.0 { (d2 - d1) / sum } else { 0.0 },
    }
}
