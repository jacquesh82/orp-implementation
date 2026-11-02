//! Sending a file from the phone screen, like the test bench
//! (apps/lab, emettreFichier): PASSPHRASE pairing (the sender needs no
//! camera), init code during the countdown then repeated in the stream,
//! frames as a single grid or as a mosaic.

use crate::pairing::BENCH_PASSPHRASE;
use crate::file::{pack, TransferredFile};
use orp_core::session::{TransmissionOptions, SenderSession, PairingMode};
use orp_core::{build_frame, Codec, CryptoRust, FrameHeader, OrpError, FLAG_PAIRING, SYMBOL_SIZE, FRAME_VERSION};
use orp_optics::render::{render_mosaic, ImageRGBA, RenderOptions};
use orp_optics::temporal::{payload_subframe, reference_subframe, PALETTE_TM};

/// Single grid: the init code comes back every 10 frames.
const CODE_RETRY: u64 = 10;
/// Mosaic: it takes one cell in one batch out of three.
const BATCH_RETRY: u64 = 3;

#[derive(Debug, Clone, Copy)]
pub struct SendSettings {
    pub codec: Codec,
    /// Duration of a subframe (ms).
    pub period_ms: u32,
    /// Grids per row: 1, 2 or 3.
    pub columns: usize,
}

/// Pairing frame (init code or response code), in TM4.
pub fn pairing_frame(user_payload: &[u8]) -> Result<Vec<u8>, OrpError> {
    pairing_frame_with_state(user_payload, None)
}

/// Init code frame carrying the sending STATE (counter, sent symbols,
/// target) in the free room of its payload — see `state`.
pub fn pairing_frame_with_state(user_payload: &[u8], state: Option<&crate::state::SendingState>) -> Result<Vec<u8>, OrpError> {
    let nb = user_payload.len().div_ceil(SYMBOL_SIZE).max(1);
    let mut payload = vec![0u8; nb * SYMBOL_SIZE];
    payload[..user_payload.len()].copy_from_slice(user_payload);
    if let Some(e) = state {
        crate::state::write_state(&mut payload, e);
    }
    build_frame(
        &FrameHeader { version: FRAME_VERSION, codec: Codec::Color4, flags: FLAG_PAIRING, token: 0, block: 0, k: 1, symbol_count: nb as u8, seed: 0 },
        &payload,
        None,
    )
}

pub struct Sender {
    session: SenderSession,
    pub settings: SendSettings,
    /// Init code frame (TM4).
    pub init: Vec<u8>,
    /// Verification code, shown below the grid.
    pub sas: String,
    pub stream_size: usize,
    pub frames: u64,
    batches: u64,
    code_resumed: bool,
    /// Init code (raw payload), repeated with the sending state.
    code: Vec<u8>,
    /// Start of the data (sender counter) and symbols sent since.
    start: Option<std::time::Instant>,
    sent_symbols: u32,
    advised: u32,
}

impl Sender {
    pub fn new(file: &TransferredFile, settings: SendSettings) -> Result<Self, OrpError> {
        let options = TransmissionOptions { codecs: vec![settings.codec], pairing: PairingMode::Passphrase, ..TransmissionOptions::default() };
        let mut session = SenderSession::new(Box::new(CryptoRust::new()), options)?;
        let stream = pack(file);
        session.prepare(&stream)?;
        session.receive_passphrase(BENCH_PASSPHRASE)?;
        let sas = session.sas()?;
        session.confirm_sas()?;
        session.calibrate(Some(settings.codec))?;
        let code = session.init_code()?;
        let init = pairing_frame(&code)?;
        let info = orp_core::pairing::read_init_code(&code)?;
        let advised = crate::state::advised_symbols(info.k_total, info.block_count);
        session.start(0)?;
        Ok(Self {
            session,
            settings,
            init,
            sas,
            stream_size: stream.len(),
            frames: 0,
            batches: 0,
            code_resumed: false,
            code,
            start: None,
            sent_symbols: 0,
            advised,
        })
    }

    /// The init code REPEATED in the stream, with the sending state:
    /// the phone reads the sender counter from it (see `state`).
    fn init_with_state(&self) -> Vec<u8> {
        let state = crate::state::SendingState {
            t_ms: self.start.map(|d| d.elapsed().as_millis() as i32).unwrap_or(0),
            sent_symbols: self.sent_symbols,
            advised_symbols: self.advised,
        };
        pairing_frame_with_state(&self.code, Some(&state)).unwrap_or_else(|_| self.init.clone())
    }

    /// Next data frame, counted (sent symbols, counter start).
    fn next_session_frame(&mut self) -> Result<Vec<u8>, OrpError> {
        let t = self.session.next_frame()?.ok_or_else(|| OrpError::Other("transmission finished".into()))?;
        self.start.get_or_insert_with(std::time::Instant::now);
        self.sent_symbols += orp_core::frames::read_meta_by_majority(&t).map(|e| e.symbol_count as u32).unwrap_or(0);
        self.frames += 1;
        Ok(t)
    }

    /// Sender counter (s since the first data frame).
    pub fn seconds(&self) -> f64 {
        self.start.map(|d| d.elapsed().as_secs_f64()).unwrap_or(0.0)
    }

    /// The next batch to show: 1 frame (single grid) or columns² (mosaic).
    pub fn next_batch(&mut self) -> Result<Vec<Vec<u8>>, OrpError> {
        let cells = self.settings.columns * self.settings.columns;
        if cells == 1 {
            // Every 10 frames, the init code once.
            if self.frames > 0 && self.frames % CODE_RETRY == 0 && !self.code_resumed {
                self.code_resumed = true;
                return Ok(vec![self.init_with_state()]);
            }
            self.code_resumed = false;
            return Ok(vec![self.next_session_frame()?]);
        }
        let with_code = self.batches % BATCH_RETRY == 0;
        let mut batch = Vec::with_capacity(cells);
        if with_code {
            batch.push(self.init_with_state());
        }
        while batch.len() < cells {
            let t = self.next_session_frame()?;
            batch.push(t);
        }
        self.batches += 1;
        Ok(batch)
    }

    pub fn finish(&mut self) {
        self.session.finish();
    }
}

/// R (reference) and P (payload) images of a batch, as a mosaic if needed.
pub fn batch_images(batch: &[Vec<u8>], columns: usize, module_size: usize) -> Result<(ImageRGBA, ImageRGBA), OrpError> {
    let cells = columns * columns;
    let full: Vec<&Vec<u8>> = (0..cells).map(|i| &batch[i % batch.len()]).collect();
    let codec = |t: &[u8]| orp_core::frames::majority_meta(t).ok().and_then(|m| Codec::from_u8(m[4])).unwrap_or(Codec::Color8);
    let error = |e: orp_optics::OpticsError| OrpError::Other(e.to_string());
    let r: Vec<Vec<u8>> = full.iter().map(|t| reference_subframe(t, codec(t))).collect::<Result<_, _>>().map_err(error)?;
    let p: Vec<Vec<u8>> = full.iter().map(|t| payload_subframe(t, codec(t))).collect::<Result<_, _>>().map_err(error)?;
    let options = RenderOptions { module_size, quiet_zone: 2 };
    Ok((render_mosaic(&r, &PALETTE_TM, columns, &options), render_mosaic(&p, &PALETTE_TM, columns, &options)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::receiving::{Event, Receiver};
    use orp_optics::pipeline::TmPipeline;
    use orp_optics::tm_receiver::TmReceiverOptions;

    /// End to end: sending → R/P render → optical reading → reception.
    fn transfer(columns: usize) {
        let file = TransferredFile {
            name: "essai.txt".into(),
            mime_type: "text/plain".into(),
            data: (0..6000u32).map(|i| (i * 7 + i / 13) as u8).collect(),
        };
        let mut em = Sender::new(&file, SendSettings { codec: Codec::Color8, period_ms: 33, columns }).unwrap();
        let mut pipeline = TmPipeline::new(&TmReceiverOptions::default());
        let mut rec = Receiver::new();
        let mut received = None;
        let mut states: Vec<crate::state::SendingState> = Vec::new();
        let mut t = 0.0;
        // The code first (countdown), then the stream.
        let mut batches = vec![vec![em.init.clone()]];
        for _ in 0..400 {
            if received.is_some() {
                break;
            }
            let batch = if batches.is_empty() { em.next_batch().unwrap() } else { batches.remove(0) };
            let c = if batch.len() == 1 && columns > 1 && batch[0] == em.init { 1 } else { columns };
            let (r, p) = batch_images(&batch, c, 7).unwrap();
            for image in [r, p] {
                t += 33.0;
                for res in pipeline.process(&image, t) {
                    let Some(frame) = res.frame.filter(|x| x.is_new) else { continue };
                    if let Some(state) = crate::state::read_state(&frame.bytes) {
                        states.push(state);
                    }
                    for e in rec.process(&frame.bytes).unwrap() {
                        match e {
                            Event::CodeRead { sas, .. } => {
                                assert_eq!(sas, em.sas);
                                for e in rec.confirm().unwrap() {
                                    if let Event::File(f) = e {
                                        received = Some(f);
                                    }
                                }
                            }
                            Event::File(f) => received = Some(f),
                            _ => {}
                        }
                    }
                }
            }
        }
        assert_eq!(received.expect("file received"), file);
        // The repeated codes carry the sending state, read through the
        // optics (mosaic: the code comes back from the first batch on; as a
        // single grid, this small file is complete before the 10th frame).
        if columns > 1 {
            assert!(!states.is_empty(), "no sending state read");
        }
        assert!(states.windows(2).all(|w| w[1].sent_symbols >= w[0].sent_symbols));
        assert!(states.iter().all(|e| e.advised_symbols > 0));
    }

    /// Strong mode (sender with a camera, like the web app): the receiver returns
    /// a response code; the sender reads it; verification codes match.
    #[test]
    fn strong_mode() {
        use orp_core::session::{TransmissionOptions, SenderSession};
        let file = TransferredFile { name: "fort.bin".into(), mime_type: "application/octet-stream".into(), data: (0..3000u32).map(|i| (i * 31) as u8).collect() };
        let mut em = SenderSession::new(Box::new(CryptoRust::new()), TransmissionOptions { codecs: vec![Codec::Color8], ..TransmissionOptions::default() }).unwrap();
        em.prepare(&crate::file::pack(&file)).unwrap();
        let init = pairing_frame(&em.init_code().unwrap()).unwrap();
        let mut rec = Receiver::new();
        let events = rec.process(&init).unwrap();
        let Some(Event::CodeRead { sas, by_passphrase, response_code: Some(response), .. }) = events.first().cloned() else {
            panic!("expected a read code with a response code: {events:?}");
        };
        assert!(!by_passphrase);
        em.receive_response_code(&response).unwrap();
        assert_eq!(em.sas().unwrap(), sas, "verification codes match");
        em.confirm_sas().unwrap();
        em.calibrate(Some(Codec::Color8)).unwrap();
        em.start(0).unwrap();
        rec.confirm().unwrap();
        let mut received = None;
        for _ in 0..200 {
            let t = em.next_frame().unwrap().unwrap();
            for e in rec.process(&t).unwrap() {
                if let Event::File(f) = e {
                    received = Some(f);
                }
            }
            if received.is_some() {
                break;
            }
        }
        assert_eq!(received.expect("file received"), file);
        // Next reception: the same sending, still on screen, is ignored.
        let mut next = rec.next();
        assert!(next.process(&init).unwrap().is_empty());
        assert_eq!(next.phase, crate::receiving::ReceivePhase::Code);
    }

    /// Single grid: the 11th image is the repeated code, with the sending state.
    #[test]
    fn code_resume_with_state() {
        let file = TransferredFile { name: "e.bin".into(), mime_type: "application/octet-stream".into(), data: (0..20_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect() };
        let mut em = Sender::new(&file, SendSettings { codec: Codec::Color8, period_ms: 33, columns: 1 }).unwrap();
        for _ in 0..10 {
            em.next_batch().unwrap();
        }
        let resume = em.next_batch().unwrap();
        let state = crate::state::read_state(&resume[0]).expect("state in the repeated code");
        // 10 TM8 frames of at most 4 symbols (fewer at the end of a block).
        assert!((30..=40).contains(&state.sent_symbols), "{}", state.sent_symbols);
        assert!(state.advised_symbols > 0 && state.t_ms >= 0);
    }

    #[test]
    fn single_grid_end_to_end() {
        transfer(1);
    }

    #[test]
    fn mosaic_2x2_end_to_end() {
        transfer(2);
    }
}
