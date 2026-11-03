//! Session life cycle (port of session.ts, §8.1): prepare → pair →
//! calibrate → start → pause/resume → cancel/dispose, typed errors.
//!
//! Sending and receiving are two symmetric types that know NOTHING about the
//! optics: they produce and consume ORP frames.
//!
//! API difference with the TS, forced by the lack of async: the sending loop
//! `start(send, passes)` becomes a cursor — `start(passes)` then
//! `next_frame()` for each displayed image — which leaves the pace to the
//! host. `send_all` chains the frames with a callback that receives the
//! session (for `finish`, `change_codec`…), like the TS callback. The order
//! of frames, seeds and events is the same.

use std::collections::{HashMap, HashSet};

use crate::pairing::{
    commitment_of, constant_time_eq, derive_keys, derive_keys_from_passphrase, expected_k, frame_nonce,
    read_init_code, read_response_code, read_reveal_code, token_of, transcript_hash, write_init_code,
    write_response_code, write_reveal_code, InitCodeInfo, SessionKeys, SESSION_ID_SIZE,
};
use crate::blocks::{assemble, plan_blocks, BlockPlan};
use crate::encryption::{wipe, PrivateKey, CryptoProvider};
use crate::compression::{compress, decompress_bounded};
use crate::errors::OrpError;
use crate::fountain::{fountain_symbol, FountainDecoder};
use crate::log::{Log, SilentLog};
use crate::frames::{
    frame_aad, symbol_capacity, build_frame, write_body_header, write_meta, read_frame,
    majority_meta, Codec, FrameHeader, FLAG_PAIRING, FLAG_ENCRYPTED, FLAG_COMPRESSED, FLAG_TEST_PATTERN,
    SYMBOL_SIZE, FRAME_VERSION,
};
use crate::versions::{require_compatible_version, PROTOCOL_VERSION};

/// §8.1 life cycle — "initial" only exists on the receiving side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Initial,
    Prepare,
    Pairing,
    Sas,
    Calibrated,
    Transmission,
    Pause,
    Finished,
    Cancelled,
}

impl SessionState {
    /// State name, as the TS writes it.
    pub fn name(self) -> &'static str {
        match self {
            SessionState::Initial => "initial",
            SessionState::Prepare => "prepare",
            SessionState::Pairing => "appairage",
            SessionState::Sas => "sas",
            SessionState::Calibrated => "calibre",
            SessionState::Transmission => "transmission",
            SessionState::Pause => "pause",
            SessionState::Finished => "termine",
            SessionState::Cancelled => "annule",
        }
    }
}

fn require_state(action: &str, state: SessionState, allowed: &[SessionState]) -> Result<(), OrpError> {
    if allowed.contains(&state) {
        Ok(())
    } else {
        Err(OrpError::invalid_state(action, state.name()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encryption {
    Required,
    Optional,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingMode {
    /// Response code scanned by the sender (strong mode, default).
    Codes,
    /// Shared passphrase typed on both sides (the sender has no camera).
    Passphrase,
}

pub struct TransmissionOptions {
    /// "Required" by default: no authenticated pairing, no transfer.
    /// "Optional" behaves like "Required" on the sender side (kept for API
    /// compatibility); "Disabled" sends clear frames — the receiver must
    /// accept them explicitly (`ReceptionOptions::encryption`).
    pub encryption: Encryption,
    /// Offered codecs, in order of preference. Default: 8 → 4 → 2 colors.
    pub codecs: Vec<Codec>,
    /// Try deflate-raw before segmentation (default: true, gain checked).
    pub compression: bool,
    pub pairing: PairingMode,
    pub log: Box<dyn Log + Send>,
}

impl Default for TransmissionOptions {
    fn default() -> Self {
        Self {
            encryption: Encryption::Required,
            codecs: vec![Codec::Color8, Codec::Color4, Codec::Mono2],
            compression: true,
            pairing: PairingMode::Codes,
            log: Box::new(SilentLog),
        }
    }
}

/// Default upper bound of a decompressed file (256 MiB).
pub const DEFAULT_MAX_FILE_SIZE: usize = 256 * 1024 * 1024;

pub struct ReceptionOptions {
    /// "Required" (default): an init code announcing clear frames is
    /// refused, and every data frame must be encrypted. "Optional" (or
    /// "Disabled"): a sender in encryption "none" is accepted — its frames
    /// are then authenticated by nothing but the final SHA-256 of the init
    /// code.
    pub encryption: Encryption,
    /// Upper bound of the decompressed file: a deflate bomb stops there.
    pub max_file_size: usize,
    pub log: Box<dyn Log + Send>,
}

impl Default for ReceptionOptions {
    fn default() -> Self {
        Self { encryption: Encryption::Required, max_file_size: DEFAULT_MAX_FILE_SIZE, log: Box::new(SilentLog) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    Passes,
    Finished,
    Cancelled,
}

/// Sender events — no content and no secret in the payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderEvent {
    Frame { block: u32, seed: u32, codec: Codec, symbol_count: u8 },
    Progress { sent_frames: u64 },
    Codec { codec: Codec },
    End { reason: EndReason },
}

/// A block as the receiver sees it: K, distinct symbols received, decoded or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockState {
    pub k: usize,
    pub received_count: usize,
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReceiveProgress {
    pub completed_blocks: usize,
    pub block_count: usize,
    pub received_symbols: usize,
    pub received_frames: u64,
    pub replays: u64,
    pub forged: u64,
    pub corrupted: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    Corrupted,
    Invalid,
    Version,
    Forged,
    Replay,
}

impl Rejection {
    pub fn name(self) -> &'static str {
        match self {
            Rejection::Corrupted => "corrompue",
            Rejection::Invalid => "invalide",
            Rejection::Version => "version",
            Rejection::Forged => "falsifiee",
            Rejection::Replay => "rejeu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameStatus {
    Accepted,
    Rejected(Rejection),
}

/// Receiver events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverEvent {
    Progress(ReceiveProgress),
    Block { block: u32 },
    Complete { stream_size: u64 },
    Rejection { reason: Rejection, block: Option<u32>, seed: Option<u32> },
}

type Listener<E> = Box<dyn FnMut(&E) + Send>;

// ── Sending ───────────────────────────────────────────────────────────────

/// Position of the sending loop: pass, next block in the round robin, next
/// symbol of EACH block.
///
/// Blocks are INTERLEAVED frame by frame (0, 1, 2, …, 0, 1, …): a video of a
/// few seconds then covers all blocks equally. Sent one after the other
/// (≈ 35 s per block on the bench), a 5-block file left blocks never filmed —
/// "99 %" and no file.
#[derive(Debug, Clone, Default)]
struct Cursor {
    passes: u32,
    pass: u32,
    block: usize,
    js: Vec<usize>,
}

pub struct SenderSession {
    listeners: Vec<Listener<SenderEvent>>,
    state: SessionState,
    crypto: Box<dyn CryptoProvider + Send>,
    log: Box<dyn Log + Send>,
    encryption_options: Encryption,
    offered_codecs: Vec<Codec>,
    wants_compression: bool,
    by_passphrase: bool,

    session_id: Vec<u8>,
    priv_pair: Option<PrivateKey>,
    pub_pair: Option<Vec<u8>>,
    commitment: Option<[u8; 32]>,
    reveal_code: Option<Vec<u8>>,
    keys: Option<SessionKeys>,
    plan: Option<BlockPlan>,
    stream_size: usize,
    stream_digest: Option<[u8; 32]>,
    compressed: bool,
    encryption_enabled: bool,
    current_codec: Codec,
    seed_counter: u32,
    frame_count: u64,
    stop_requested: bool,
    cancel_requested: bool,
    cursor: Cursor,
}

impl SenderSession {
    pub fn new(crypto: Box<dyn CryptoProvider + Send>, options: TransmissionOptions) -> Result<Self, OrpError> {
        if options.codecs.is_empty() {
            return Err(OrpError::generic("aucun-codec", "the codec list is empty"));
        }
        Ok(Self {
            listeners: Vec::new(),
            state: SessionState::Prepare,
            crypto,
            log: options.log,
            encryption_options: options.encryption,
            current_codec: options.codecs[0],
            offered_codecs: options.codecs,
            wants_compression: options.compression,
            by_passphrase: options.pairing == PairingMode::Passphrase,
            session_id: vec![0; SESSION_ID_SIZE],
            priv_pair: None,
            pub_pair: None,
            commitment: None,
            reveal_code: None,
            keys: None,
            plan: None,
            stream_size: 0,
            stream_digest: None,
            compressed: false,
            encryption_enabled: false,
            seed_counter: 1,
            frame_count: 0,
            stop_requested: false,
            cancel_requested: false,
            cursor: Cursor::default(),
        })
    }

    /// Subscribes a listener to the sender events.
    pub fn on_event(&mut self, f: impl FnMut(&SenderEvent) + Send + 'static) {
        self.listeners.push(Box::new(f));
    }

    fn emit_event(&mut self, e: SenderEvent) {
        for f in &mut self.listeners {
            f(&e);
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn codec(&self) -> Codec {
        self.current_codec
    }

    pub fn token(&self) -> u32 {
        token_of(&self.session_id)
    }

    /// Number of frames sent since the start of the transmission.
    pub fn sent_frames(&self) -> u64 {
        self.frame_count
    }

    /// Prepare step: optional compression, block plan, ephemeral key pair.
    pub fn prepare(&mut self, input: &[u8]) -> Result<(), OrpError> {
        require_state("prepare", self.state, &[SessionState::Prepare])?;
        if self.plan.is_some() {
            return Err(OrpError::invalid_state("prepare", self.state.name()));
        }
        self.session_id = self.crypto.random_bytes(SESSION_ID_SIZE);
        let pair = self.crypto.generate_ecdh_pair()?;
        self.commitment = Some(commitment_of(self.crypto.as_ref(), &self.session_id, &pair.public_key));
        self.priv_pair = Some(pair.private_key);
        self.pub_pair = Some(pair.public_key.to_vec());
        let mut compressed = None;
        if self.wants_compression {
            compressed = compress(input);
            self.compressed = compressed.is_some();
        }
        let stream: &[u8] = compressed.as_deref().unwrap_or(input);
        self.stream_size = stream.len();
        self.stream_digest = Some(self.crypto.sha256(stream));
        let plan = plan_blocks(stream);
        self.encryption_enabled = self.encryption_options != Encryption::Disabled;
        self.state = SessionState::Pairing;
        self.log.info(
            "session prepared",
            &[
                ("size", self.stream_size.into()),
                ("blocks", plan.block_count().into()),
                ("compressed", self.compressed.into()),
                ("encryption", self.encryption_enabled.into()),
            ],
        );
        self.plan = Some(plan);
        Ok(())
    }

    fn plan_required(&self) -> Result<&BlockPlan, OrpError> {
        self.plan.as_ref().ok_or_else(|| OrpError::PairingRequired("prepare() doit passer avant tout".into()))
    }

    fn keys_required(&self) -> Result<&SessionKeys, OrpError> {
        self.keys
            .as_ref()
            .ok_or_else(|| OrpError::PairingRequired("keys not derived — pairing incomplete".into()))
    }

    /// Payload of the init code — the optical layer encodes it. Same bytes
    /// on every call (they enter the transcript): nothing in it is drawn at
    /// call time.
    pub fn init_code(&self) -> Result<Vec<u8>, OrpError> {
        let plan = self.plan_required()?;
        let commitment = self.commitment.ok_or_else(|| {
            OrpError::PairingRequired("prepare() must run before the init code".into())
        })?;
        write_init_code(&InitCodeInfo {
            session_id: self.session_id.clone(),
            commitment: commitment.to_vec(),
            stream_size: self.stream_size as u64,
            stream_digest: self.stream_digest.map(|e| e.to_vec()).unwrap_or_default(),
            block_count: plan.block_count() as u32,
            k_total: plan.k_total() as u32,
            compressed: self.compressed,
            by_passphrase: self.by_passphrase,
            encrypted: self.encryption_enabled,
        })
    }

    /// Strong path, step 2: reads the response code (receiver pub), derives
    /// the keys and the SAS. The reveal code (`reveal_code()`) must then be
    /// shown to the receiver: without it, it cannot compute its own SAS.
    pub fn receive_response_code(&mut self, code: &[u8]) -> Result<(), OrpError> {
        require_state("receiveResponseCode", self.state, &[SessionState::Pairing])?;
        if self.by_passphrase {
            return Err(OrpError::invalid_state("receiveResponseCode", "passphrase pairing"));
        }
        let (Some(private), Some(public)) = (self.priv_pair.as_ref(), self.pub_pair.as_ref()) else {
            return Err(OrpError::PairingRequired("ephemeral key pair missing".into()));
        };
        let decoded = read_response_code(code)?;
        if decoded.session_id != self.session_id {
            return Err(OrpError::InvalidPairingCode("response code from another session".into()));
        }
        let init = self.init_code()?;
        let reveal = write_reveal_code(&self.session_id, public)?;
        let mut secret = self.crypto.ecdh_agree(private, &decoded.receiver_pub)?;
        let transcript = transcript_hash(self.crypto.as_ref(), &init, Some(code), Some(&reveal));
        let keys = derive_keys(self.crypto.as_ref(), &secret, &transcript);
        wipe(&mut secret);
        self.keys = Some(keys?);
        self.reveal_code = Some(reveal);
        self.state = SessionState::Sas;
        Ok(())
    }

    /// Strong path, step 3: the reveal code (sender pub) to display for the
    /// receiver once its response code has been read — it opens the
    /// commitment of the init code.
    pub fn reveal_code(&self) -> Result<Vec<u8>, OrpError> {
        self.reveal_code.clone().ok_or_else(|| OrpError::PairingRequired("response code not received yet".into()))
    }

    /// Degraded path: shared passphrase typed on both sides, stretched by
    /// PBKDF2, bound to the init code.
    pub fn receive_passphrase(&mut self, passphrase: &str) -> Result<(), OrpError> {
        require_state("receivePassphrase", self.state, &[SessionState::Pairing])?;
        if !self.by_passphrase {
            return Err(OrpError::invalid_state("receivePassphrase", "pairing by codes"));
        }
        let init = self.init_code()?;
        self.keys = Some(derive_keys_from_passphrase(self.crypto.as_ref(), passphrase, &init)?);
        self.state = SessionState::Sas;
        Ok(())
    }

    /// SAS to compare on both devices before any transfer.
    pub fn sas(&self) -> Result<String, OrpError> {
        require_state("sas", self.state, &[SessionState::Sas])?;
        Ok(self.keys_required()?.sas.clone())
    }

    /// Human confirmation of the SAS — unlocks the transmission.
    pub fn confirm_sas(&mut self) -> Result<(), OrpError> {
        require_state("confirmSas", self.state, &[SessionState::Sas])?;
        self.state = SessionState::Calibrated;
        Ok(())
    }

    /// Calibrate step: in V1, only the CHOICE of the initial codec.
    pub fn calibrate(&mut self, recommended_codec: Option<Codec>) -> Result<(), OrpError> {
        require_state("calibrate", self.state, &[SessionState::Calibrated])?;
        if let Some(c) = recommended_codec {
            if self.offered_codecs.contains(&c) {
                self.current_codec = c;
                self.emit_event(SenderEvent::Codec { codec: c });
            }
        }
        Ok(())
    }

    /// Fallback 8 → 4 → 2: the following frames go out in the other mode.
    pub fn change_codec(&mut self, codec: Codec) -> Result<(), OrpError> {
        require_state(
            "setCodec",
            self.state,
            &[SessionState::Calibrated, SessionState::Transmission, SessionState::Pause],
        )?;
        if !self.offered_codecs.contains(&codec) {
            return Err(OrpError::generic("codec-refuse", format!("codec not offered: 0x{}", codec as u8)));
        }
        self.current_codec = codec;
        self.emit_event(SenderEvent::Codec { codec });
        Ok(())
    }

    /// Start step: opens the transmission (round robin over the blocks,
    /// increasing seeds). `passes` bounds the number of replays of each block —
    /// 0 sends until `finish()` or `cancel()`. Frames are then pulled one by
    /// one with `next_frame`.
    pub fn start(&mut self, passes: u32) -> Result<(), OrpError> {
        require_state("start", self.state, &[SessionState::Calibrated])?;
        self.plan_required()?;
        self.state = SessionState::Transmission;
        self.stop_requested = false;
        self.cancel_requested = false;
        self.cursor = Cursor { passes, ..Cursor::default() };
        Ok(())
    }

    /// Next frame of the transmission; `Ok(None)` once it is over (passes
    /// exhausted, `finish` or `cancel`) — the `End` event is then emitted,
    /// only once. While paused, the call is rejected.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, OrpError> {
        match self.state {
            SessionState::Finished | SessionState::Cancelled => return Ok(None),
            SessionState::Transmission => {}
            other => return Err(OrpError::invalid_state("nextFrame", other.name())),
        }
        loop {
            if self.stop_requested {
                return Ok(self.finish_with(if self.cancel_requested { EndReason::Cancelled } else { EndReason::Finished }));
            }
            let (passes, pass) = (self.cursor.passes, self.cursor.pass);
            if passes > 0 && pass >= passes {
                return Ok(self.finish_with(EndReason::Passes));
            }
            let plan = self.plan_required()?;
            let block_count = plan.block_count();
            if block_count == 0 {
                // Empty stream: nothing to send (the TS loops forever if passes = 0).
                return Ok(self.finish_with(EndReason::Passes));
            }
            let k_per_block = plan.k_per_block.clone();
            if self.cursor.js.len() != block_count {
                self.cursor.js = vec![0; block_count];
            }
            // Round robin: the next block (starting from `block`) that still
            // has symbols in this pass.
            let begin = self.cursor.block;
            let next_block = (0..block_count).map(|d| (begin + d) % block_count).find(|&b| self.cursor.js[b] < k_per_block[b]);
            let Some(block) = next_block else {
                self.cursor = Cursor { passes, pass: pass + 1, block: 0, js: vec![0; block_count] };
                continue;
            };
            let k = k_per_block[block];
            let j = self.cursor.js[block];
            // Capacity re-read on EACH frame: a codec fallback during a block
            // must not produce a frame too large for the new mode.
            let nb = symbol_capacity(self.current_codec).min(k - j);
            let frame = self.frame(block, k, nb)?;
            self.cursor.js[block] += nb;
            self.cursor.block = (block + 1) % block_count;
            return Ok(Some(frame));
        }
    }

    /// Starts and sends until the end: `send` receives the session (for
    /// `finish`, `change_codec`…) and each frame, in the TS order.
    pub fn send_all(
        &mut self,
        passes: u32,
        mut send: impl FnMut(&mut Self, Vec<u8>) -> Result<(), OrpError>,
    ) -> Result<(), OrpError> {
        self.start(passes)?;
        while let Some(t) = self.next_frame()? {
            send(self, t)?;
        }
        Ok(())
    }

    fn finish_with(&mut self, reason: EndReason) -> Option<Vec<u8>> {
        self.state = if reason == EndReason::Cancelled { SessionState::Cancelled } else { SessionState::Finished };
        self.emit_event(SenderEvent::End { reason });
        if self.state == SessionState::Cancelled {
            self.dispose();
        }
        None
    }

    fn frame(&mut self, block: usize, k: usize, symbol_count: usize) -> Result<Vec<u8>, OrpError> {
        // A frame carries the combinations seed, seed+1… seed+nb−1: the
        // counter therefore advances by symbol_count.
        let seed = self.seed_counter;
        self.seed_counter = self.seed_counter.wrapping_add(symbol_count as u32);
        let plan = self.plan_required()?;
        let sources = plan.block_symbols(block)?;
        let mut payload = Vec::with_capacity(symbol_count * SYMBOL_SIZE);
        for i in 0..symbol_count {
            payload.extend_from_slice(&fountain_symbol(sources, k, seed.wrapping_add(i as u32))?);
        }
        let flags = if self.encryption_enabled { FLAG_ENCRYPTED } else { 0 }
            | if self.compressed { FLAG_COMPRESSED } else { 0 };
        let header = FrameHeader {
            version: FRAME_VERSION,
            codec: self.current_codec,
            flags,
            token: token_of(&self.session_id),
            block: block as u32,
            k: k as u16,
            symbol_count: symbol_count as u8,
            seed,
        };
        let frame = if self.encryption_enabled {
            let keys = self.keys_required()?;
            let aad = frame_aad(&write_meta(&header)?, &write_body_header(&header)?);
            let nonce = frame_nonce(self.crypto.as_ref(), &keys.nonce_key, block as u32, seed);
            let (encrypted, tag) = self.crypto.encrypt_aead(&keys.data_key, &nonce, &payload, &aad)?;
            build_frame(&header, &encrypted, Some(&tag))?
        } else {
            build_frame(&header, &payload, None)?
        };
        self.frame_count += 1;
        self.emit_event(SenderEvent::Frame {
            block: block as u32,
            seed,
            codec: self.current_codec,
            symbol_count: symbol_count as u8,
        });
        let sent_frames = self.frame_count;
        self.emit_event(SenderEvent::Progress { sent_frames });
        Ok(frame)
    }

    /// Pause step — only in the active session.
    pub fn pause(&mut self) -> Result<(), OrpError> {
        require_state("pause", self.state, &[SessionState::Transmission])?;
        self.state = SessionState::Pause;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), OrpError> {
        require_state("resume", self.state, &[SessionState::Pause])?;
        self.state = SessionState::Transmission;
        Ok(())
    }

    /// Requests the end: the next `next_frame` returns `None`.
    pub fn finish(&mut self) {
        self.stop_requested = true;
        if self.state == SessionState::Pause {
            self.state = SessionState::Transmission;
        }
    }

    pub fn cancel(&mut self) {
        self.cancel_requested = true;
        self.finish();
    }

    /// Wipes the keys, symbols and plaintext in memory.
    pub fn dispose(&mut self) {
        self.keys = None; // SessionKeys wipes itself on drop
        if let Some(mut plan) = self.plan.take() {
            for s in &mut plan.symbols {
                s.fill(0);
            }
        }
        self.priv_pair = None;
        self.pub_pair = None;
        self.stream_digest = None;
        self.reveal_code = None;
    }
}

// ── Receiving ─────────────────────────────────────────────────────────────

/// Rebuilt and verified file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiveResult {
    pub data: Vec<u8>,
    pub checked: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct Stats {
    frames: u64,
    replays: u64,
    forged: u64,
    corrupted: u64,
}

pub struct ReceiverSession {
    listeners: Vec<Listener<ReceiverEvent>>,
    state: SessionState,
    crypto: Box<dyn CryptoProvider + Send>,
    log: Box<dyn Log + Send>,
    accept_clear: bool,
    max_file_size: usize,

    info: Option<InitCodeInfo>,
    init_code: Option<Vec<u8>>,
    response_code: Option<Vec<u8>>,
    keys: Option<SessionKeys>,
    priv_pair: Option<PrivateKey>,
    decoders: HashMap<u32, FountainDecoder>,
    views: HashSet<(u32, u32)>,
    announced_complete: bool,
    stats: Stats,
}

impl ReceiverSession {
    pub fn new(crypto: Box<dyn CryptoProvider + Send>) -> Self {
        Self::with_log(crypto, Box::new(SilentLog))
    }

    pub fn with_log(crypto: Box<dyn CryptoProvider + Send>, log: Box<dyn Log + Send>) -> Self {
        Self::with_options(crypto, ReceptionOptions { log, ..ReceptionOptions::default() })
    }

    pub fn with_options(crypto: Box<dyn CryptoProvider + Send>, options: ReceptionOptions) -> Self {
        Self {
            listeners: Vec::new(),
            state: SessionState::Initial,
            crypto,
            log: options.log,
            accept_clear: options.encryption != Encryption::Required,
            max_file_size: options.max_file_size,
            info: None,
            init_code: None,
            response_code: None,
            keys: None,
            priv_pair: None,
            decoders: HashMap::new(),
            views: HashSet::new(),
            announced_complete: false,
            stats: Stats::default(),
        }
    }

    pub fn on_event(&mut self, f: impl FnMut(&ReceiverEvent) + Send + 'static) {
        self.listeners.push(Box::new(f));
    }

    fn emit_event(&mut self, e: ReceiverEvent) {
        for f in &mut self.listeners {
            f(&e);
        }
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn token(&self) -> Option<u32> {
        self.info.as_ref().map(|i| token_of(&i.session_id))
    }

    /// Reads the init code shown by the sender. Refuses a sender announcing
    /// clear frames unless the receiver accepts them (`ReceptionOptions`).
    pub fn show_init_code(&mut self, code: &[u8]) -> Result<InitCodeInfo, OrpError> {
        require_state("scanInitCode", self.state, &[SessionState::Initial])?;
        let decoded = read_init_code(code)?;
        if !decoded.encrypted && !self.accept_clear {
            return Err(OrpError::InvalidPairingCode(
                "the sender announces clear frames, this receiver requires encryption".into(),
            ));
        }
        self.info = Some(decoded.clone());
        self.init_code = Some(code.to_vec());
        self.state = SessionState::Pairing;
        Ok(decoded)
    }

    /// Strong path, step 2: produces the response code for the sender to
    /// scan (the same bytes on every call). The keys and the SAS only exist
    /// once the reveal code has been read (`receive_reveal_code`).
    pub fn response_code(&mut self) -> Result<Vec<u8>, OrpError> {
        require_state("responseCode", self.state, &[SessionState::Pairing])?;
        let info = self.info_required()?;
        if info.by_passphrase {
            return Err(OrpError::invalid_state("responseCode", "passphrase pairing"));
        }
        if let Some(code) = &self.response_code {
            return Ok(code.clone());
        }
        let session_id = info.session_id.clone();
        let pair = self.crypto.generate_ecdh_pair()?;
        let code = write_response_code(&session_id, &pair.public_key)?;
        self.priv_pair = Some(pair.private_key);
        self.response_code = Some(code.clone());
        Ok(code)
    }

    /// Strong path, step 3: reads the reveal code (sender pub), checks it
    /// opens the commitment of the init code, derives the keys and the SAS.
    pub fn receive_reveal_code(&mut self, code: &[u8]) -> Result<(), OrpError> {
        require_state("receiveRevealCode", self.state, &[SessionState::Pairing])?;
        let info = self.info_required()?;
        let (Some(private), Some(response), Some(init)) =
            (self.priv_pair.as_ref(), self.response_code.as_ref(), self.init_code.as_ref())
        else {
            return Err(OrpError::PairingRequired("response code not produced yet".into()));
        };
        let decoded = read_reveal_code(code)?;
        if decoded.session_id != info.session_id {
            return Err(OrpError::InvalidPairingCode("reveal code from another session".into()));
        }
        let expected = commitment_of(self.crypto.as_ref(), &info.session_id, &decoded.sender_pub);
        if !constant_time_eq(&expected, &info.commitment) {
            return Err(OrpError::InvalidPairingCode(
                "the reveal code does not open the commitment of the init code".into(),
            ));
        }
        let mut secret = self.crypto.ecdh_agree(private, &decoded.sender_pub)?;
        let transcript = transcript_hash(self.crypto.as_ref(), init, Some(response), Some(code));
        let keys = derive_keys(self.crypto.as_ref(), &secret, &transcript);
        wipe(&mut secret);
        self.keys = Some(keys?);
        self.priv_pair = None;
        self.state = SessionState::Sas;
        Ok(())
    }

    /// Degraded path: shared passphrase, stretched by PBKDF2, bound to the
    /// init code.
    pub fn pair_by_passphrase(&mut self, passphrase: &str) -> Result<(), OrpError> {
        require_state("pairWithPassphrase", self.state, &[SessionState::Pairing])?;
        if !self.info_required()?.by_passphrase {
            return Err(OrpError::invalid_state("pairWithPassphrase", "pairing by codes"));
        }
        let init = self.init_code.clone().unwrap_or_default();
        self.keys = Some(derive_keys_from_passphrase(self.crypto.as_ref(), passphrase, &init)?);
        self.state = SessionState::Sas;
        Ok(())
    }

    pub fn sas(&self) -> Result<String, OrpError> {
        require_state("sas", self.state, &[SessionState::Sas])?;
        Ok(self.keys_required()?.sas.clone())
    }

    pub fn confirm_sas(&mut self) -> Result<(), OrpError> {
        require_state("confirmSas", self.state, &[SessionState::Sas])?;
        self.state = SessionState::Calibrated;
        Ok(())
    }

    fn reject(&mut self, reason: Rejection, block: Option<u32>, seed: Option<u32>) -> FrameStatus {
        self.emit_event(ReceiverEvent::Rejection { reason, block, seed });
        FrameStatus::Rejected(reason)
    }

    /// Receives a frame — corrected or not by the optical layer: the
    /// Reed-Solomon correction is redone here (idempotent on a sound frame).
    /// A frame from an unknown session returns `UnknownSession`: the caller
    /// must stop listening to this channel.
    pub fn receive_frame(&mut self, t: &[u8]) -> Result<FrameStatus, OrpError> {
        require_state(
            "receiveFrame",
            self.state,
            &[SessionState::Calibrated, SessionState::Transmission, SessionState::Finished],
        )?;
        if self.state == SessionState::Calibrated {
            self.state = SessionState::Transmission;
        }
        let parsed = match read_frame(t) {
            Ok(l) => l,
            Err(OrpError::CorruptedFrame { .. }) => {
                self.stats.corrupted += 1;
                return Ok(self.reject(Rejection::Corrupted, None, None));
            }
            Err(_) => return Ok(self.reject(Rejection::Invalid, None, None)),
        };
        let header = parsed.header;
        if require_compatible_version(header.version, PROTOCOL_VERSION).is_err() {
            return Ok(self.reject(Rejection::Version, None, None));
        }
        if header.flags & (FLAG_TEST_PATTERN | FLAG_PAIRING) != 0 {
            // Service frames: test pattern and pairing take another path.
            return Ok(FrameStatus::Accepted);
        }
        let info = self.info_required()?;
        let (session_token, stream_size, announced_encrypted) =
            (token_of(&info.session_id), info.stream_size, info.encrypted);
        self.keys_required()?;
        if header.token != session_token {
            self.log.warn("frame from an unknown session", &[("token", header.token.into())]);
            return Err(OrpError::UnknownSession(header.token));
        }
        // Frame outside the layout announced by the init code: block that
        // does not exist, or K that is not the one of the block. Rejected
        // before any allocation — a decoder per forged block number would
        // grow without bound.
        if header.k as u32 != expected_k(stream_size, header.block) {
            return Ok(self.reject(Rejection::Invalid, Some(header.block), Some(header.seed)));
        }
        // Encryption announced by the init code (bound to the keys by the
        // transcript): a clear frame in an encrypted session is a forgery,
        // never a frame to decode.
        let encrypted = header.flags & FLAG_ENCRYPTED != 0;
        if encrypted != announced_encrypted {
            self.stats.forged += 1;
            return Ok(self.reject(Rejection::Forged, Some(header.block), Some(header.seed)));
        }
        // Replay: (block, seed) already seen — ignored, counted, never decoded again.
        let key = (header.block, header.seed);
        if self.views.contains(&key) {
            self.stats.replays += 1;
            return Ok(self.reject(Rejection::Replay, Some(header.block), Some(header.seed)));
        }
        let mut payload = parsed.payload;
        if encrypted {
            match self.decrypt(t, &header, &payload, parsed.tag.as_deref()) {
                Ok(plaintext) => payload = plaintext,
                Err(_) => {
                    self.stats.forged += 1;
                    return Ok(self.reject(Rejection::Forged, Some(header.block), Some(header.seed)));
                }
            }
        }
        self.views.insert(key);
        self.stats.frames += 1;
        let decoder = self.decoder_for(header.block, header.k)?;
        for (i, piece) in payload.as_chunks::<SYMBOL_SIZE>().0.iter().take(header.symbol_count as usize).enumerate() {
            decoder.receive(header.seed.wrapping_add(i as u32), piece)?;
        }
        if decoder.is_complete() {
            self.emit_event(ReceiverEvent::Block { block: header.block });
            if !self.announced_complete && self.all_complete() {
                self.announced_complete = true;
                let stream_size = self.info_required()?.stream_size;
                self.emit_event(ReceiverEvent::Complete { stream_size });
            }
        }
        let p = self.progress();
        self.emit_event(ReceiverEvent::Progress(p));
        Ok(FrameStatus::Accepted)
    }

    fn decrypt(&self, t: &[u8], header: &FrameHeader, payload: &[u8], tag: Option<&[u8]>) -> Result<Vec<u8>, OrpError> {
        let keys = self.keys_required()?;
        let nonce = frame_nonce(self.crypto.as_ref(), &keys.nonce_key, header.block, header.seed);
        let aad = frame_aad(&majority_meta(t)?, &write_body_header(header)?);
        let tag = tag.ok_or_else(|| OrpError::InvalidFrame("tag missing".into()))?;
        self.crypto.decrypt_aead(&keys.data_key, &nonce, payload, tag, &aad)
    }

    fn info_required(&self) -> Result<&InitCodeInfo, OrpError> {
        self.info.as_ref().ok_or_else(|| OrpError::PairingRequired("init code not seen".into()))
    }

    fn keys_required(&self) -> Result<&SessionKeys, OrpError> {
        self.keys
            .as_ref()
            .ok_or_else(|| OrpError::PairingRequired("keys not derived — pairing incomplete".into()))
    }

    /// Decoder of a block — its K was checked against the announced layout.
    fn decoder_for(&mut self, block: u32, k: u16) -> Result<&mut FountainDecoder, OrpError> {
        Ok(match self.decoders.entry(block) {
            std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => v.insert(FountainDecoder::new(k as usize)?),
        })
    }

    fn total_block_count(&self) -> u32 {
        self.info.as_ref().map(|i| i.block_count).unwrap_or(0)
    }

    fn all_complete(&self) -> bool {
        (0..self.total_block_count()).all(|b| self.decoders.get(&b).is_some_and(|d| d.is_complete()))
    }

    /// All announced blocks are rebuilt.
    pub fn finished(&self) -> bool {
        self.all_complete()
    }

    pub fn progress(&self) -> ReceiveProgress {
        ReceiveProgress {
            completed_blocks: self.decoders.values().filter(|d| d.is_complete()).count(),
            block_count: self.total_block_count() as usize,
            received_symbols: self.decoders.values().map(|d| d.received_symbols()).sum(),
            received_frames: self.stats.frames,
            replays: self.stats.replays,
            forged: self.stats.forged,
            corrupted: self.stats.corrupted,
        }
    }

    /// State of EACH block. The file is only complete if all of them are: a
    /// symbol total ≥ K says nothing about a lagging block. K of a block never
    /// seen yet: the one implied by the announced stream size.
    pub fn blocks(&self) -> Vec<BlockState> {
        let nb = self.total_block_count();
        let size = self.info.as_ref().map(|i| i.stream_size).unwrap_or(0);
        (0..nb)
            .map(|b| match self.decoders.get(&b) {
                Some(d) => BlockState { k: d.k(), received_count: d.received_symbols(), complete: d.is_complete() },
                None => BlockState { k: expected_k(size, b) as usize, received_count: 0, complete: false },
            })
            .collect()
    }

    /// Rebuild, whole-file integrity check and decompression.
    pub fn result(&mut self) -> Result<ReceiveResult, OrpError> {
        require_state("result", self.state, &[SessionState::Transmission, SessionState::Finished])?;
        let info = self.info_required()?;
        self.keys_required()?;
        if !self.all_complete() {
            return Err(OrpError::invalid_state("result", "incomplete transmission"));
        }
        let size = info.stream_size as usize;
        let mut stream = vec![0u8; size];
        let mut pos = 0;
        for b in 0..info.block_count {
            if pos >= size {
                break;
            }
            let piece = assemble(&self.decoders[&b].rebuild()?, usize::MAX);
            let cut = (pos + piece.len()).min(size);
            stream[pos..cut].copy_from_slice(&piece[..cut - pos]);
            pos = cut;
        }
        if self.crypto.sha256(&stream)[..] != info.stream_digest[..] {
            return Err(OrpError::Integrity("the SHA-256 digest of the rebuilt stream does not match".into()));
        }
        if info.compressed {
            stream = decompress_bounded(&stream, self.max_file_size)?;
        }
        self.state = SessionState::Finished;
        Ok(ReceiveResult { data: stream, checked: true })
    }

    pub fn dispose(&mut self) {
        self.keys = None;
        self.priv_pair = None;
        self.decoders.clear();
    }

    /// Init code read (raw bytes), if any.
    pub fn init_code(&self) -> Option<&[u8]> {
        self.init_code.as_deref()
    }
}
