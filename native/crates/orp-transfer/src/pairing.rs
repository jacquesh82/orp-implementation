//! Pairing frames (packages/browser/src/tm.ts).

use orp_core::{read_frame, FLAG_PAIRING};

/// Shared passphrase of the TEST BENCH (pairing §7.2) — public: it proves
/// that we read the same transfer, not who is sending.
pub const BENCH_PASSPHRASE: &str = "optirelay-banc";

/// Payload of a pairing frame that was read (truncated to `size`), or None.
pub fn pairing_payload(bytes: &[u8], size: usize) -> Option<Vec<u8>> {
    let parsed = read_frame(bytes).ok()?;
    if parsed.header.flags & FLAG_PAIRING == 0 {
        return None;
    }
    Some(parsed.payload[..size.min(parsed.payload.len())].to_vec())
}

pub fn is_pairing_frame(bytes: &[u8]) -> bool {
    read_frame(bytes).map(|l| l.header.flags & FLAG_PAIRING != 0).unwrap_or(false)
}
