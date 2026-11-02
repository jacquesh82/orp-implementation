//! Authenticated pairing (port of pairing.ts) — two paths to the same key
//! set:
//!
//!   1. by response code (strong mode): secret = ECDH of the two ephemeral
//!      key pairs;
//!   2. by pairing passphrase (degraded mode): secret = HKDF of the
//!      passphrase, salt = session_id.
//!
//! In both cases a 6-digit SAS, derived from the secret, is compared by the
//! users before any transfer.

use crate::encryption::CryptoProvider;
use crate::errors::OrpError;

pub const SESSION_ID_SIZE: usize = 16;
pub const ECDH_PUB_SIZE: usize = 65;
/// Init code: session_id ‖ sender pub ‖ size ‖ digest ‖ nbBlocs ‖ kTotal ‖ flags ‖ reserved.
pub const INIT_CODE_SIZE: usize = 16 + 65 + 8 + 32 + 2 + 2 + 1 + 1;
/// Response code: session_id ‖ receiver pub ‖ SAS seed.
pub const RESPONSE_CODE_SIZE: usize = 16 + 65 + 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitCodeInfo {
    pub session_id: Vec<u8>,
    pub sender_pub: Vec<u8>,
    pub stream_size: u64,
    /// SHA-256 of the transferred stream (compressed if applicable, before encryption).
    pub stream_digest: Vec<u8>,
    /// Written on 16 bits (modulo 2¹⁶, like `setUint16`).
    pub block_count: u32,
    /// Written on 16 bits (modulo 2¹⁶, like `setUint16`).
    pub k_total: u32,
    pub compressed: bool,
    /// Pairing by shared PASSPHRASE (§7.2) — session flags, bit 1.
    pub by_passphrase: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SessionKeys {
    pub data_key: Vec<u8>,
    pub nonce_key: Vec<u8>,
    /// 6-digit SAS — the only artifact meant for the users' eyes.
    pub sas: String,
    pub sas_seed: u32,
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
    pub sas_seed: u32,
}

/// Short token: the first 4 bytes of the session_id, big-endian.
pub fn token_of(session_id: &[u8]) -> u32 {
    let mut o = [0u8; 4];
    for (i, v) in o.iter_mut().enumerate() {
        *v = session_id.get(i).copied().unwrap_or(0);
    }
    u32::from_be_bytes(o)
}

pub fn write_init_code(i: &InitCodeInfo) -> Result<Vec<u8>, OrpError> {
    if i.session_id.len() != SESSION_ID_SIZE {
        return Err(OrpError::InvalidPairingCode("session_id of unexpected size".into()));
    }
    if i.sender_pub.len() != ECDH_PUB_SIZE {
        return Err(OrpError::InvalidPairingCode("public key of unexpected size".into()));
    }
    if i.stream_digest.len() != 32 {
        return Err(OrpError::InvalidPairingCode("digest of unexpected size".into()));
    }
    let mut o = Vec::with_capacity(INIT_CODE_SIZE);
    o.extend_from_slice(&i.session_id);
    o.extend_from_slice(&i.sender_pub);
    o.extend_from_slice(&i.stream_size.to_be_bytes());
    o.extend_from_slice(&i.stream_digest);
    o.extend_from_slice(&(i.block_count as u16).to_be_bytes());
    o.extend_from_slice(&(i.k_total as u16).to_be_bytes());
    o.push(if i.compressed { 0x01 } else { 0 } | if i.by_passphrase { 0x02 } else { 0 });
    o.push(0); // reserved
    Ok(o)
}

pub fn read_init_code(o: &[u8]) -> Result<InitCodeInfo, OrpError> {
    if o.len() != INIT_CODE_SIZE {
        return Err(OrpError::InvalidPairingCode(format!(
            "init code of {} bytes, {INIT_CODE_SIZE} expected",
            o.len()
        )));
    }
    Ok(InitCodeInfo {
        session_id: o[0..16].to_vec(),
        sender_pub: o[16..81].to_vec(),
        stream_size: u64::from_be_bytes(o[81..89].try_into().unwrap()),
        stream_digest: o[89..121].to_vec(),
        block_count: u16::from_be_bytes([o[121], o[122]]) as u32,
        k_total: u16::from_be_bytes([o[123], o[124]]) as u32,
        compressed: o[125] & 0x01 != 0,
        by_passphrase: o[125] & 0x02 != 0,
    })
}

pub fn write_response_code(session_id: &[u8], receiver_pub: &[u8], sas_seed: u32) -> Result<Vec<u8>, OrpError> {
    if session_id.len() != SESSION_ID_SIZE || receiver_pub.len() != ECDH_PUB_SIZE {
        return Err(OrpError::InvalidPairingCode("fields of unexpected size for the response code".into()));
    }
    let mut o = Vec::with_capacity(RESPONSE_CODE_SIZE);
    o.extend_from_slice(session_id);
    o.extend_from_slice(receiver_pub);
    o.extend_from_slice(&sas_seed.to_be_bytes());
    Ok(o)
}

pub fn read_response_code(o: &[u8]) -> Result<ResponseCode, OrpError> {
    if o.len() != RESPONSE_CODE_SIZE {
        return Err(OrpError::InvalidPairingCode(format!(
            "response code of {} bytes, {RESPONSE_CODE_SIZE} expected",
            o.len()
        )));
    }
    Ok(ResponseCode {
        session_id: o[0..16].to_vec(),
        receiver_pub: o[16..81].to_vec(),
        sas_seed: u32::from_be_bytes(o[81..85].try_into().unwrap()),
    })
}

const SAS_INFO: &str = "ORP v0.1 SAS";

/// Derives the session key set from a shared secret.
pub fn derive_keys(
    crypto: &dyn CryptoProvider,
    secret: &[u8],
    session_id: &[u8],
    sas_seed: u32,
) -> Result<SessionKeys, OrpError> {
    let data_key = crypto.derive_hkdf(secret, session_id, "ORP v0.1 donnees", 32)?;
    let nonce_key = crypto.derive_hkdf(secret, session_id, "ORP v0.1 nonce", 32)?;
    let mut salt = session_id.to_vec();
    salt.extend_from_slice(&sas_seed.to_be_bytes());
    let o = crypto.derive_hkdf(secret, &salt, SAS_INFO, 4)?;
    let value = u32::from_be_bytes([o[0], o[1], o[2], o[3]]);
    Ok(SessionKeys { data_key, nonce_key, sas: format!("{:06}", value % 1_000_000), sas_seed })
}

/// Degraded mode: secret derived from a passphrase typed by both users.
/// The minimum length is counted in UTF-16 units, like `String.length`.
pub fn derive_secret_from_passphrase(
    crypto: &dyn CryptoProvider,
    passphrase: &str,
    session_id: &[u8],
) -> Result<Vec<u8>, OrpError> {
    if passphrase.encode_utf16().count() < 8 {
        return Err(OrpError::InvalidPairingCode(
            "pairing passphrase too short (at least 8 characters)".into(),
        ));
    }
    crypto.derive_hkdf(passphrase.as_bytes(), session_id, "ORP v0.1 phrase", 32)
}

/// Passphrase mode: the full key set, with the SAS seed DERIVED from the
/// secret — identical on both sides without coordination.
pub fn derive_keys_from_passphrase(
    crypto: &dyn CryptoProvider,
    passphrase: &str,
    session_id: &[u8],
) -> Result<SessionKeys, OrpError> {
    let secret = derive_secret_from_passphrase(crypto, passphrase, session_id)?;
    let o = crypto.derive_hkdf(&secret, session_id, "ORP v0.1 graine SAS", 4)?;
    let sas_seed = u32::from_be_bytes([o[0], o[1], o[2], o[3]]);
    derive_keys(crypto, &secret, session_id, sas_seed)
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
    // Volatile write: the optimizer cannot remove the wipe.
    for o in keys.data_key.iter_mut().chain(keys.nonce_key.iter_mut()) {
        unsafe { std::ptr::write_volatile(o, 0) };
    }
}
