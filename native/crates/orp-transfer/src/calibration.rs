//! Calibration of a screen → phone pair (packages/browser/src/calibration.ts):
//! the bench plays a series of trials of TEST_PATTERN frames; we count the frames
//! read, trial by trial, and derive the useful throughput and the best setting,
//! given as a SHORT CODE ("33-2") to type on the bench.

use orp_core::{read_frame, FLAG_TEST_PATTERN, SYMBOL_SIZE};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalibrationTrial {
    pub id: u32,
    pub period: u32,
    pub columns: u32,
    /// Sending duration of the trial (ms).
    pub duration: u32,
}

const TRIAL_DURATION: u32 = 2500;

/// The bench trials, from slowest to fastest (SAME list as the TS).
pub const CALIBRATION_TRIALS: [CalibrationTrial; 9] = [
    CalibrationTrial { id: 1, period: 67, columns: 1, duration: TRIAL_DURATION },
    CalibrationTrial { id: 2, period: 33, columns: 1, duration: TRIAL_DURATION },
    CalibrationTrial { id: 3, period: 17, columns: 1, duration: TRIAL_DURATION },
    CalibrationTrial { id: 4, period: 33, columns: 2, duration: TRIAL_DURATION },
    CalibrationTrial { id: 5, period: 17, columns: 2, duration: TRIAL_DURATION },
    CalibrationTrial { id: 6, period: 33, columns: 3, duration: TRIAL_DURATION },
    CalibrationTrial { id: 7, period: 17, columns: 3, duration: TRIAL_DURATION },
    // 4 × 4: readable only by a receiver that decodes in 4K.
    CalibrationTrial { id: 8, period: 33, columns: 4, duration: TRIAL_DURATION },
    CalibrationTrial { id: 9, period: 17, columns: 4, duration: TRIAL_DURATION },
];

pub const CALIBRATION_PREAMBLE: u32 = 0;
pub const PAUSE_CALIBRATION: u32 = 500;
/// Duration of the series, preamble excluded (ms).
pub const CALIBRATION_SERIES_DURATION: u32 =
    TRIAL_DURATION * CALIBRATION_TRIALS.len() as u32 + PAUSE_CALIBRATION * (CALIBRATION_TRIALS.len() as u32 - 1);
/// Recognized subframe durations (ms) — same list as the TS. 8 ms assumes
/// a sender screen at 120 Hz at least.
pub const SUBFRAME_PERIODS: [u32; 7] = [8, 17, 33, 67, 100, 150, 250];
/// Maximum grids per row (7 × 7: the limit of a 4K camera).
pub const MAX_COLUMNS: u32 = 7;
/// "CALI".
pub const CALIBRATION_TOKEN: u32 = 0x4341_4c49;
/// Payload bytes of a full TM8 frame.
pub const FRAME_PAYLOAD: usize = 4 * SYMBOL_SIZE;

/// Calibration frame number `rank` of trial `trial` — identical to the
/// bench's `trameCalibration` (deterministic pseudo-random content).
pub fn calibration_frame(trial: u32, rank: u32) -> Vec<u8> {
    use orp_core::{build_frame, Codec, FrameHeader, Mulberry32, FRAME_VERSION};
    let seed = ((trial & 0xff) << 24) ^ rank.wrapping_mul(2_654_435_761) ^ CALIBRATION_TOKEN;
    let mut random = Mulberry32::new(seed);
    let payload: Vec<u8> = (0..FRAME_PAYLOAD).map(|_| (random.next_f64() * 256.0) as u8).collect();
    build_frame(
        &FrameHeader { version: FRAME_VERSION, codec: Codec::Color8, flags: FLAG_TEST_PATTERN, token: CALIBRATION_TOKEN, block: trial, k: 1, symbol_count: 4, seed: rank },
        &payload,
        None,
    )
    .expect("calibration frame")
}

/// Trial and rank of a calibration frame that was read, or None.
pub fn read_calibration(bytes: &[u8]) -> Option<(u32, u32)> {
    let parsed = read_frame(bytes).ok()?;
    if parsed.header.flags & FLAG_TEST_PATTERN == 0 || parsed.header.token != CALIBRATION_TOKEN {
        return None;
    }
    Some((parsed.header.block, parsed.header.seed))
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrialResult {
    pub trial: CalibrationTrial,
    pub frames_read: usize,
    /// Estimate: highest rank read + 1.
    pub sent: usize,
    pub part: f64,
    /// File bytes per filmed second.
    pub throughput: f64,
}

#[derive(Debug, Default, Clone)]
pub struct CalibrationMeasurement {
    ranks: BTreeMap<u32, BTreeSet<u32>>,
}

impl CalibrationMeasurement {
    /// True if the frame is a NEW calibration frame.
    pub fn add(&mut self, bytes: &[u8]) -> bool {
        let Some((trial, rank)) = read_calibration(bytes) else { return false };
        if trial == CALIBRATION_PREAMBLE || !CALIBRATION_TRIALS.iter().any(|e| e.id == trial) {
            return false;
        }
        self.ranks.entry(trial).or_default().insert(rank)
    }

    pub fn total(&self) -> usize {
        self.ranks.values().map(|v| v.len()).sum()
    }

    pub fn results(&self) -> Vec<TrialResult> {
        CALIBRATION_TRIALS
            .iter()
            .map(|&trial| {
                let seen_values = self.ranks.get(&trial.id);
                let frames_read = seen_values.map(|v| v.len()).unwrap_or(0);
                let sent = seen_values.and_then(|v| v.iter().max()).map(|&m| m as usize + 1).unwrap_or(0);
                TrialResult {
                    trial,
                    frames_read,
                    sent,
                    part: if sent > 0 { frames_read as f64 / sent as f64 } else { 0.0 },
                    throughput: (frames_read * FRAME_PAYLOAD) as f64 / (trial.duration as f64 / 1000.0),
                }
            })
            .collect()
    }

    /// The highest throughput among trials read at least 50 %; failing that, the
    /// highest throughput; None if nothing was read.
    pub fn recommendation(&self) -> Option<TrialResult> {
        let read_items: Vec<TrialResult> = self.results().into_iter().filter(|r| r.frames_read > 0).collect();
        let sure: Vec<&TrialResult> = read_items.iter().filter(|r| r.part >= 0.5).collect();
        let candidates: Vec<&TrialResult> = if sure.is_empty() { read_items.iter().collect() } else { sure };
        candidates.into_iter().fold(None, |best: Option<&TrialResult>, r| match best {
            Some(m) if m.throughput >= r.throughput => Some(m),
            _ => Some(r),
        }).cloned()
    }
}

/// "33-2" = 33 ms per subframe, 2 × 2 mosaic.
pub fn code_calibration(period: u32, columns: u32) -> String {
    format!("{period}-{columns}")
}

/// Setting of a typed short code ("33-2", "17 × 3"), or None — same
/// grammar as `lireCodeCalibration` (TS).
pub fn read_calibration_code(code: &str) -> Option<(u32, u32)> {
    let code = code.trim();
    let period_end = code.find(|c: char| !c.is_ascii_digit())?;
    let period: u32 = code[..period_end].parse().ok()?;
    // Separator: a sign ("-", "×"…) surrounded by spaces, or spaces alone.
    let raw = &code[period_end..];
    let rest = raw.trim_start();
    let after = match rest.chars().next()? {
        c @ ('-' | '–' | '·' | 'x' | 'X' | '×' | '/') => &rest[c.len_utf8()..],
        _ if rest.len() < raw.len() => rest,
        _ => return None,
    };
    let columns: u32 = after.trim().parse().ok()?;
    if !SUBFRAME_PERIODS.contains(&period) || !(1..=MAX_COLUMNS).contains(&columns) {
        return None;
    }
    Some((period, columns))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(trial: u32, rank: u32) -> Vec<u8> {
        calibration_frame(trial, rank)
    }

    #[test]
    fn measurement_and_recommendation() {
        let mut m = CalibrationMeasurement::default();
        assert!(!m.add(&frame(CALIBRATION_PREAMBLE, 0)));
        for r in 0..50 {
            if r % 5 != 0 {
                m.add(&frame(2, r));
            }
        }
        m.add(&frame(2, 49));
        assert!(!m.add(&frame(2, 1)));
        for r in 0..200 {
            if r % 5 < 3 {
                m.add(&frame(4, r));
            }
        }
        m.add(&frame(4, 199));
        let res = m.results();
        assert_eq!(res[1].frames_read, 40);
        assert_eq!(res[1].sent, 50);
        let recommendation = m.recommendation().unwrap();
        assert_eq!(recommendation.trial.id, 4);
        assert_eq!(code_calibration(recommendation.trial.period, recommendation.trial.columns), "33-2");
        assert_eq!(read_calibration(&frame(4, 37)), Some((4, 37)));
    }

    #[test]
    fn short_codes() {
        assert_eq!(read_calibration_code("33-2"), Some((33, 2)));
        assert_eq!(read_calibration_code(" 17 × 3 "), Some((17, 3)));
        assert_eq!(read_calibration_code("67 1"), Some((67, 1)));
        assert_eq!(read_calibration_code("33-4"), Some((33, 4)));
        assert_eq!(read_calibration_code("8-3"), Some((8, 3)));
        assert_eq!(read_calibration_code("33-8"), None);
        assert_eq!(read_calibration_code("42-2"), None);
        assert_eq!(read_calibration_code("n'importe"), None);
        for e in CALIBRATION_TRIALS {
            assert_eq!(read_calibration_code(&code_calibration(e.period, e.columns)), Some((e.period, e.columns)));
        }
    }
}
