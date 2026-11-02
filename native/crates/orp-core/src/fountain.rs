//! LT fountain code (port of fountain.ts) — recovery of lost frames.
//!
//! The seeds, the degree distribution (robust soliton) and the neighbor draw
//! (partial shuffle) are FROZEN by docs/orp-protocol-v0.1.md: sender and
//! receiver must draw the same neighbors from the same seed. The logarithm
//! comes from `libm` (fdlibm, like V8's `Math.log`) so that the cumulative
//! distribution function is bit-identical.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use crate::random::Mulberry32;
use crate::errors::OrpError;
use crate::frames::{K_MAX, SYMBOL_SIZE};

const PARAMETER_C: f64 = 0.1;
const PARAMETER_DELTA: f64 = 0.5;

/// JavaScript's `Math.round`: the nearest integer, halves toward +∞.
fn js_rounding(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// Cumulative distribution function of the robust soliton distribution for K
/// (indexed loops kept as they are: the order of the floating-point sums must
/// stay the TS one).
#[allow(clippy::needless_range_loop)]
fn cdf_soliton(k: usize) -> Arc<Vec<f64>> {
    static CACHE: OnceLock<Mutex<HashMap<usize, Arc<Vec<f64>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(c) = cache.lock().unwrap().get(&k) {
        return c.clone();
    }
    let kf = k as f64;
    let r = js_rounding(PARAMETER_C * kf.sqrt() * libm::log(kf / PARAMETER_DELTA)).max(1.0);
    let mut mu = vec![0f64; k + 1];
    let mut z = 0f64;
    for i in 1..=k {
        let fi = i as f64;
        let rho = if i == 1 { 1.0 / kf } else { 1.0 / (fi * (fi - 1.0)) };
        let tau = if fi < r {
            r / (fi * kf)
        } else if fi == r {
            (r * libm::log(r / PARAMETER_DELTA)) / kf
        } else {
            0.0
        };
        mu[i] = rho + tau;
        z += mu[i];
    }
    let mut cdf = vec![0f64; k + 1];
    let mut accumulation = 0f64;
    for i in 1..=k {
        accumulation += mu[i] / z;
        cdf[i] = accumulation;
    }
    cdf[k] = 1.0;
    let cdf = Arc::new(cdf);
    cache.lock().unwrap().insert(k, cdf.clone());
    cdf
}

fn draw_degree(rng: &mut Mulberry32, cdf: &[f64]) -> usize {
    let u = rng.next_f64();
    for (i, &c) in cdf.iter().enumerate().skip(1) {
        if u <= c {
            return i;
        }
    }
    cdf.len() - 1
}

/// LT neighbors of a seed — partial Fisher-Yates shuffle, frozen:
/// d = draw from the robust soliton, then d distinct indices among 0..K−1.
pub fn lt_neighbors(k: usize, seed: u32) -> Vec<u32> {
    let mut rng = Mulberry32::new(seed);
    let d = k.min(draw_degree(&mut rng, &cdf_soliton(k)));
    let mut tab: Vec<u32> = (0..k as u32).collect();
    for j in 0..d {
        let r = j + (rng.next_f64() * (k - j) as f64).floor() as usize;
        tab.swap(j, r);
    }
    tab.truncate(d);
    tab
}

fn exclusive_or(destination: &mut [u8], source: &[u8]) {
    for (c, s) in destination.iter_mut().zip(source) {
        *c ^= s;
    }
}

/// Fountain symbol of a seed: XOR of the selected source symbols.
pub fn fountain_symbol<S: AsRef<[u8]>>(sources: &[S], k: usize, seed: u32) -> Result<Vec<u8>, OrpError> {
    if sources.len() != k {
        return Err(OrpError::Other(format!("fountain: {} symbols provided, K = {k}", sources.len())));
    }
    let mut s = vec![0u8; SYMBOL_SIZE];
    for i in lt_neighbors(k, seed) {
        exclusive_or(&mut s, sources[i as usize].as_ref());
    }
    Ok(s)
}

/// Pending equation: XOR of the still unknown `neighbors` symbols = `data`.
struct Waiting {
    neighbors: BTreeSet<u32>,
    data: Vec<u8>,
}

/// Fountain decoder for a block of K symbols — peeling kept up to date by an
/// inverted index neighbor → pending equations, taken over by a Gaussian
/// elimination over GF(2) when peeling stalls while there are at least as
/// many equations as unknowns.
///
/// Equations live in an arena; their ids grow with arrival, so sets ordered
/// by id walk the equations in insertion order, like the TS `Set`s.
pub struct FountainDecoder {
    k: usize,
    solved: Vec<Option<Vec<u8>>>,
    seen_seeds: HashSet<u32>,
    waits: Vec<Waiting>,
    neighbor_index: HashMap<u32, BTreeSet<usize>>,
    pending: BTreeSet<usize>,
    solved_count: usize,
}

impl FountainDecoder {
    pub fn new(k: usize) -> Result<Self, OrpError> {
        if !(1..=K_MAX).contains(&k) {
            return Err(OrpError::Other(format!("fountain: K out of range ({k})")));
        }
        Ok(Self {
            k,
            solved: vec![None; k],
            seen_seeds: HashSet::new(),
            waits: Vec::new(),
            neighbor_index: HashMap::new(),
            pending: BTreeSet::new(),
            solved_count: 0,
        })
    }

    pub fn k(&self) -> usize {
        self.k
    }

    pub fn is_complete(&self) -> bool {
        self.solved_count == self.k
    }

    pub fn received_symbols(&self) -> usize {
        self.seen_seeds.len()
    }

    /// Receives a fountain symbol; `Ok(true)` if it made the block progress.
    pub fn receive(&mut self, seed: u32, symbol: &[u8]) -> Result<bool, OrpError> {
        if symbol.len() != SYMBOL_SIZE {
            return Err(OrpError::Other("fountain: symbol of unexpected size".into()));
        }
        if !self.seen_seeds.insert(seed) {
            return Ok(false);
        }
        if self.is_complete() {
            return Ok(false);
        }
        let mut neighbors: BTreeSet<u32> = lt_neighbors(self.k, seed).into_iter().collect();
        let mut data = symbol.to_vec();
        neighbors.retain(|&i| match &self.solved[i as usize] {
            Some(r) => {
                exclusive_or(&mut data, r);
                false
            }
            None => true,
        });
        if neighbors.len() == 1 {
            let i = *neighbors.iter().next().unwrap();
            self.solve(i, data);
            return Ok(true);
        }
        if neighbors.is_empty() {
            return Ok(false);
        }
        let id = self.waits.len();
        for &i in &neighbors {
            self.neighbor_index.entry(i).or_default().insert(id);
        }
        self.waits.push(Waiting { neighbors, data });
        self.pending.insert(id);
        // Peeling stalls: enough equations to try Gauss.
        if self.pending.len() >= self.k - self.solved_count {
            return Ok(self.eliminate());
        }
        Ok(false)
    }

    /// Gauss–Jordan elimination over GF(2) of the pending equations. Returns
    /// true if it solved everything; otherwise (insufficient rank) nothing changes.
    fn eliminate(&mut self) -> bool {
        let unknown: Vec<u32> = (0..self.k as u32).filter(|&i| self.solved[i as usize].is_none()).collect();
        let n = unknown.len();
        let column: HashMap<u32, usize> = unknown.iter().enumerate().map(|(c, &i)| (i, c)).collect();
        let words = n.div_ceil(32);
        let mut lines: Vec<(Vec<u32>, Vec<u8>)> = self
            .pending
            .iter()
            .map(|&id| {
                let a = &self.waits[id];
                let mut bits = vec![0u32; words];
                for i in &a.neighbors {
                    let c = column[i];
                    bits[c >> 5] |= 1 << (c & 31);
                }
                (bits, a.data.clone())
            })
            .collect();
        for c in 0..n {
            let word = c >> 5;
            let mask = 1u32 << (c & 31);
            let Some(pivot) = (c..lines.len()).find(|&r| lines[r].0[word] & mask != 0) else {
                return false; // insufficient rank: more symbols are needed
            };
            lines.swap(c, pivot);
            let (p_bits, p_data) = lines[c].clone();
            for (r, l) in lines.iter_mut().enumerate() {
                if r == c || l.0[word] & mask == 0 {
                    continue;
                }
                for (a, b) in l.0.iter_mut().zip(&p_bits) {
                    *a ^= b;
                }
                exclusive_or(&mut l.1, &p_data);
            }
        }
        // Reduced form: row c only contains unknown c.
        let ids: Vec<usize> = std::mem::take(&mut self.pending).into_iter().collect();
        for id in ids {
            let neighbors: Vec<u32> = self.waits[id].neighbors.iter().copied().collect();
            for i in neighbors {
                if let Some(links) = self.neighbor_index.get_mut(&i) {
                    links.remove(&id);
                }
            }
        }
        for (c, (_, data)) in lines.into_iter().take(n).enumerate() {
            self.solve(unknown[c], data);
        }
        true
    }

    /// Solves symbol i, then propagates the elimination in cascade.
    fn solve(&mut self, i: u32, data: Vec<u8>) {
        // Another branch of the cascade may have solved i in the meantime.
        if self.solved[i as usize].is_some() {
            return;
        }
        self.solved[i as usize] = Some(data);
        self.solved_count += 1;
        let Some(links) = self.neighbor_index.remove(&i) else { return };
        for id in links {
            let solved_symbol = self.solved[i as usize].as_ref().unwrap();
            let waiting = &mut self.waits[id];
            exclusive_or(&mut waiting.data, solved_symbol);
            waiting.neighbors.remove(&i);
            if waiting.neighbors.len() <= 1 {
                self.pending.remove(&id);
            }
            let waiting = &mut self.waits[id];
            if waiting.neighbors.len() == 1 {
                let j = *waiting.neighbors.iter().next().unwrap();
                // Unindex the equation BEFORE recursing: otherwise the cascade
                // would walk it again and XOR its own buffer down to zero.
                waiting.neighbors.remove(&j);
                let data = std::mem::take(&mut waiting.data);
                if let Some(l) = self.neighbor_index.get_mut(&j) {
                    l.remove(&id);
                }
                self.solve(j, data);
            }
        }
    }

    /// The K source symbols, once the block is complete.
    pub fn rebuild(&self) -> Result<Vec<Vec<u8>>, OrpError> {
        if !self.is_complete() {
            return Err(OrpError::Other("fountain: incomplete block".into()));
        }
        Ok(self.solved.iter().map(|s| s.clone().unwrap()).collect())
    }
}
