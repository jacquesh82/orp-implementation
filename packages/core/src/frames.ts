/**
 * ORP v0.1 frame format — frozen by docs/orp-protocol-v0.1.md.
 *
 * A frame is made of two zones:
 *
 *   1. Tripled META — 3 copies of 8 bytes (24 B in total), decided by a
 *      byte-wise majority vote. Carries what is needed to know the LENGTH of
 *      the frame before any correction: magic, version, codec, flags,
 *      nb_symboles. Without it, a decoder would not know where the segments
 *      and their parity are.
 *   2. BODY in Reed-Solomon segments — the body header (14 B), the payload
 *      (nb_symboles × 96 B), the AEAD tag (16 B if encrypted) and the CRC-32
 *      (4 B), split into segments of at most 247 B, each followed by 8 B of
 *      RS(255) parity. An RS codeword over GF(256) cannot exceed 255 B —
 *      hence the segments, each of which corrects up to 4 errors.
 *
 * Everything is big-endian. The CRC covers body header + payload + tag;
 * the AEAD authenticates majority meta + body header (AAD).
 *
 * The French messages of the OrpInvalidFrame errors raised while reading a
 * frame are kept as is: docs/orptests/corruption-vectors.json embeds them.
 */

import { OrpUncorrectable, OrpCorruptedFrame, OrpInvalidFrame } from "./errors.ts";
import { PROTOCOL_VERSION, ProtocolVersion } from "./versions.ts";
import { rsParity, rsCorrect, RS_PARITY } from "./rs.ts";

/** Size of a source symbol (B) — a constant of the version. */
export const SYMBOL_SIZE = 96;
/** Maximum number of source symbols in a block. */
export const K_MAX = 1024;
/** Maximum number of fountain symbols carried by a frame. */
export const MAX_FRAME_SYMBOLS = 4;
/** Size of the meta (one copy). */
export const META_SIZE = 8;
/** Number of meta copies. */
export const META_COPIES = 3;
/** Size of the body header (token, block, K, seed). */
export const BODY_HEADER_SIZE = 14;
/** Maximum size of an RS segment (255 − 8 of parity). */
export const SEGMENT_SIZE = 247;
/** Size of the AEAD authentication tag (B). */
export const TAG_SIZE = 16;
/** Size of the CRC-32 (B). */
export const CRC_SIZE = 4;

/** Wire codecs — the numeric identifiers are frozen. */
export const CODEC = {
  MONO_2: 0x01,
  COLOR_4: 0x02,
  COLOR_8: 0x03,
} as const;
export type Codec = (typeof CODEC)[keyof typeof CODEC];

export const codecName: Record<number, string> = {
  [CODEC.MONO_2]: "MONO_2",
  [CODEC.COLOR_4]: "COLOR_4",
  [CODEC.COLOR_8]: "COLOR_8",
};

/** Meta flags — frozen bits. */
export const FLAG = {
  COMPRESSED: 0x01,
  ENCRYPTED: 0x02,
  TEST_PATTERN: 0x04,
  PAIRING: 0x08,
} as const;

/**
 * Maximum fountain symbols per frame and per codec — capacity of the frozen
 * v0.1 optical grid (N = 41, see docs/orp-protocol-v0.1.md §9): the whole
 * frame must fit in the data modules of the grid.
 */
export const SYMBOL_CAPACITY: Record<number, number> = {
  [CODEC.MONO_2]: 1,
  [CODEC.COLOR_4]: 2,
  [CODEC.COLOR_8]: 4,
};

export interface FrameHeader {
  version: ProtocolVersion;
  codec: Codec;
  flags: number;
  /** Session token (short form): first 4 bytes of the session_id. */
  token: number;
  block: number;
  /** Number of source symbols of the block (for the fountain decoder). */
  k: number;
  /** Fountain symbols carried by this frame (1..4). */
  symbolCount: number;
  /** Fountain seed of the FIRST combination; the next ones are seed+1… */
  seed: number;
}

// ── CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) ──────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Sizes ─────────────────────────────────────────────────────────────────

/** Body size (without parity): body header + payload + tag + CRC. */
export function bodySize(symbolCount: number, encrypted: boolean): number {
  return BODY_HEADER_SIZE + symbolCount * SYMBOL_SIZE + (encrypted ? TAG_SIZE : 0) + CRC_SIZE;
}

/** Number of RS segments of the body. */
export function segmentCount(symbolCount: number, encrypted: boolean): number {
  return Math.ceil(bodySize(symbolCount, encrypted) / SEGMENT_SIZE);
}

/** Full size of the frame on the wire: tripled meta + body + parities. */
export function frameSize(symbolCount: number, encrypted: boolean): number {
  return META_COPIES * META_SIZE + bodySize(symbolCount, encrypted) + segmentCount(symbolCount, encrypted) * RS_PARITY;
}

// ── Meta ──────────────────────────────────────────────────────────────────

/** Meta of a frame (8 B) — exposed to build the AAD on the sending side. */
export function writeMeta(e: FrameHeader): Uint8Array {
  if (e.flags & ~0x0f) throw new OrpInvalidFrame("reserved flag bits set");
  const o = new Uint8Array(META_SIZE);
  o[0] = 0x4f;
  o[1] = 0x52; // "OR"
  o[2] = e.version.major;
  o[3] = e.version.minor;
  o[4] = e.codec;
  o[5] = e.flags & 0x0f;
  o[6] = e.symbolCount;
  o[7] = 0; // reserved
  return o;
}

/** Majority vote over the 3 meta copies. */
export function readMetaByMajority(raw: Uint8Array): FrameHeader {
  const min = META_COPIES * META_SIZE;
  if (raw.length < min) throw new OrpInvalidFrame(`truncated frame: ${raw.length} byte(s)`);
  const meta = new Uint8Array(META_SIZE);
  for (let i = 0; i < META_SIZE; i++) {
    const a = raw[i]!;
    const b = raw[i + META_SIZE]!;
    const c = raw[i + 2 * META_SIZE]!;
    meta[i] = a === b || a === c ? a : b === c ? b : (() => { throw new OrpInvalidFrame("undecidable meta: the 3 copies diverge"); })();
  }
  if (meta[0] !== 0x4f || meta[1] !== 0x52) throw new OrpInvalidFrame("magic missing — this is not an ORP frame");
  const codec = meta[4] as Codec;
  if (codec !== CODEC.MONO_2 && codec !== CODEC.COLOR_4 && codec !== CODEC.COLOR_8) {
    throw new OrpInvalidFrame(`unknown codec: 0x${String(codec)}`);
  }
  const flags = meta[5]!;
  if (flags & ~0x0f) throw new OrpInvalidFrame("reserved flag bits set");
  const symbolCount = meta[6]!;
  if (symbolCount < 1 || symbolCount > MAX_FRAME_SYMBOLS) {
    throw new OrpInvalidFrame(`symbol_count out of range: ${symbolCount}`);
  }
  return {
    version: { major: meta[2]!, minor: meta[3]! },
    codec,
    flags,
    symbolCount,
    // The body fields are filled in by readFrame.
    token: 0,
    block: 0,
    k: 0,
    seed: 0,
  };
}

// ── Body ──────────────────────────────────────────────────────────────────

/** Body header (14 B) — exposed to build the AAD on the sending side. */
export function writeBodyHeader(e: FrameHeader): Uint8Array {
  if (e.k < 1 || e.k > K_MAX) throw new OrpInvalidFrame(`K out of range: ${e.k}`);
  const o = new Uint8Array(BODY_HEADER_SIZE);
  const view = new DataView(o.buffer);
  view.setUint32(0, e.token >>> 0);
  view.setUint32(4, e.block >>> 0);
  view.setUint16(8, e.k);
  view.setUint32(10, e.seed >>> 0);
  return o;
}

function writeBody(e: FrameHeader, payload: Uint8Array, tag?: Uint8Array): { body: Uint8Array; crc: number } {
  const encrypted = (e.flags & FLAG.ENCRYPTED) !== 0;
  if (encrypted !== Boolean(tag)) throw new OrpInvalidFrame("ENCRYPTED flag and tag disagree");
  if (payload.length !== e.symbolCount * SYMBOL_SIZE) {
    throw new OrpInvalidFrame(`payload of ${payload.length} bytes ≠ ${e.symbolCount} × ${SYMBOL_SIZE}`);
  }
  if (e.k < 1 || e.k > K_MAX) throw new OrpInvalidFrame(`K out of range: ${e.k}`);
  const body = new Uint8Array(bodySize(e.symbolCount, encrypted));
  const view = new DataView(body.buffer);
  view.setUint32(0, e.token >>> 0);
  view.setUint32(4, e.block >>> 0);
  view.setUint16(8, e.k);
  view.setUint32(10, e.seed >>> 0);
  body.set(payload, BODY_HEADER_SIZE);
  if (tag) body.set(tag, BODY_HEADER_SIZE + payload.length);
  const crc = crc32(body.subarray(0, body.length - CRC_SIZE));
  view.setUint32(body.length - CRC_SIZE, crc);
  return { body, crc };
}

/** Assembles the full frame, ready for the optical layer. */
export function buildFrame(e: FrameHeader, payload: Uint8Array, tag?: Uint8Array): Uint8Array {
  const encrypted = (e.flags & FLAG.ENCRYPTED) !== 0;
  const { body } = writeBody(e, payload, tag);
  const meta = writeMeta(e);
  const segments = segmentCount(e.symbolCount, encrypted);
  const frame = new Uint8Array(frameSize(e.symbolCount, encrypted));
  for (let c = 0; c < META_COPIES; c++) frame.set(meta, c * META_SIZE);
  let source = 0;
  let target = META_COPIES * META_SIZE;
  for (let t = 0; t < segments; t++) {
    const size = Math.min(SEGMENT_SIZE, body.length - source);
    frame.set(body.subarray(source, source + size), target);
    frame.set(rsParity(frame.subarray(target, target + size)), target + size);
    source += size;
    target += size + RS_PARITY;
  }
  return frame;
}

export interface DecodedFrame {
  header: FrameHeader;
  payload: Uint8Array;
  tag?: Uint8Array;
}

/**
 * Reads a raw frame from the channel: meta by majority, segments corrected
 * by Reed-Solomon (in place on a copy), CRC checked. Bytes beyond the
 * expected length (grid padding) are ignored.
 */
export function readFrame(raw: Uint8Array): DecodedFrame {
  const header = readMetaByMajority(raw);
  const encrypted = (header.flags & FLAG.ENCRYPTED) !== 0;
  const expected = frameSize(header.symbolCount, encrypted);
  if (raw.length < expected) {
    throw new OrpInvalidFrame(`truncated frame: ${raw.length} byte(s), ${expected} expected`);
  }
  const body = new Uint8Array(bodySize(header.symbolCount, encrypted));
  let source = META_COPIES * META_SIZE;
  let target = 0;
  const segments = segmentCount(header.symbolCount, encrypted);
  for (let t = 0; t < segments; t++) {
    const size = Math.min(SEGMENT_SIZE, body.length - target);
    const segment = raw.slice(source, source + size + RS_PARITY);
    try {
      rsCorrect(segment);
    } catch (e) {
      if (e instanceof OrpUncorrectable) throw new OrpCorruptedFrame(header.block, header.seed);
      throw e;
    }
    body.set(segment.subarray(0, size), target);
    source += size + RS_PARITY;
    target += size;
  }
  const view = new DataView(body.buffer);
  const readCrc = view.getUint32(body.length - CRC_SIZE);
  if (readCrc !== crc32(body.subarray(0, body.length - CRC_SIZE))) {
    throw new OrpCorruptedFrame(header.block, header.seed);
  }
  header.token = view.getUint32(0);
  header.block = view.getUint32(4);
  header.k = view.getUint16(8);
  if (header.k < 1 || header.k > K_MAX) throw new OrpInvalidFrame(`K out of range: ${header.k}`);
  header.seed = view.getUint32(10);
  const payloadEnd = BODY_HEADER_SIZE + header.symbolCount * SYMBOL_SIZE;
  const payload = body.slice(BODY_HEADER_SIZE, payloadEnd);
  if (encrypted) {
    return { header, payload, tag: body.slice(payloadEnd, payloadEnd + TAG_SIZE) };
  }
  return { header, payload };
}

/**
 * AEAD AAD: majority meta (8 B) + body header (14 B).
 * The sender rebuilds it on its side, the receiver reads it back from the
 * corrected frame — any tampering with either one breaks the AEAD.
 */
export function frameAad(meta: Uint8Array, bodyHeader: Uint8Array): Uint8Array {
  const aad = new Uint8Array(META_SIZE + BODY_HEADER_SIZE);
  aad.set(meta, 0);
  aad.set(bodyHeader, META_SIZE);
  return aad;
}

/** Majority meta (8 B) of a raw frame — to build the AAD on the receiving side. */
export function majorityMeta(raw: Uint8Array): Uint8Array {
  const min = META_COPIES * META_SIZE;
  if (raw.length < min) throw new OrpInvalidFrame("frame truncated before the meta");
  const meta = new Uint8Array(META_SIZE);
  for (let i = 0; i < META_SIZE; i++) {
    const a = raw[i]!;
    const b = raw[i + META_SIZE]!;
    const c = raw[i + 2 * META_SIZE]!;
    meta[i] = a === b || a === c ? a : b === c ? b : (() => { throw new OrpInvalidFrame("undecidable meta"); })();
  }
  return meta;
}

/** Plaintext body header (14 B) of a corrected frame — for the AAD. */
export function bodyHeaderOf(body: Uint8Array): Uint8Array {
  return body.slice(0, BODY_HEADER_SIZE);
}

/** Wire version carried by this implementation. */
export const FRAME_VERSION = PROTOCOL_VERSION;
