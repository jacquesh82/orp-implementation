//! Typed ORP errors (port of errors.ts) — every failure has a name, never an
//! ambiguous string. Messages never carry a secret: public identifiers only
//! (token, blocks, seeds, versions). The texts are the TypeScript ones, word
//! for word.

use crate::versions::Version;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrpError {
    /// Incompatible protocol version (OrpVersionIncompatible).
    IncompatibleVersion { received: Version, supported: Version },
    /// Unknown session token (OrpSessionInconnue).
    UnknownSession(u32),
    /// Unreadable or inconsistent frame (OrpTrameInvalide).
    InvalidFrame(String),
    /// Wrong CRC-32 after Reed-Solomon correction (OrpTrameCorrompue).
    CorruptedFrame { block: u32, seed: u32 },
    /// AEAD authentication failed (OrpTrameFalsifiee).
    ForgedFrame { block: u32, seed: u32 },
    /// Frame already received (OrpRejeu).
    Replay { block: u32, seed: u32 },
    /// More than 4 wrong bytes in a slice (OrpCorrectionImpossible).
    CorrectionImpossible,
    /// Whole-file integrity check failed (OrpIntegrite).
    Integrity(String),
    /// Forbidden state machine transition (OrpEtatInvalide).
    InvalidState { action: String, state: String },
    /// Missing or incomplete pairing (OrpAppairageRequis).
    PairingRequired(String),
    /// Malformed init or response code (OrpCodeAppairageInvalide).
    InvalidPairingCode(String),
    /// Compression unavailable (OrpCompressionIndisponible) — never raised
    /// natively, kept so that the codes match.
    CompressionUnavailable,
    /// The TS generic `OrpErreur`, with its machine code ("aucun-codec",
    /// "k-incoherent", "codec-refuse", "crypto-indisponible"…).
    Generic { code: String, message: String },
    /// Non-protocol errors (call parameters, fountain…): the TS throws a bare
    /// `Error` in those places.
    Other(String),
}

impl OrpError {
    /// Stable machine code — identical to the `code` field of the TS errors.
    pub fn code(&self) -> &str {
        match self {
            OrpError::IncompatibleVersion { .. } => "version-incompatible",
            OrpError::UnknownSession(_) => "session-inconnue",
            OrpError::InvalidFrame(_) => "trame-invalide",
            OrpError::CorruptedFrame { .. } => "trame-corrompue",
            OrpError::ForgedFrame { .. } => "trame-falsifiee",
            OrpError::Replay { .. } => "rejeu",
            OrpError::CorrectionImpossible => "correction-impossible",
            OrpError::Integrity(_) => "integrite",
            OrpError::InvalidState { .. } => "etat-invalide",
            OrpError::PairingRequired(_) => "appairage-requis",
            OrpError::InvalidPairingCode(_) => "code-appairage-invalide",
            OrpError::CompressionUnavailable => "compression-indisponible",
            OrpError::Generic { code, .. } => code,
            OrpError::Other(_) => "other",
        }
    }

    pub(crate) fn generic(code: &str, message: impl Into<String>) -> Self {
        OrpError::Generic { code: code.to_string(), message: message.into() }
    }

    pub(crate) fn invalid_state(action: &str, state: &str) -> Self {
        OrpError::InvalidState { action: action.to_string(), state: state.to_string() }
    }
}

impl std::fmt::Display for OrpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrpError::IncompatibleVersion { received, supported } => write!(
                f,
                "ORP frame {}.{} incompatible with {}.{}",
                received.major, received.minor, supported.major, supported.minor
            ),
            OrpError::UnknownSession(j) => write!(f, "session token 0x{j:08x} unknown"),
            OrpError::InvalidFrame(m) => write!(f, "{m}"),
            OrpError::CorruptedFrame { block, seed } => write!(f, "invalid CRC — block {block}, seed {seed}"),
            OrpError::ForgedFrame { block, seed } => {
                write!(f, "authentication failed — block {block}, seed {seed}")
            }
            OrpError::Replay { block, seed } => write!(f, "frame already received — block {block}, seed {seed}"),
            OrpError::CorrectionImpossible => write!(f, "Reed-Solomon: more than 4 erroneous bytes in the frame"),
            OrpError::Integrity(d) => write!(f, "file integrity check failed: {d}"),
            OrpError::InvalidState { action, state } => write!(f, "action \"{action}\" forbidden in state \"{state}\""),
            OrpError::PairingRequired(d) => write!(f, "{d}"),
            OrpError::InvalidPairingCode(d) => write!(f, "{d}"),
            OrpError::CompressionUnavailable => write!(f, "CompressionStream unavailable on this platform"),
            OrpError::Generic { message, .. } => write!(f, "{message}"),
            OrpError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for OrpError {}
