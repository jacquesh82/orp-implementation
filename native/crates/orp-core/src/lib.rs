//! ORP protocol — Rust port of `packages/core` (TypeScript), byte for byte.
//! Checked against the vectors in `native/vectors/core/` (generated from the
//! TS by `native/vectors/generate-core.ts`).
//!
//! CONTRACT used by `orp-optics` (names and signatures frozen):
//! - `Codec` (Mono2 = 0x01, Color4 = 0x02, Color8 = 0x03), `Codec::from_u8(u8)`
//! - `SYMBOL_SIZE`, `symbol_capacity(Codec)`, `FLAG_*`
//! - `Version`, `FRAME_VERSION`, `FrameHeader`, `build_frame`, `read_frame` → `ParsedFrame`
//! - `crc32`, `Mulberry32`

pub mod random;
pub mod pairing;
pub mod blocks;
pub mod encryption;
pub mod compression;
pub mod errors;
pub mod fountain;
pub mod log;
pub mod rs;
pub mod session;
pub mod frames;
pub mod versions;

pub use random::{MulberryRandom, SystemRandom, Mulberry32, RandomSource};
pub use encryption::{CryptoRust, CryptoProvider, EcdhPair};
pub use fountain::{fountain_symbol, lt_neighbors, FountainDecoder};
pub use session::{
    Encryption, BlockState, SessionState, SenderEvent, ReceiverEvent, EndReason, TransmissionOptions, ReceiveProgress,
    Rejection, ReceiveResult, SenderSession, ReceiverSession, FrameStatus, PairingMode,
};
pub use errors::OrpError;
pub use rs::{correct_rs, rs_parity, RS_PARITY};
pub use frames::{
    symbol_capacity, build_frame, crc32, read_frame, Codec, FrameHeader, ParsedFrame, Version, FLAG_PAIRING,
    FLAG_ENCRYPTED, FLAG_COMPRESSED, FLAG_TEST_PATTERN, K_MAX, MAX_SYMBOLS, SYMBOL_SIZE, FRAME_VERSION,
};
pub use versions::PROTOCOL_VERSION;
