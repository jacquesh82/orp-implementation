//! Reception of a file (apps/web/src/main.ts, trameRecue): init code,
//! pairing (bench passphrase, or response code to show), frames held until
//! the code is confirmed, detection of a new sending, verified file.

use crate::pairing::{pairing_payload, is_pairing_frame, BENCH_PASSPHRASE};
use crate::file::{unpack, TransferredFile};
use orp_core::pairing::{read_init_code, InitCodeInfo, INIT_CODE_SIZE};
use orp_core::session::{ReceiverSession, FrameStatus};
use orp_core::{CryptoRust, OrpError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceivePhase {
    /// Waiting for the init code.
    Code,
    /// Code read, verification code to compare (frames set aside).
    Verification,
    /// Receiving the data.
    Data,
    /// File received and verified.
    Finished,
}

#[derive(Debug, Clone)]
pub enum Event {
    /// Init code read: verification code to compare with the sender.
    CodeRead { sas: String, stream_size: u64, by_passphrase: bool, response_code: Option<Vec<u8>> },
    /// A new frame was accepted.
    Progress { symbols: usize, k_total: u32, accepted: u64 },
    /// File complete, digest verified.
    File(TransferredFile),
    /// Wrong digest: reception rejected (F-09).
    Rejected,
    /// Another init code: the sender started a new sending.
    NewSending,
}

pub struct Receiver {
    session: ReceiverSession,
    pub phase: ReceivePhase,
    pub info: Option<InitCodeInfo>,
    init_code: Option<Vec<u8>>,
    pending: Vec<Vec<u8>>,
    /// Distinct valid frames read (all sources, pairing excluded).
    pub frames_read: u64,
    pub accepted: u64,
    /// Session id of a sending ALREADY received: ignored, so as not to
    /// receive the same file twice if the sender keeps going.
    already_received: Option<Vec<u8>>,
}

impl Default for Receiver {
    fn default() -> Self {
        Self::new()
    }
}

impl Receiver {
    pub fn new() -> Self {
        Self {
            session: ReceiverSession::new(Box::new(CryptoRust::new())),
            phase: ReceivePhase::Code,
            info: None,
            init_code: None,
            pending: Vec::new(),
            frames_read: 0,
            accepted: 0,
            already_received: None,
        }
    }

    /// New reception after this one: its sending, if complete, is ignored
    /// (the sender may still be showing it).
    pub fn next(&self) -> Self {
        let mut r = Self::new();
        r.already_received = match (self.phase, &self.init_code) {
            (ReceivePhase::Finished, Some(code)) => Some(code[..16.min(code.len())].to_vec()),
            _ => self.already_received.clone(),
        };
        r
    }

    pub fn session(&self) -> &ReceiverSession {
        &self.session
    }

    /// A NEW valid frame out of the optical pipeline.
    pub fn process(&mut self, bytes: &[u8]) -> Result<Vec<Event>, OrpError> {
        let pairing = is_pairing_frame(bytes);
        if !pairing {
            self.frames_read += 1;
        }
        let mut events = Vec::new();
        match self.phase {
            ReceivePhase::Code => {
                if let Some(code) = pairing_payload(bytes, INIT_CODE_SIZE) {
                    if self.already_received.as_deref().is_some_and(|id| code.starts_with(id)) {
                        return Ok(events); // sending already received
                    }
                    events.push(self.read_code(code)?);
                } else if !pairing && self.pending.len() < 20_000 {
                    // Frames of a video filmed before the code: replayed later.
                    self.pending.push(bytes.to_vec());
                }
            }
            ReceivePhase::Verification => {
                if !pairing && self.pending.len() < 20_000 {
                    self.pending.push(bytes.to_vec());
                }
            }
            // Finished: the file stays acquired; only ANOTHER sending code
            // restarts a reception (the same sending coming round has no effect).
            ReceivePhase::Data | ReceivePhase::Finished => {
                if pairing {
                    if let (Some(code), Some(current)) = (pairing_payload(bytes, INIT_CODE_SIZE), &self.init_code) {
                        if other_sending(&code, current) {
                            *self = self.next();
                            events.push(Event::NewSending);
                            events.extend(self.process(bytes)?);
                        }
                    }
                } else if self.phase == ReceivePhase::Data {
                    events.extend(self.data_frame(bytes)?);
                }
            }
        }
        Ok(events)
    }

    fn read_code(&mut self, code: Vec<u8>) -> Result<Event, OrpError> {
        let info = self.session.show_init_code(&code)?;
        let response_code = if info.by_passphrase {
            // Sender without a camera (bench): the bench passphrase first, only
            // a code to compare remains.
            self.session.pair_by_passphrase(BENCH_PASSPHRASE)?;
            None
        } else {
            Some(self.session.response_code()?)
        };
        let event = Event::CodeRead { sas: self.session.sas()?, stream_size: info.stream_size, by_passphrase: info.by_passphrase, response_code };
        self.init_code = Some(code);
        self.info = Some(info);
        self.phase = ReceivePhase::Verification;
        Ok(event)
    }

    /// Codes match: reception starts; the pending frames are replayed.
    pub fn confirm(&mut self) -> Result<Vec<Event>, OrpError> {
        self.session.confirm_sas()?;
        self.phase = ReceivePhase::Data;
        let mut events = Vec::new();
        for t in std::mem::take(&mut self.pending) {
            if self.phase != ReceivePhase::Data {
                break;
            }
            events.extend(self.data_frame(&t)?);
        }
        Ok(events)
    }

    fn data_frame(&mut self, bytes: &[u8]) -> Result<Vec<Event>, OrpError> {
        let status = match self.session.receive_frame(bytes) {
            Ok(s) => s,
            Err(_) => return Ok(Vec::new()), // frame rejected: counted by the session
        };
        if !matches!(status, FrameStatus::Accepted) {
            return Ok(Vec::new());
        }
        self.accepted += 1;
        let p = self.session.progress();
        let k_total = self.info.as_ref().map(|i| i.k_total).unwrap_or(0);
        let mut events = vec![Event::Progress { symbols: p.received_symbols, k_total, accepted: self.accepted }];
        if self.session.finished() {
            self.phase = ReceivePhase::Finished;
            let r = self.session.result()?;
            events.push(if r.checked { Event::File(unpack(&r.data)) } else { Event::Rejected });
        }
        Ok(events)
    }
}

/// Init code of ANOTHER session (different id, plausible content).
fn other_sending(code: &[u8], current: &[u8]) -> bool {
    if code.len() < 17 || code[..16] == current[..16.min(current.len())] {
        return false;
    }
    read_init_code(code).map(|i| code[16] == 0x04 && i.k_total > 0 && i.block_count > 0 && i.stream_size > 0).unwrap_or(false)
}

/// REAL progress of a multi-block file: it is complete only if ALL blocks
/// are. The last block may need far more than K symbols (fountain code
/// tail), and the sender interleaves all blocks in equal shares: each
/// symbol useful to the late block costs as many symbols as there are
/// blocks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockSummary {
    pub complete_count: usize,
    pub nb: usize,
    /// Fraction of the file (0..1) — capped below 1 while a block is missing.
    pub part: f64,
    /// Symbols still to RECEIVE (all blocks together).
    pub to_receive: f64,
}

pub fn block_summary(blocks: &[orp_core::session::BlockState]) -> BlockSummary {
    let nb = blocks.len();
    let complete_count = blocks.iter().filter(|b| b.complete).count();
    let k_total: usize = blocks.iter().map(|b| b.k).sum();
    let acquired: f64 = blocks.iter().map(|b| if b.complete { b.k as f64 } else { (b.received_count as f64).min(0.95 * b.k as f64) }).sum();
    // Each incomplete block lacks ≈ 10 % of K beyond what it has, at least
    // 5 % (tail); received in equal shares, nb × the worst is needed.
    let worst = blocks
        .iter()
        .filter(|b| !b.complete)
        .map(|b| (1.1 * b.k as f64 - b.received_count as f64).max(0.05 * b.k as f64))
        .fold(0.0, f64::max);
    BlockSummary {
        complete_count,
        nb,
        part: if k_total > 0 { acquired / k_total as f64 } else { 0.0 },
        to_receive: worst * nb as f64,
    }
}

#[cfg(test)]
mod tests_summary {
    use super::*;
    use orp_core::session::BlockState;

    #[test]
    fn a_late_block_dominates() {
        let b = [
            BlockState { k: 1000, received_count: 1050, complete: true },
            BlockState { k: 1000, received_count: 1100, complete: false },
            BlockState { k: 72, received_count: 80, complete: true },
        ];
        let r = block_summary(&b);
        assert_eq!((r.complete_count, r.nb), (2, 3));
        assert!(r.part < 1.0 && r.part > 0.9);
        // The late block already has 1.1 K: still aim for 5 % of K, × 3 blocks.
        assert!((r.to_receive - 150.0).abs() < 1e-9);
    }
}

/// ADVISED filming duration (s), with some slack: each block only gets its
/// share of the stream (the sender interleaves them in equal shares) and its
/// symbols arrive as images happen to be read. For each incomplete block,
/// aim for what it lacks PLUS a margin (≈ 90 % chance, Poisson law:
/// missing + 1.3 √missing + 2), then add the time to start and stop
/// filming. The slowest block sets the duration.
pub fn advised_duration(blocks: &[orp_core::session::BlockState], symbols_per_second: f64) -> Option<f64> {
    if symbols_per_second <= 0.0 || blocks.is_empty() {
        return None;
    }
    let per_block = symbols_per_second / blocks.len() as f64;
    let worst = blocks
        .iter()
        .filter(|b| !b.complete)
        .map(|b| {
            let missing = (1.1 * b.k as f64 - b.received_count as f64).max(0.05 * b.k as f64);
            (missing + 1.3 * missing.sqrt() + 2.0) / per_block
        })
        .fold(0.0, f64::max);
    (worst > 0.0).then_some(worst + 4.0)
}

/// One bar per block for the screen: fill 0..1 (1.1 K targeted), complete.
pub fn block_view(blocks: &[orp_core::session::BlockState]) -> Vec<(f32, bool)> {
    blocks
        .iter()
        .map(|b| (if b.complete { 1.0 } else { (b.received_count as f32 / (1.1 * b.k as f32)).min(0.97) }, b.complete))
        .collect()
}

#[cfg(test)]
mod tests_duration {
    use super::*;
    use orp_core::session::BlockState;

    #[test]
    fn the_late_block_and_the_margin() {
        // 5 blocks, 50 symbols/s received → 10/s per block. Block 2 needs
        // 100 symbols: 100 + 13 + 2 = 115 → 11.5 s, + 4 s = 15.5 s.
        let mut b = vec![BlockState { k: 1000, received_count: 1100, complete: true }; 5];
        b[2] = BlockState { k: 1000, received_count: 1000, complete: false };
        let d = advised_duration(&b, 50.0).unwrap();
        assert!((d - 15.5).abs() < 1e-9, "{d}");
        // All complete: nothing to film.
        let all = vec![BlockState { k: 10, received_count: 11, complete: true }; 3];
        assert_eq!(advised_duration(&all, 50.0), None);
        assert_eq!(block_view(&b)[2].1, false);
    }
}
