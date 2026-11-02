//! Splitting of the stream into symbols and blocks (port of blocks.ts):
//! SYMBOL_SIZE bytes per symbol, at most K_MAX symbols per block. The last
//! symbol is zero-padded — the actual stream size travels in the init
//! code.

use crate::errors::OrpError;
use crate::frames::{K_MAX, SYMBOL_SIZE};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockPlan {
    /// Source symbols, in order — the last one is zero-padded.
    pub symbols: Vec<Vec<u8>>,
    /// K of block b (blocks numbered from 0).
    pub k_per_block: Vec<usize>,
    /// Actual stream size (the padding of the last symbol does not count).
    pub stream_size: usize,
}

/// The TS `planifier(flux)`, with the default values.
pub fn plan_blocks(stream: &[u8]) -> BlockPlan {
    plan_with(stream, SYMBOL_SIZE, K_MAX).expect("default parameters are valid")
}

pub fn plan_with(stream: &[u8], symbol_size: usize, k_max: usize) -> Result<BlockPlan, OrpError> {
    if symbol_size < 1 {
        return Err(OrpError::Other("planBlocks: zero symbol size".into()));
    }
    if !(1..=K_MAX).contains(&k_max) {
        return Err(OrpError::Other("planBlocks: K_MAX exceeded".into()));
    }
    let symbol_count = stream.len().div_ceil(symbol_size);
    let block_count = symbol_count.div_ceil(k_max);
    let mut symbols = Vec::with_capacity(symbol_count);
    let mut k_per_block = Vec::with_capacity(block_count);
    for b in 0..block_count {
        let start = b * k_max * symbol_size;
        let end = (start + k_max * symbol_size).min(stream.len());
        let k = (end - start).div_ceil(symbol_size);
        k_per_block.push(k);
        for j in 0..k {
            let d = start + j * symbol_size;
            let f = (d + symbol_size).min(end);
            let mut s = vec![0u8; symbol_size];
            s[..f - d].copy_from_slice(&stream[d..f]);
            symbols.push(s);
        }
    }
    Ok(BlockPlan { symbols, k_per_block, stream_size: stream.len() })
}

impl BlockPlan {
    pub fn block_count(&self) -> usize {
        self.k_per_block.len()
    }

    pub fn k_total(&self) -> usize {
        self.k_per_block.iter().sum()
    }

    /// Source symbols of block b (K_MAX by default).
    pub fn block_symbols(&self, block: usize) -> Result<&[Vec<u8>], OrpError> {
        self.block_symbols_with(block, K_MAX)
    }

    pub fn block_symbols_with(&self, block: usize, k_max: usize) -> Result<&[Vec<u8>], OrpError> {
        if block >= self.block_count() {
            return Err(OrpError::Other(format!("planBlocks: block {block} out of range")));
        }
        let start = block * k_max;
        let end = (start + self.k_per_block[block]).min(self.symbols.len());
        Ok(&self.symbols[start.min(end)..end])
    }
}

/// Reassembles the symbols into a stream, truncated to the actual size.
pub fn assemble<S: AsRef<[u8]>>(symbols: &[S], stream_size: usize) -> Vec<u8> {
    let mut stream = vec![0u8; symbols.len() * SYMBOL_SIZE];
    for (n, s) in symbols.iter().enumerate() {
        let s = s.as_ref();
        let l = s.len().min(SYMBOL_SIZE);
        stream[n * SYMBOL_SIZE..n * SYMBOL_SIZE + l].copy_from_slice(&s[..l]);
    }
    stream.truncate(stream_size.min(stream.len()));
    stream
}
