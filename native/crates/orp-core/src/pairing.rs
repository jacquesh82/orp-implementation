//! Authenticated pairing (port of pairing.ts) — ORP v0.2. Two paths to the
//! same key set:
//!
//!   1. by codes (strong path), three optical messages:
//!        init     sender → receiver  commitment H(session_id ‖ sender pub)
//!        response receiver → sender  receiver pub
//!        reveal   sender → receiver  sender pub (checked against the commitment)
//!      secret = ECDH of the two ephemeral key pairs. The commitment fixes the
//!      sender's key BEFORE it sees the receiver's, and the receiver's key is
//!      fixed before it sees the sender's: a man-in-the-middle can no longer
//!      grind its key until the two 6-digit SAS collide (v0.1 weakness);
//!   2. by pairing passphrase (degraded path, no camera on the sender side):
//!      secret = PBKDF2-HMAC-SHA-256 of the passphrase (600 000 iterations),
//!      salt = label ‖ session_id.
//!
//! In both cases the keys AND the SAS are derived with the TRANSCRIPT hash
//! as HKDF salt: every byte of the codes exchanged is bound to the keys. A
//! 6-digit SAS is compared by the users before any transfer.

use crate::encryption::{wipe, CryptoProvider};
use crate::errors::OrpError;
use crate::frames::{K_MAX, SYMBOL_SIZE};
use crate::versions::{Version, PROTOCOL_VERSION};

pub const SESSION_ID_SIZE: usize = 16;
pub const ECDH_PUB_SIZE: usize = 65;
pub const COMMITMENT_SIZE: usize = 32;

/// First byte of every pairing code: its kind.
pub const CODE_KIND_INIT: u8 = 0x49; // "I"
pub const CODE_KIND_RESPONSE: u8 = 0x52; // "R"
pub const CODE_KIND_REVEAL: u8 = 0x56; // "V"

/// Second byte of every pairing code: protocol version, major << 4 | minor.
pub const CODE_VERSION: u8 = ((PROTOCOL_VERSION.major & 0x0f) << 4) | (PROTOCOL_VERSION.minor & 0x0f);

const CODE_HEADER_SIZE: usize = 2;

/// Init code: kind ‖ version ‖ session_id ‖ commitment ‖ size (u64) ‖ digest ‖
/// nbBlocs (u16) ‖ kTotal (u32) ‖ flags.
pub const INIT_CODE_SIZE: usize = CODE_HEADER_SIZE + SESSION_ID_SIZE + COMMITMENT_SIZE + 8 + 32 + 2 + 4 + 1;
/// Response code: kind ‖ version ‖ session_id ‖ receiver pub.
pub const RESPONSE_CODE_SIZE: usize = CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUB_SIZE;
/// Reveal code: kind ‖ version ‖ session_id ‖ sender pub.
pub const REVEAL_CODE_SIZE: usize = CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUB_SIZE;

/// Init code flags. Any other bit set: invalid code.
pub const INIT_FLAG_COMPRESSED: u8 = 0x01;
pub const INIT_FLAG_BY_PASSPHRASE: u8 = 0x02;
pub const INIT_FLAG_ENCRYPTED: u8 = 0x04;
const INIT_FLAGS_KNOWN: u8 = INIT_FLAG_COMPRESSED | INIT_FLAG_BY_PASSPHRASE | INIT_FLAG_ENCRYPTED;

/// PBKDF2 iterations of the passphrase path — a constant of the version.
pub const PASSPHRASE_ITERATIONS: u32 = 600_000;
/// Minimum passphrase length, in UTF-16 code units (like `String.length`).
pub const PASSPHRASE_MIN_LENGTH: usize = 8;

const LABEL_COMMITMENT: &str = "ORP v0.2 engagement";
const LABEL_TRANSCRIPT: &str = "ORP v0.2 transcription";
const LABEL_PASSPHRASE: &str = "ORP v0.2 phrase";
const INFO_DATA: &str = "ORP v0.2 donnees";
const INFO_NONCE: &str = "ORP v0.2 nonce";
const INFO_SAS: &str = "ORP v0.2 SAS";

/// Largest stream size the init code accepts (2⁵³ − 1, `Number.MAX_SAFE_INTEGER`).
const MAX_STREAM_SIZE: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitCodeInfo {
    pub session_id: Vec<u8>,
    /// SHA-256(label ‖ session_id ‖ sender pub): the sender pub itself comes
    /// in the reveal code.
    pub commitment: Vec<u8>,
    pub stream_size: u64,
    /// SHA-256 of the transferred stream (compressed if applicable, before encryption).
    pub stream_digest: Vec<u8>,
    /// Written on 16 bits; checked against the stream size.
    pub block_count: u32,
    /// Written on 32 bits; checked against the stream size.
    pub k_total: u32,
    pub compressed: bool,
    /// Pairing by shared PASSPHRASE (§7.2) — session flags, bit 1. False:
    /// strong path through the response and reveal codes (§7.1).
    pub by_passphrase: bool,
    /// The data frames are encrypted (flag bit 2): the receiver rejects any
    /// frame that is not.
    pub encrypted: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SessionKeys {
    pub data_key: Vec<u8>,
    pub nonce_key: Vec<u8>,
    /// 6-digit SAS — the only artifact meant for the users' eyes.
    pub sas: String,
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClesSession(…)")
    }
}

impl Drop for SessionKeys {
    fn drop(&mut self) {
        clear_keys(self);
    }
}

/// A parsed response code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseCode {
    pub session_id: Vec<u8>,
    pub receiver_pub: Vec<u8>,
}

/// A parsed reveal code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealCode {
    pub session_id: Vec<u8>,
    pub sender_pub: Vec<u8>,
}

/// Kind of a pairing code (first byte).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingCodeKind {
    Init,
    Response,
    Reveal,
}

impl PairingCodeKind {
    /// Size of a code of this kind.
    pub fn size(self) -> usize {
        match self {
            PairingCodeKind::Init => INIT_CODE_SIZE,
            PairingCodeKind::Response => RESPONSE_CODE_SIZE,
            PairingCodeKind::Reveal => REVEAL_CODE_SIZE,
        }
    }
}

/// Kind of a pairing code, or None if unknown — lets a reader skip codes it
/// does not expect (`pairingCodeKind`).
pub fn pairing_code_kind(o: &[u8]) -> Option<PairingCodeKind> {
    match o.first() {
        Some(&CODE_KIND_INIT) => Some(PairingCodeKind::Init),
        Some(&CODE_KIND_RESPONSE) => Some(PairingCodeKind::Response),
        Some(&CODE_KIND_REVEAL) => Some(PairingCodeKind::Reveal),
        _ => None,
    }
}

/// Short token: the first 4 bytes of the session_id, big-endian.
pub fn token_of(session_id: &[u8]) -> u32 {
    let mut o = [0u8; 4];
    for (i, v) in o.iter_mut().enumerate() {
        *v = session_id.get(i).copied().unwrap_or(0);
    }
    u32::from_be_bytes(o)
}

/// Block layout implied by a stream size: (block count, total K) — the
/// receiver checks the init code and every frame against it.
pub fn expected_layout(stream_size: u64) -> (u64, u64) {
    let k_total = stream_size.div_ceil(SYMBOL_SIZE as u64);
    (k_total.div_ceil(K_MAX as u64), k_total)
}

/// K of block `block` for a stream of `stream_size` bytes (0 if the block
/// does not exist).
pub fn expected_k(stream_size: u64, block: u32) -> u32 {
    let (block_count, k_total) = expected_layout(stream_size);
    if block as u64 >= block_count {
        return 0;
    }
    (K_MAX as u64).min(k_total - block as u64 * K_MAX as u64) as u32
}

/// Comparison whose duration does not depend on where the arrays differ.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y));
    std::hint::black_box(diff) == 0
}

fn read_header(o: &[u8], kind: u8, size: usize, name: &str) -> Result<(), OrpError> {
    if o.len() != size {
        return Err(OrpError::InvalidPairingCode(format!("{name} code of {} bytes, {size} expected", o.len())));
    }
    if o[0] != kind {
        return Err(OrpError::InvalidPairingCode(format!("not a {name} code (kind 0x{:x})", o[0])));
    }
    if o[1] != CODE_VERSION {
        return Err(OrpError::IncompatibleVersion {
            received: Version { major: o[1] >> 4, minor: o[1] & 0x0f },
            supported: PROTOCOL_VERSION,
        });
    }
    Ok(())
}

fn concat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

/// SHA-256(label ‖ session_id ‖ sender pub).
pub fn commitment_of(crypto: &dyn CryptoProvider, session_id: &[u8], sender_pub: &[u8]) -> [u8; 32] {
    crypto.sha256(&concat(&[LABEL_COMMITMENT.as_bytes(), session_id, sender_pub]))
}

pub fn write_init_code(i: &InitCodeInfo) -> Result<Vec<u8>, OrpError> {
    if i.session_id.len() != SESSION_ID_SIZE {
        return Err(OrpError::InvalidPairingCode("session_id of unexpected size".into()));
    }
    if i.commitment.len() != COMMITMENT_SIZE {
        return Err(OrpError::InvalidPairingCode("commitment of unexpected size".into()));
    }
    if i.stream_digest.len() != 32 {
        return Err(OrpError::InvalidPairingCode("digest of unexpected size".into()));
    }
    if i.stream_size > MAX_STREAM_SIZE {
        return Err(OrpError::InvalidPairingCode("stream size out of range".into()));
    }
    let (block_count, k_total) = expected_layout(i.stream_size);
    if i.block_count as u64 != block_count || i.k_total as u64 != k_total || block_count > 0xffff {
        return Err(OrpError::InvalidPairingCode("block layout inconsistent with the stream size".into()));
    }
    let mut o = Vec::with_capacity(INIT_CODE_SIZE);
    o.push(CODE_KIND_INIT);
    o.push(CODE_VERSION);
    o.extend_from_slice(&i.session_id);
    o.extend_from_slice(&i.commitment);
    o.extend_from_slice(&i.stream_size.to_be_bytes());
    o.extend_from_slice(&i.stream_digest);
    o.extend_from_slice(&(i.block_count as u16).to_be_bytes());
    o.extend_from_slice(&i.k_total.to_be_bytes());
    o.push(
        if i.compressed { INIT_FLAG_COMPRESSED } else { 0 }
            | if i.by_passphrase { INIT_FLAG_BY_PASSPHRASE } else { 0 }
            | if i.encrypted { INIT_FLAG_ENCRYPTED } else { 0 },
    );
    Ok(o)
}

pub fn read_init_code(o: &[u8]) -> Result<InitCodeInfo, OrpError> {
    read_header(o, CODE_KIND_INIT, INIT_CODE_SIZE, "init")?;
    let stream_size = u64::from_be_bytes(o[50..58].try_into().unwrap());
    if stream_size > MAX_STREAM_SIZE {
        return Err(OrpError::InvalidPairingCode("stream size out of range".into()));
    }
    let block_count = u16::from_be_bytes([o[90], o[91]]) as u32;
    let k_total = u32::from_be_bytes(o[92..96].try_into().unwrap());
    let (expected_blocks, expected_k_total) = expected_layout(stream_size);
    if block_count as u64 != expected_blocks || k_total as u64 != expected_k_total {
        return Err(OrpError::InvalidPairingCode("block layout inconsistent with the stream size".into()));
    }
    let flags = o[96];
    if flags & !INIT_FLAGS_KNOWN != 0 {
        return Err(OrpError::InvalidPairingCode(format!("unknown init flags 0x{flags:x}")));
    }
    Ok(InitCodeInfo {
        session_id: o[2..18].to_vec(),
        commitment: o[18..50].to_vec(),
        stream_size,
        stream_digest: o[58..90].to_vec(),
        block_count,
        k_total,
        compressed: flags & INIT_FLAG_COMPRESSED != 0,
        by_passphrase: flags & INIT_FLAG_BY_PASSPHRASE != 0,
        encrypted: flags & INIT_FLAG_ENCRYPTED != 0,
    })
}

fn write_key_code(kind: u8, session_id: &[u8], public_key: &[u8]) -> Result<Vec<u8>, OrpError> {
    if session_id.len() != SESSION_ID_SIZE || public_key.len() != ECDH_PUB_SIZE {
        return Err(OrpError::InvalidPairingCode("fields of unexpected size for a pairing code".into()));
    }
    let mut o = Vec::with_capacity(CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUB_SIZE);
    o.push(kind);
    o.push(CODE_VERSION);
    o.extend_from_slice(session_id);
    o.extend_from_slice(public_key);
    Ok(o)
}

pub fn write_response_code(session_id: &[u8], receiver_pub: &[u8]) -> Result<Vec<u8>, OrpError> {
    write_key_code(CODE_KIND_RESPONSE, session_id, receiver_pub)
}

pub fn read_response_code(o: &[u8]) -> Result<ResponseCode, OrpError> {
    read_header(o, CODE_KIND_RESPONSE, RESPONSE_CODE_SIZE, "response")?;
    Ok(ResponseCode { session_id: o[2..18].to_vec(), receiver_pub: o[18..83].to_vec() })
}

pub fn write_reveal_code(session_id: &[u8], sender_pub: &[u8]) -> Result<Vec<u8>, OrpError> {
    write_key_code(CODE_KIND_REVEAL, session_id, sender_pub)
}

pub fn read_reveal_code(o: &[u8]) -> Result<RevealCode, OrpError> {
    read_header(o, CODE_KIND_REVEAL, REVEAL_CODE_SIZE, "reveal")?;
    Ok(RevealCode { session_id: o[2..18].to_vec(), sender_pub: o[18..83].to_vec() })
}

/// Transcript hash: SHA-256(label ‖ init ‖ response ‖ reveal) on the codes
/// path, SHA-256(label ‖ init) on the passphrase path.
pub fn transcript_hash(
    crypto: &dyn CryptoProvider,
    init: &[u8],
    response: Option<&[u8]>,
    reveal: Option<&[u8]>,
) -> [u8; 32] {
    crypto.sha256(&concat(&[LABEL_TRANSCRIPT.as_bytes(), init, response.unwrap_or(&[]), reveal.unwrap_or(&[])]))
}

/// Derives the session key set from a shared secret and the transcript hash.
pub fn derive_keys(crypto: &dyn CryptoProvider, secret: &[u8], transcript: &[u8]) -> Result<SessionKeys, OrpError> {
    let data_key = crypto.derive_hkdf(secret, transcript, INFO_DATA, 32)?;
    let nonce_key = crypto.derive_hkdf(secret, transcript, INFO_NONCE, 32)?;
    let o = crypto.derive_hkdf(secret, transcript, INFO_SAS, 4)?;
    let value = u32::from_be_bytes([o[0], o[1], o[2], o[3]]);
    Ok(SessionKeys { data_key, nonce_key, sas: format!("{:06}", value % 1_000_000) })
}

/// Degraded path: secret stretched from a passphrase typed by both users
/// (PBKDF2-HMAC-SHA-256, 600 000 iterations, salt = label ‖ session_id).
/// The minimum length is counted in UTF-16 units, like `String.length`.
pub fn derive_secret_from_passphrase(
    crypto: &dyn CryptoProvider,
    passphrase: &str,
    session_id: &[u8],
) -> Result<Vec<u8>, OrpError> {
    if passphrase.encode_utf16().count() < PASSPHRASE_MIN_LENGTH {
        return Err(OrpError::InvalidPairingCode(format!(
            "pairing passphrase too short (at least {PASSPHRASE_MIN_LENGTH} characters)"
        )));
    }
    let salt = concat(&[LABEL_PASSPHRASE.as_bytes(), session_id]);
    crypto.derive_pbkdf2(passphrase.as_bytes(), &salt, PASSPHRASE_ITERATIONS, 32)
}

/// Passphrase path: the full key set, bound to the init code.
pub fn derive_keys_from_passphrase(
    crypto: &dyn CryptoProvider,
    passphrase: &str,
    init_code: &[u8],
) -> Result<SessionKeys, OrpError> {
    let info = read_init_code(init_code)?;
    let mut secret = derive_secret_from_passphrase(crypto, passphrase, &info.session_id)?;
    let keys = derive_keys(crypto, &secret, &transcript_hash(crypto, init_code, None, None));
    wipe(&mut secret);
    keys
}

/// AEAD nonce of a frame: HMAC-SHA-256(nonce_key, block ‖ seed) truncated to
/// 12 bytes — deterministic, unique per frame, free on the wire.
pub fn frame_nonce(crypto: &dyn CryptoProvider, nonce_key: &[u8], block: u32, seed: u32) -> [u8; 12] {
    let mut input = [0u8; 8];
    input[..4].copy_from_slice(&block.to_be_bytes());
    input[4..].copy_from_slice(&seed.to_be_bytes());
    let mac = crypto.hmac_sha256(nonce_key, &input);
    let mut n = [0u8; 12];
    n.copy_from_slice(&mac[..12]);
    n
}

/// Wipes a key set (also done automatically on drop).
pub fn clear_keys(keys: &mut SessionKeys) {
    wipe(&mut keys.data_key);
    wipe(&mut keys.nonce_key);
}
