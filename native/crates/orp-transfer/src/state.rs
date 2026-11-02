//! SENDING STATE slipped into the init code frame: the code (129 bytes)
//! leaves 63 free bytes in its 2-symbol payload. The bench (or the sending
//! app) writes there its sending counter, the symbols sent and its
//! "to film" target; the phone, reading these states in the video, aligns
//! its video on the SENDER'S TIME — the same clock on both sides.
//!
//! Format (after the 129 bytes of the code, big-endian):
//!   "ET" · version (1) · flags · t (i32, ms since the start of the data,
//!   negative during the countdown) · symbols sent (u32) · advised symbols
//!   (u32). Older receivers ignore these bytes.

use crate::pairing::pairing_payload;
use orp_core::pairing::INIT_CODE_SIZE;
use orp_core::SYMBOL_SIZE;

const MAGIC: [u8; 2] = *b"ET";
const VERSION: u8 = 1;
pub const STATE_SIZE: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendingState {
    /// Sender counter (ms); negative during the countdown.
    pub t_ms: i32,
    pub sent_symbols: u32,
    /// The sender's "to film" target (perfect reading from the start).
    pub advised_symbols: u32,
}

/// Symbols to broadcast so that a receiver reading EVERYTHING from the start
/// gets the file (file.ts, suggestedSymbols): fountain margin per block.
pub fn advised_symbols(k_total: u32, block_count: u32) -> u32 {
    let blocks = block_count.max(1) as f64;
    let k = k_total as f64 / blocks;
    (blocks * (k * 1.25 + 3.0 * k.sqrt() + 6.0)).ceil() as u32
}

/// Writes the state after the init code, into the payload (already padded
/// to a whole number of symbols).
pub fn write_state(payload: &mut [u8], state: &SendingState) {
    let o = INIT_CODE_SIZE;
    if payload.len() < o + STATE_SIZE {
        return;
    }
    let c = &mut payload[o..o + STATE_SIZE];
    c[0..2].copy_from_slice(&MAGIC);
    c[2] = VERSION;
    c[3] = u8::from(state.t_ms < 0);
    c[4..8].copy_from_slice(&state.t_ms.to_be_bytes());
    c[8..12].copy_from_slice(&state.sent_symbols.to_be_bytes());
    c[12..16].copy_from_slice(&state.advised_symbols.to_be_bytes());
}

/// Sending state of a pairing frame that was read, if it has one.
pub fn read_state(bytes: &[u8]) -> Option<SendingState> {
    let payload = pairing_payload(bytes, INIT_CODE_SIZE + STATE_SIZE)?;
    let c = payload.get(INIT_CODE_SIZE..INIT_CODE_SIZE + STATE_SIZE)?;
    if c[0..2] != MAGIC || c[2] != VERSION {
        return None;
    }
    Some(SendingState {
        t_ms: i32::from_be_bytes(c[4..8].try_into().ok()?),
        sent_symbols: u32::from_be_bytes(c[8..12].try_into().ok()?),
        advised_symbols: u32::from_be_bytes(c[12..16].try_into().ok()?),
    })
}

/// The room exists: the code fits in 2 symbols, leaving room for the state.
const _: () = assert!(INIT_CODE_SIZE + STATE_SIZE <= 2 * SYMBOL_SIZE);

/// The states read in ONE video, timestamped in video time: enough to align
/// the video on the sender's clock and measure what the phone reads.
#[derive(Debug, Default, Clone)]
pub struct SenderTracker {
    /// (video time in s, state) in reading order.
    points: Vec<(f64, SendingState)>,
}

/// The summary of a video, in sender time.
#[derive(Debug, Clone, PartialEq)]
pub struct SenderSummary {
    /// Part of the sending covered by the video (s, sender counter).
    pub start_s: f64,
    pub end_s: f64,
    /// Sending throughput (symbols/s) measured between two states, if there are two.
    pub sending_throughput: Option<f64>,
    /// The sender's "to film" target (symbols).
    pub advised_symbols: u32,
}

impl SenderTracker {
    pub fn note(&mut self, t_video: f64, state: SendingState) {
        if self.points.last().map(|(_, e)| *e != state).unwrap_or(true) {
            self.points.push((t_video, state));
        }
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Summary of a video filmed from `video_start` to `video_end` (s, video time).
    pub fn summary(&self, video_start: f64, video_end: f64) -> Option<SenderSummary> {
        let (t0, e0) = *self.points.first()?;
        let (t1, e1) = *self.points.last()?;
        // Sender clock: t_s = t_state + (t_video − video time of the state).
        let to_sender = |tv: f64, (tp, e): (f64, SendingState)| e.t_ms as f64 / 1000.0 + (tv - tp);
        let duration = (e1.t_ms - e0.t_ms) as f64 / 1000.0;
        let sending_throughput = (duration > 1.0 && e1.sent_symbols > e0.sent_symbols).then(|| (e1.sent_symbols - e0.sent_symbols) as f64 / duration);
        Some(SenderSummary {
            start_s: to_sender(video_start, (t0, e0)),
            end_s: to_sender(video_end, (t1, e1)),
            sending_throughput,
            advised_symbols: e1.advised_symbols,
        })
    }
}

/// "1:07": a readable counter, like the one the sender shows.
pub fn clock(s: f64) -> String {
    let s = s.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sending::pairing_frame_with_state;

    /// The SAME frame as the bench (TS, packages/browser/test/send-state.spec.ts):
    /// the phone reads the state written by the bench, and vice versa.
    #[test]
    fn state_matches_ts() {
        let code: Vec<u8> = (0..INIT_CODE_SIZE).map(|i| ((i * 7 + 3) & 0xff) as u8).collect();
        let state = SendingState { t_ms: 47_250, sent_symbols: 1234, advised_symbols: 9000 };
        let ts = "4f520001020802004f520001020802004f520001020802000000000000000000000100000000030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e75455401000000b892000004d20000232800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000868b4ab270c321583d3675db";
        let expected: Vec<u8> = (0..ts.len()).step_by(2).map(|i| u8::from_str_radix(&ts[i..i + 2], 16).unwrap()).collect();
        assert_eq!(pairing_frame_with_state(&code, Some(&state)).unwrap(), expected);
        assert_eq!(read_state(&expected), Some(state));
    }

    #[test]
    fn round_trip_and_summary() {
        let code = vec![7u8; INIT_CODE_SIZE];
        let state = SendingState { t_ms: 47_250, sent_symbols: 1234, advised_symbols: 9000 };
        let frame = pairing_frame_with_state(&code, Some(&state)).unwrap();
        assert_eq!(read_state(&frame), Some(state));
        // Without a state (old sender): nothing.
        assert_eq!(read_state(&crate::pairing_frame(&code).unwrap()), None);
        // Two states 10 s apart in the video: 600 symbols sent.
        let mut s = SenderTracker::default();
        s.note(2.0, SendingState { t_ms: 12_000, sent_symbols: 1000, advised_symbols: 9000 });
        s.note(12.0, SendingState { t_ms: 22_000, sent_symbols: 1600, advised_symbols: 9000 });
        let b = s.summary(0.5, 14.0).unwrap();
        assert!((b.start_s - 10.5).abs() < 1e-9);
        assert!((b.end_s - 24.0).abs() < 1e-9);
        assert!((b.sending_throughput.unwrap() - 60.0).abs() < 1e-9);
        assert_eq!(clock(67.4), "1:07");
        assert_eq!(advised_symbols(613, 1), (613.0f64 * 1.25 + 3.0 * 613f64.sqrt() + 6.0).ceil() as u32);
    }
}
