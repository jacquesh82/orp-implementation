//! Optional compression (port of compression.ts), negotiated by the
//! COMPRESSE flag: deflate-raw (RFC 1951, no header), like
//! `CompressionStream("deflate-raw")`.
//!
//! We go through zlib itself (flate2 on libz: the system one on Linux, the
//! platform libz on Android) with the browser's parameters — level 6,
//! window 2¹⁵, memLevel 8, default strategy — which yields the same stream,
//! byte for byte, as Node and Chromium on the vectors. Interoperability does
//! not depend on it: the receiver decompresses any valid deflate-raw, and the
//! init code digest covers the stream actually sent.

use std::io::{Read, Write};

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;

use crate::errors::OrpError;

/// zlib's default level (Z_DEFAULT_COMPRESSION), the one CompressionStream uses.
const LEVEL: u32 = 6;

/// Compresses to deflate-raw; `None` if the gain is zero or negative ("stored"
/// mode without compression, like the TS).
pub fn compress(data: &[u8]) -> Option<Vec<u8>> {
    let mut e = DeflateEncoder::new(Vec::new(), Compression::new(LEVEL));
    e.write_all(data).ok()?;
    let compressed = e.finish().ok()?;
    (compressed.len() < data.len()).then_some(compressed)
}

/// Decompresses a deflate-raw stream, without bound.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>, OrpError> {
    decompress_bounded(data, usize::MAX)
}

/// Decompresses a deflate-raw stream, stopping past `max_output` bytes
/// (deflate bomb) with the error `taille-excessive` — like the TS
/// `decompress(data, maxOutput)`. Never more than `max_output + 1` bytes are
/// produced in memory.
pub fn decompress_bounded(data: &[u8], max_output: usize) -> Result<Vec<u8>, OrpError> {
    let mut output = Vec::new();
    let limit = (max_output as u64).saturating_add(1);
    DeflateDecoder::new(data)
        .take(limit)
        .read_to_end(&mut output)
        .map_err(|e| OrpError::Other(format!("deflate-raw decompression failed: {e}")))?;
    if output.len() > max_output {
        return Err(OrpError::generic("taille-excessive", format!("decompressed data larger than {max_output} bytes")));
    }
    Ok(output)
}
