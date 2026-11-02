//! JavaScript numeric semantics, where they differ from Rust: the port must
//! produce the SAME pixels and the SAME bytes as the TypeScript.
//!
//! - V8's `Math.hypot` (Kahan compensated sum, then scaling) — `f64::hypot`
//!   (libm) differs in the last bit one time in three;
//! - `Math.round` (half toward +∞, without the error of `floor(x + 0.5)`);
//! - writing into a `Uint8ClampedArray` (round half to even, bounds 0..255);
//! - V8's `Array.prototype.sort` (TimSort; binary insertion under 64
//!   elements) — reproduced exactly, including with a non-transitive
//!   comparator (sorting grids into rows then columns).

/// V8's `Math.hypot(a, b)`, bit for bit.
#[inline]
pub fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = a.max(b);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in [a, b] {
        let n = v / max;
        let term = n * n - compensation;
        let preliminary = sum + term;
        compensation = (preliminary - sum) - term;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.round(x)`: half toward +∞.
#[inline]
pub fn round(x: f64) -> f64 {
    let r = x.floor();
    if x - r >= 0.5 {
        r + 1.0
    } else {
        r
    }
}

/// Assignment into a `Uint8ClampedArray` (ToUint8Clamp).
#[inline]
pub fn clamp_u8(x: f64) -> u8 {
    if x.is_nan() || x <= 0.0 {
        0
    } else if x >= 255.0 {
        255
    } else {
        x.round_ties_even() as u8
    }
}

/// `Math.min(...values)` (+∞ for an empty list).
pub fn min(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = f64::INFINITY;
    for v in values {
        if v.is_nan() {
            return f64::NAN;
        }
        if v < m {
            m = v;
        }
    }
    m
}

/// "Upper" median of a numeric sort (`t[t.length >> 1]`), 0 if empty.
pub fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut t = values.to_vec();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    t[t.len() >> 1]
}

/// V8's `array.sort(comparator)`. The comparator returns a number: < 0 puts
/// `a` before `b`; NaN counts as 0.
pub fn sort<T, F: FnMut(&T, &T) -> f64>(v: &mut [T], mut compare: F) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let mut cmp = |a: &T, b: &T| {
        let r = compare(a, b);
        if r.is_nan() {
            0.0
        } else {
            r
        }
    };
    if n >= 64 {
        // Beyond that, V8 merges runs: identical to any STABLE sort as long as
        // the comparator is consistent — which is the case for our large
        // sorts (activities, numeric values).
        v.sort_by(|a, b| {
            let r = cmp(a, b);
            if r < 0.0 {
                std::cmp::Ordering::Less
            } else if r > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        return;
    }
    // CountAndMakeRun: initial run, ascending or strictly descending.
    let mut length = 2;
    let descending = cmp(&v[1], &v[0]) < 0.0;
    let mut i = 2;
    while i < n {
        let order = cmp(&v[i], &v[i - 1]);
        if descending {
            if order >= 0.0 {
                break;
            }
        } else if order < 0.0 {
            break;
        }
        length += 1;
        i += 1;
    }
    if descending {
        v[..length].reverse();
    }
    // BinaryInsertionSort of the rest (minRun = n under 64 elements).
    for start in length..n {
        let mut left = 0;
        let mut right = start;
        while left < right {
            let middle = left + ((right - left) >> 1);
            if cmp(&v[start], &v[middle]) < 0.0 {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        v[left..=start].rotate_right(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_and_bounds() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(clamp_u8(2.5), 2);
        assert_eq!(clamp_u8(3.5), 4);
        assert_eq!(clamp_u8(-3.0), 0);
        assert_eq!(clamp_u8(300.0), 255);
        assert_eq!(clamp_u8(f64::NAN), 0);
    }

    #[test]
    fn stable_descending_sort() {
        let mut v = vec![(3, 'a'), (1, 'b'), (3, 'c'), (2, 'd'), (1, 'e')];
        sort(&mut v, |a, b| (a.0 - b.0) as f64);
        assert_eq!(v, vec![(1, 'b'), (1, 'e'), (2, 'd'), (3, 'a'), (3, 'c')]);
        let mut w = vec![5, 4, 3, 9, 1];
        sort(&mut w, |a, b| (*a - *b) as f64);
        assert_eq!(w, vec![1, 3, 4, 5, 9]);
    }
}
