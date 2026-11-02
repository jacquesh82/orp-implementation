//! Reed-Solomon over GF(256) (port of rs.ts) — primitive polynomial 0x11D,
//! α = 2, consecutive roots from α⁰, 8 parity bytes (corrects ≤ 4 errors per
//! slice). Systematic encoding by synthetic division: the message length is
//! free, the "shortened" code is implicit.

use std::sync::OnceLock;

use crate::errors::OrpError;

/// Parity bytes per slice.
pub const RS_PARITY: usize = 8;

struct Tables {
    exp: [u8; 512],
    log: [u8; 256],
    generator: [u8; RS_PARITY + 1],
}

#[allow(clippy::needless_range_loop)]
fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut x: u32 = 1;
        for i in 0..255 {
            exp[i] = x as u8;
            log[x as usize] = i as u8;
            x <<= 1;
            if x & 0x100 != 0 {
                x ^= 0x11d;
            }
        }
        for i in 255..512 {
            exp[i] = exp[i - 255];
        }
        // g(x) = ∏ (x − α^i), i = 0..7 — leading coefficient first.
        let mul = |a: u8, b: u8| -> u8 {
            if a == 0 || b == 0 {
                0
            } else {
                exp[log[a as usize] as usize + log[b as usize] as usize]
            }
        };
        let mut g: Vec<u8> = vec![1];
        for i in 0..RS_PARITY {
            let a = exp[i];
            let mut next_poly = vec![0u8; g.len() + 1];
            for k in 0..next_poly.len() {
                let x_term = if k < g.len() { g[k] } else { 0 }; // x·g — one degree up
                let a_term = if k > 0 { mul(a, g[k - 1]) } else { 0 }; // a·g — same degree
                next_poly[k] = x_term ^ a_term;
            }
            g = next_poly;
        }
        let mut generator = [0u8; RS_PARITY + 1];
        generator.copy_from_slice(&g);
        Tables { exp, log, generator }
    })
}

#[inline]
fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    let t = tables();
    t.exp[t.log[a as usize] as usize + t.log[b as usize] as usize]
}

fn div(a: u8, b: u8) -> Result<u8, OrpError> {
    if a == 0 {
        return Ok(0);
    }
    if b == 0 {
        return Err(OrpError::CorrectionImpossible);
    }
    let t = tables();
    Ok(t.exp[(t.log[a as usize] as usize + 255 - t.log[b as usize] as usize) % 255])
}

#[inline]
fn exp(i: usize) -> u8 {
    tables().exp[i]
}

/// Evaluates Σ poly[k]·x^k — constant term first (BM locator convention).
fn evaluate_constant(poly: &[u8], x: u8) -> u8 {
    let mut y = 0u8;
    for k in (0..poly.len()).rev() {
        y = mul(y, x) ^ poly[k];
    }
    y
}

/// Systematic 8-byte parity for the message (any length).
pub fn rs_parity(message: &[u8]) -> [u8; RS_PARITY] {
    let g = &tables().generator;
    let mut parity = [0u8; RS_PARITY];
    for &byte in message {
        let factor = byte ^ parity[0];
        parity.copy_within(1.., 0);
        parity[RS_PARITY - 1] = 0;
        if factor != 0 {
            for j in 0..RS_PARITY {
                parity[j] ^= mul(g[j + 1], factor);
            }
        }
    }
    parity
}

/// Appends the parity to the message.
pub fn protect(message: &[u8]) -> Vec<u8> {
    let mut t = Vec::with_capacity(message.len() + RS_PARITY);
    t.extend_from_slice(message);
    t.extend_from_slice(&rs_parity(message));
    t
}

/// Syndromes S_j = t(α^j), j = 0..7; the boolean tells whether any is non-zero.
fn syndromes(t: &[u8]) -> (bool, [u8; RS_PARITY]) {
    let mut s = [0u8; RS_PARITY];
    let mut non_zero = false;
    for (j, sj) in s.iter_mut().enumerate() {
        let a = exp(j);
        let mut v = 0u8;
        for &o in t {
            v = mul(v, a) ^ o;
        }
        *sj = v;
        non_zero |= v != 0;
    }
    (non_zero, s)
}

/// Error locator by Berlekamp-Massey.
fn locator(synd: &[u8; RS_PARITY]) -> Result<Vec<u8>, OrpError> {
    let mut loc: Vec<u8> = vec![1];
    let mut old: Vec<u8> = vec![1];
    let mut l = 0usize;
    let mut m = 1usize;
    let mut b = 1u8;
    for n in 0..synd.len() {
        let mut delta = synd[n];
        for i in 1..=l {
            let li = loc.get(i).copied().unwrap_or(0);
            let si = if n >= i { synd[n - i] } else { 0 };
            delta ^= mul(li, si);
        }
        if delta == 0 {
            m += 1;
            continue;
        }
        let coef = div(delta, b)?;
        let mut shifted = vec![0u8; m];
        shifted.extend_from_slice(&old);
        let size = loc.len().max(shifted.len());
        let mut next_poly = vec![0u8; size];
        for (i, s) in next_poly.iter_mut().enumerate() {
            *s = loc.get(i).copied().unwrap_or(0) ^ mul(coef, shifted.get(i).copied().unwrap_or(0));
        }
        if 2 * l <= n {
            old = std::mem::replace(&mut loc, next_poly);
            b = delta;
            l = n + 1 - l;
            m = 1;
        } else {
            loc = next_poly;
            m += 1;
        }
    }
    while loc.len() > 1 && *loc.last().unwrap() == 0 {
        loc.pop();
    }
    Ok(loc)
}

/// Corrects the slice in place (message ‖ parity). `Err(CorrectionImpossible)`
/// if more than 4 bytes are wrong: the frame becomes an erasure again for the
/// fountain decoder, never a silent corruption.
pub fn correct_rs(t: &mut [u8]) -> Result<(), OrpError> {
    let (non_zero, s) = syndromes(t);
    if !non_zero {
        return Ok(());
    }
    let loc = locator(&s)?;
    let degree = loc.len() - 1;
    if degree == 0 || degree > RS_PARITY / 2 {
        return Err(OrpError::CorrectionImpossible);
    }
    // Chien search: position i carries the term x^(N-1-i), with locator
    // X_i = α^(N-1-i); it is in error ⇔ σ(X_i^-1) = 0.
    let n = t.len();
    let mut positions = Vec::new();
    for i in 0..n {
        let exponent = (n - 1 - i) % 255;
        if evaluate_constant(&loc, exp((255 - exponent) % 255)) == 0 {
            positions.push(i);
        }
    }
    if positions.len() != degree {
        return Err(OrpError::CorrectionImpossible);
    }
    // Error evaluator Ω(x) = (S(x)·σ(x)) mod x^8.
    let mut omega = [0u8; RS_PARITY];
    for (i, &li) in loc.iter().enumerate() {
        for j in 0..RS_PARITY {
            if i + j < RS_PARITY {
                omega[i + j] ^= mul(li, s[j]);
            }
        }
    }
    for &i in &positions {
        let exponent = (n - 1 - i) % 255;
        let x_inv = exp((255 - exponent) % 255); // X_i^-1
        // Y_i = X_i·Ω(X_i^-1) / Λ'(X_i^-1), Λ'(x) = Σ_{k odd} Λ_k·x^(k-1).
        let mut num = 0u8;
        let mut p = 1u8;
        for &o in &omega {
            num ^= mul(o, p);
            p = mul(p, x_inv);
        }
        num = mul(num, exp(exponent)); // factor X_i^(1-fcr), fcr = 0
        let mut den = 0u8;
        p = 1;
        let x_inv_squared = mul(x_inv, x_inv);
        let mut k = 1;
        while k < loc.len() {
            den ^= mul(loc[k], p);
            p = mul(p, x_inv_squared);
            k += 2;
        }
        if den == 0 {
            return Err(OrpError::CorrectionImpossible);
        }
        t[i] ^= div(num, den)?;
    }
    // Check: the syndromes must be back to zero, otherwise give up.
    if syndromes(t).0 {
        return Err(OrpError::CorrectionImpossible);
    }
    Ok(())
}
