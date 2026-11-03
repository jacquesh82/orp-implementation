//! ORP v0.1 frame format (port of frames.ts) — frozen by
//! docs/orp-protocol-v0.1.md.
//!
//!   1. Tripled META — 3 copies of 8 bytes, majority vote byte by byte:
//!      magic, version, codec, flags, symbol_count.
//!   2. BODY in Reed-Solomon slices — body header (14 B), payload
//!      (symbol_count × 96 B), AEAD tag (16 B if encrypted), CRC-32 (4 B),
//!      cut into slices of at most 247 B, each followed by 8 B of RS(255)
//!      parity.
//!
//! Everything is big-endian. The CRC covers body header + payload + tag; the
//! AEAD authenticates majority meta + body header (AAD).

use crate::errors::OrpError;
use crate::rs::{correct_rs, rs_parity, RS_PARITY};
pub use crate::versions::Version;
use crate::versions::PROTOCOL_VERSION;

/// Size of a source symbol (bytes) — a constant of the version.
pub const SYMBOL_SIZE: usize = 96;
/// Maximum number of source symbols in a block.
pub const K_MAX: usize = 1024;
/// Maximum number of fountain symbols carried by a frame.
pub const MAX_SYMBOLS: usize = 4;
/// Size of the meta (one copy).
pub const META_SIZE: usize = 8;
/// Number of meta copies.
pub const META_COPIES: usize = 3;
/// Size of the body header (token, block, K, seed).
pub const BODY_HEADER_SIZE: usize = 14;
/// Maximum size of an RS slice (255 − 8 parity).
pub const SLICE_SIZE: usize = 247;
/// Size of the AEAD authentication tag (bytes).
pub const TAG_SIZE: usize = 16;
/// Size of the CRC-32 (bytes).
pub const CRC_SIZE: usize = 4;

/// Meta flags — frozen bits.
pub const FLAG_COMPRESSED: u8 = 0x01;
pub const FLAG_ENCRYPTED: u8 = 0x02;
pub const FLAG_TEST_PATTERN: u8 = 0x04;
pub const FLAG_PAIRING: u8 = 0x08;

/// Wire codecs — the numeric ids are frozen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Codec {
    Mono2 = 0x01,
    Color4 = 0x02,
    Color8 = 0x03,
}

impl Codec {
    pub fn from_u8(byte: u8) -> Option<Codec> {
        match byte {
            0x01 => Some(Codec::Mono2),
            0x02 => Some(Codec::Color4),
            0x03 => Some(Codec::Color8),
            _ => None,
        }
    }

    /// Codec name (nomCodec).
    pub fn name(self) -> &'static str {
        match self {
            Codec::Mono2 => "MONO_2",
            Codec::Color4 => "COLOR_4",
            Codec::Color8 => "COLOR_8",
        }
    }
}

/// Maximum fountain symbols per frame (CAPACITE_SYMBOLES) — capacity of the
/// frozen v0.1 optical grid (N = 41).
pub fn symbol_capacity(codec: Codec) -> usize {
    match codec {
        Codec::Mono2 => 1,
        Codec::Color4 => 2,
        Codec::Color8 => 4,
    }
}

/// FRAME_VERSION = VERSION_PROTCOLE (0.2).
pub const FRAME_VERSION: Version = PROTOCOL_VERSION;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameHeader {
    pub version: Version,
    pub codec: Codec,
    pub flags: u8,
    /// Session token (short form): first 4 bytes of the session_id.
    pub token: u32,
    pub block: u32,
    /// Number of source symbols in the block (for the fountain decoder).
    pub k: u16,
    /// Fountain symbols carried by this frame (1..4).
    pub symbol_count: u8,
    /// Fountain seed of the FIRST combination; the next ones are seed+1…
    pub seed: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrame {
    pub header: FrameHeader,
    pub payload: Vec<u8>,
    pub tag: Option<Vec<u8>>,
}

// ── CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) ──────────────────

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
};

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &o in bytes {
        c = CRC_TABLE[((c ^ o as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

// ── Sizes ─────────────────────────────────────────────────────────────────

/// Body size (without parity): body header + payload + tag + CRC.
pub fn body_size(symbol_count: usize, encrypted: bool) -> usize {
    BODY_HEADER_SIZE + symbol_count * SYMBOL_SIZE + if encrypted { TAG_SIZE } else { 0 } + CRC_SIZE
}

/// Number of RS slices in the body.
pub fn slice_count(symbol_count: usize, encrypted: bool) -> usize {
    body_size(symbol_count, encrypted).div_ceil(SLICE_SIZE)
}

/// Full frame size on the wire: tripled meta + body + parities.
pub fn frame_size(symbol_count: usize, encrypted: bool) -> usize {
    META_COPIES * META_SIZE + body_size(symbol_count, encrypted) + slice_count(symbol_count, encrypted) * RS_PARITY
}

// ── Meta ──────────────────────────────────────────────────────────────────

/// Meta of a frame (8 B) — exposed to build the AAD on the sending side.
pub fn write_meta(e: &FrameHeader) -> Result<[u8; META_SIZE], OrpError> {
    if e.flags & !0x0f != 0 {
        return Err(OrpError::InvalidFrame("reserved flag bits set".into()));
    }
    Ok([0x4f, 0x52, e.version.major, e.version.minor, e.codec as u8, e.flags & 0x0f, e.symbol_count, 0])
}

/// Byte-by-byte majority vote over the 3 copies; `None` if a byte is undecidable.
fn vote_meta(raw: &[u8]) -> Option<[u8; META_SIZE]> {
    let mut meta = [0u8; META_SIZE];
    for (i, m) in meta.iter_mut().enumerate() {
        let a = raw[i];
        let b = raw[i + META_SIZE];
        let c = raw[i + 2 * META_SIZE];
        *m = if a == b || a == c {
            a
        } else if b == c {
            b
        } else {
            return None;
        };
    }
    Some(meta)
}

/// Reads the meta by majority; the body fields (token, block, k, seed) stay
/// at zero, filled in by `read_frame`.
pub fn read_meta_by_majority(raw: &[u8]) -> Result<FrameHeader, OrpError> {
    if raw.len() < META_COPIES * META_SIZE {
        return Err(OrpError::InvalidFrame(format!("truncated frame: {} byte(s)", raw.len())));
    }
    let meta = vote_meta(raw)
        .ok_or_else(|| OrpError::InvalidFrame("undecidable meta: the 3 copies diverge".into()))?;
    if meta[0] != 0x4f || meta[1] != 0x52 {
        return Err(OrpError::InvalidFrame("magic missing — this is not an ORP frame".into()));
    }
    let codec = Codec::from_u8(meta[4])
        .ok_or_else(|| OrpError::InvalidFrame(format!("unknown codec: 0x{}", meta[4])))?;
    let flags = meta[5];
    if flags & !0x0f != 0 {
        return Err(OrpError::InvalidFrame("reserved flag bits set".into()));
    }
    let symbol_count = meta[6];
    if symbol_count < 1 || symbol_count as usize > MAX_SYMBOLS {
        return Err(OrpError::InvalidFrame(format!("symbol_count out of range: {symbol_count}")));
    }
    Ok(FrameHeader {
        version: Version { major: meta[2], minor: meta[3] },
        codec,
        flags,
        symbol_count,
        token: 0,
        block: 0,
        k: 0,
        seed: 0,
    })
}

/// Majority meta (8 B) of a raw frame — for the AAD on the receiving side.
pub fn majority_meta(raw: &[u8]) -> Result<[u8; META_SIZE], OrpError> {
    if raw.len() < META_COPIES * META_SIZE {
        return Err(OrpError::InvalidFrame("frame truncated before the meta".into()));
    }
    vote_meta(raw).ok_or_else(|| OrpError::InvalidFrame("undecidable meta".into()))
}

// ── Body ──────────────────────────────────────────────────────────────────

fn check_k(k: u16) -> Result<(), OrpError> {
    if k < 1 || k as usize > K_MAX {
        return Err(OrpError::InvalidFrame(format!("K out of range: {k}")));
    }
    Ok(())
}

/// Body header (14 B) — exposed to build the AAD on the sending side.
pub fn write_body_header(e: &FrameHeader) -> Result<[u8; BODY_HEADER_SIZE], OrpError> {
    check_k(e.k)?;
    let mut o = [0u8; BODY_HEADER_SIZE];
    o[0..4].copy_from_slice(&e.token.to_be_bytes());
    o[4..8].copy_from_slice(&e.block.to_be_bytes());
    o[8..10].copy_from_slice(&e.k.to_be_bytes());
    o[10..14].copy_from_slice(&e.seed.to_be_bytes());
    Ok(o)
}

fn write_body(e: &FrameHeader, payload: &[u8], tag: Option<&[u8]>) -> Result<Vec<u8>, OrpError> {
    let encrypted = e.flags & FLAG_ENCRYPTED != 0;
    if encrypted != tag.is_some() {
        return Err(OrpError::InvalidFrame("ENCRYPTED flag and tag disagree".into()));
    }
    if payload.len() != e.symbol_count as usize * SYMBOL_SIZE {
        return Err(OrpError::InvalidFrame(format!(
            "payload of {} bytes ≠ {} × {}",
            payload.len(),
            e.symbol_count,
            SYMBOL_SIZE
        )));
    }
    // The TS zero-pads a short tag and crashes on a long one: here, any tag
    // of another size is rejected.
    if let Some(t) = tag {
        if t.len() != TAG_SIZE {
            return Err(OrpError::InvalidFrame(format!("tag of {} bytes ≠ {TAG_SIZE}", t.len())));
        }
    }
    let header = write_body_header(e)?;
    let mut body = Vec::with_capacity(body_size(e.symbol_count as usize, encrypted));
    body.extend_from_slice(&header);
    body.extend_from_slice(payload);
    if let Some(t) = tag {
        body.extend_from_slice(t);
    }
    let crc = crc32(&body);
    body.extend_from_slice(&crc.to_be_bytes());
    Ok(body)
}

/// Assembles the full frame, ready for the optical layer.
pub fn build_frame(e: &FrameHeader, payload: &[u8], tag: Option<&[u8]>) -> Result<Vec<u8>, OrpError> {
    let encrypted = e.flags & FLAG_ENCRYPTED != 0;
    let body = write_body(e, payload, tag)?;
    let meta = write_meta(e)?;
    let mut frame = Vec::with_capacity(frame_size(e.symbol_count as usize, encrypted));
    for _ in 0..META_COPIES {
        frame.extend_from_slice(&meta);
    }
    for slice in body.chunks(SLICE_SIZE) {
        frame.extend_from_slice(slice);
        frame.extend_from_slice(&rs_parity(slice));
    }
    Ok(frame)
}

/// Reads a raw frame: meta by majority, slices corrected by Reed-Solomon (on
/// a copy), CRC checked. Bytes beyond the expected length (grid padding) are
/// ignored.
pub fn read_frame(raw: &[u8]) -> Result<ParsedFrame, OrpError> {
    let mut header = read_meta_by_majority(raw)?;
    let encrypted = header.flags & FLAG_ENCRYPTED != 0;
    let nb = header.symbol_count as usize;
    let expected = frame_size(nb, encrypted);
    if raw.len() < expected {
        return Err(OrpError::InvalidFrame(format!(
            "truncated frame: {} byte(s), {expected} expected",
            raw.len()
        )));
    }
    let length = body_size(nb, encrypted);
    let mut body = Vec::with_capacity(length);
    let mut source = META_COPIES * META_SIZE;
    while body.len() < length {
        let size = SLICE_SIZE.min(length - body.len());
        let mut slice = raw[source..source + size + RS_PARITY].to_vec();
        // Like the TS: block and seed are still zero at this point.
        correct_rs(&mut slice).map_err(|e| match e {
            OrpError::CorrectionImpossible => OrpError::CorruptedFrame { block: header.block, seed: header.seed },
            other => other,
        })?;
        body.extend_from_slice(&slice[..size]);
        source += size + RS_PARITY;
    }
    let end = length - CRC_SIZE;
    let read_crc = u32::from_be_bytes(body[end..].try_into().unwrap());
    if read_crc != crc32(&body[..end]) {
        return Err(OrpError::CorruptedFrame { block: header.block, seed: header.seed });
    }
    header.token = u32::from_be_bytes(body[0..4].try_into().unwrap());
    header.block = u32::from_be_bytes(body[4..8].try_into().unwrap());
    header.k = u16::from_be_bytes(body[8..10].try_into().unwrap());
    check_k(header.k)?;
    header.seed = u32::from_be_bytes(body[10..14].try_into().unwrap());
    let payload_end = BODY_HEADER_SIZE + nb * SYMBOL_SIZE;
    let payload = body[BODY_HEADER_SIZE..payload_end].to_vec();
    let tag = encrypted.then(|| body[payload_end..payload_end + TAG_SIZE].to_vec());
    Ok(ParsedFrame { header, payload, tag })
}

/// AEAD AAD: majority meta (8 B) + body header (14 B).
pub fn frame_aad(meta: &[u8], body_header: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(META_SIZE + BODY_HEADER_SIZE);
    aad.extend_from_slice(meta);
    aad.extend_from_slice(body_header);
    aad
}

/// Plaintext body header (14 B) of a corrected body — for the AAD.
pub fn body_header_of(body: &[u8]) -> Vec<u8> {
    body[..BODY_HEADER_SIZE].to_vec()
}
