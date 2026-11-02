//! ORP wire protocol versioning (port of versions.ts) — independent of
//! package versioning.
//!
//! Frozen rule (v0.1): a receiver accepts a sender with the same MAJOR
//! version whose MINOR is lower than or equal to its own. Any other
//! combination is rejected explicitly (F-21).

use crate::errors::OrpError;

/// Protocol version (VersionProtocole).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Version {
    pub major: u8,
    pub minor: u8,
}

/// Wire version described by docs/orp-protocol-v0.1.md (VERSION_PROTCOLE).
pub const PROTOCOL_VERSION: Version = Version { major: 0, minor: 1 };

/// Comparison: negative, zero or positive, like `comparerVersion`.
pub fn compare_version(a: Version, b: Version) -> i32 {
    if a.major != b.major {
        a.major as i32 - b.major as i32
    } else {
        a.minor as i32 - b.minor as i32
    }
}

pub fn is_version_compatible(sender: Version, receiver: Version) -> bool {
    sender.major == receiver.major && sender.minor <= receiver.minor
}

/// Explicitly rejects an incompatible version (F-21).
pub fn require_compatible_version(sender: Version, receiver: Version) -> Result<(), OrpError> {
    if is_version_compatible(sender, receiver) {
        Ok(())
    } else {
        Err(OrpError::IncompatibleVersion { received: sender, supported: receiver })
    }
}

pub fn to_bytes(v: Version) -> [u8; 2] {
    [v.major, v.minor]
}

pub fn from_bytes(o: &[u8]) -> Version {
    Version { major: o.first().copied().unwrap_or(0), minor: o.get(1).copied().unwrap_or(0) }
}
