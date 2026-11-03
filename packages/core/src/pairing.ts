/**
 * Authenticated pairing (F-07, §6-7) — ORP v0.2. Two paths to the same key set:
 *
 *   1. by codes (strong path), three optical messages:
 *        init     sender → receiver  commitment H(session_id ‖ sender pub)
 *        response receiver → sender  receiver pub
 *        reveal   sender → receiver  sender pub (checked against the commitment)
 *      secret = ECDH of the two ephemeral key pairs.
 *      The commitment is what makes the SAS meaningful: the sender's key is
 *      fixed BEFORE it sees the receiver's, and the receiver's key is fixed
 *      before it sees the sender's. A man-in-the-middle can no longer grind
 *      its own key until the two 6-digit SAS collide (v0.1 weakness: the last
 *      to play chose its key and a 32-bit SAS seed freely).
 *   2. by pairing passphrase (degraded path, no camera on the sender side):
 *      both users type the same passphrase; secret = PBKDF2-HMAC-SHA-256 of
 *      the passphrase (600 000 iterations), salt = label ‖ session_id. The
 *      stretching is what keeps an observer who filmed the session from
 *      testing passphrases offline at full speed.
 *
 * In both cases the keys AND the SAS are derived with the TRANSCRIPT hash as
 * HKDF salt: every byte of the codes exchanged (flags, sizes, digest…) is
 * bound to the keys. A code altered in flight gives diverging SAS — the users
 * see it — and frames that do not authenticate.
 *
 * A 6-digit SAS is displayed on both devices: the users compare it (§3-4).
 * No data transfer before the SAS is confirmed.
 */

import { OrpIncompatibleVersion, OrpInvalidPairingCode } from "./errors.ts";
import type { CryptoProvider } from "./encryption.ts";
import { K_MAX, SYMBOL_SIZE } from "./frames.ts";
import { PROTOCOL_VERSION } from "./versions.ts";

export const SESSION_ID_SIZE = 16;
export const ECDH_PUBLIC_KEY_SIZE = 65;
export const COMMITMENT_SIZE = 32;

/** First byte of every pairing code: its kind. */
export const CODE_KIND = {
  INIT: 0x49, // "I"
  RESPONSE: 0x52, // "R"
  REVEAL: 0x56, // "V"
} as const;

/** Second byte of every pairing code: protocol version, major << 4 | minor. */
export const CODE_VERSION = ((PROTOCOL_VERSION.major & 0x0f) << 4) | (PROTOCOL_VERSION.minor & 0x0f);

const CODE_HEADER_SIZE = 2;

/**
 * Init code: kind ‖ version ‖ session_id ‖ commitment ‖ size (u64) ‖ digest ‖
 * nbBlocs (u16) ‖ kTotal (u32) ‖ flags.
 */
export const INIT_CODE_SIZE = CODE_HEADER_SIZE + SESSION_ID_SIZE + COMMITMENT_SIZE + 8 + 32 + 2 + 4 + 1;
/** Response code: kind ‖ version ‖ session_id ‖ receiver pub. */
export const RESPONSE_CODE_SIZE = CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUBLIC_KEY_SIZE;
/** Reveal code: kind ‖ version ‖ session_id ‖ sender pub. */
export const REVEAL_CODE_SIZE = CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUBLIC_KEY_SIZE;

/** Init code flags. Any other bit set: invalid code. */
export const INIT_FLAG = {
  COMPRESSED: 0x01,
  BY_PASSPHRASE: 0x02,
  ENCRYPTED: 0x04,
} as const;
const INIT_FLAGS_KNOWN = INIT_FLAG.COMPRESSED | INIT_FLAG.BY_PASSPHRASE | INIT_FLAG.ENCRYPTED;

/** PBKDF2 iterations of the passphrase path — a constant of the version. */
export const PASSPHRASE_ITERATIONS = 600_000;
export const PASSPHRASE_MIN_LENGTH = 8;

const LABEL_COMMITMENT = "ORP v0.2 engagement";
const LABEL_TRANSCRIPT = "ORP v0.2 transcription";
const LABEL_PASSPHRASE = "ORP v0.2 phrase";
const INFO_DATA = "ORP v0.2 donnees";
const INFO_NONCE = "ORP v0.2 nonce";
const INFO_SAS = "ORP v0.2 SAS";

export interface InitCodeInfo {
  sessionId: Uint8Array;
  /** SHA-256(label ‖ session_id ‖ sender pub): the sender pub itself comes in the reveal code. */
  commitment: Uint8Array;
  streamSize: number;
  /** SHA-256 of the transferred stream (compressed if applicable, before encryption). */
  streamDigest: Uint8Array;
  blockCount: number;
  kTotal: number;
  compressed: boolean;
  /**
   * Pairing by shared PASSPHRASE (§7.2): the sender waits for no response
   * code, the receiver must ask the user for the passphrase. False: strong
   * path through the response and reveal codes (§7.1).
   */
  byPassphrase: boolean;
  /** The data frames are encrypted: the receiver rejects any frame that is not. */
  encrypted: boolean;
}

export interface SessionKeys {
  dataKey: Uint8Array;
  nonceKey: Uint8Array;
  /** 6-digit SAS — the only artifact meant for the users' eyes. */
  sas: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function tokenOf(sessionId: Uint8Array): number {
  return ((sessionId[0]! << 24) | (sessionId[1]! << 16) | (sessionId[2]! << 8) | sessionId[3]!) >>> 0;
}

/** Block layout implied by a stream size — the receiver checks the init code and every frame against it. */
export function expectedLayout(streamSize: number): { blockCount: number; kTotal: number } {
  const kTotal = Math.ceil(streamSize / SYMBOL_SIZE);
  return { blockCount: Math.ceil(kTotal / K_MAX), kTotal };
}

/** K of block `block` for a stream of `streamSize` bytes (0 if the block does not exist). */
export function expectedK(streamSize: number, block: number): number {
  const { blockCount, kTotal } = expectedLayout(streamSize);
  if (!Number.isInteger(block) || block < 0 || block >= blockCount) return 0;
  return Math.min(K_MAX, kTotal - block * K_MAX);
}

function readHeader(o: Uint8Array, kind: number, size: number, name: string): void {
  if (o.length !== size) throw new OrpInvalidPairingCode(`${name} code of ${o.length} bytes, ${size} expected`);
  if (o[0] !== kind) throw new OrpInvalidPairingCode(`not a ${name} code (kind 0x${(o[0] ?? 0).toString(16)})`);
  if (o[1] !== CODE_VERSION) {
    throw new OrpIncompatibleVersion({ major: (o[1] ?? 0) >> 4, minor: (o[1] ?? 0) & 0x0f }, PROTOCOL_VERSION);
  }
}

/** SHA-256(label ‖ session_id ‖ sender pub). */
export async function commitmentOf(crypto: CryptoProvider, sessionId: Uint8Array, senderPublicKey: Uint8Array): Promise<Uint8Array> {
  return crypto.sha256(concat(utf8(LABEL_COMMITMENT), sessionId, senderPublicKey));
}

export function writeInitCode(i: InitCodeInfo): Uint8Array {
  if (i.sessionId.length !== SESSION_ID_SIZE) throw new OrpInvalidPairingCode("session_id of unexpected size");
  if (i.commitment.length !== COMMITMENT_SIZE) throw new OrpInvalidPairingCode("commitment of unexpected size");
  if (i.streamDigest.length !== 32) throw new OrpInvalidPairingCode("digest of unexpected size");
  if (!Number.isSafeInteger(i.streamSize) || i.streamSize < 0) throw new OrpInvalidPairingCode("stream size out of range");
  const layout = expectedLayout(i.streamSize);
  if (i.blockCount !== layout.blockCount || i.kTotal !== layout.kTotal || layout.blockCount > 0xffff) {
    throw new OrpInvalidPairingCode("block layout inconsistent with the stream size");
  }
  const o = new Uint8Array(INIT_CODE_SIZE);
  const view = new DataView(o.buffer);
  o[0] = CODE_KIND.INIT;
  o[1] = CODE_VERSION;
  o.set(i.sessionId, 2);
  o.set(i.commitment, 18);
  view.setBigUint64(50, BigInt(i.streamSize));
  o.set(i.streamDigest, 58);
  view.setUint16(90, i.blockCount);
  view.setUint32(92, i.kTotal);
  o[96] =
    (i.compressed ? INIT_FLAG.COMPRESSED : 0) |
    (i.byPassphrase ? INIT_FLAG.BY_PASSPHRASE : 0) |
    (i.encrypted ? INIT_FLAG.ENCRYPTED : 0);
  return o;
}

export function readInitCode(o: Uint8Array): InitCodeInfo {
  readHeader(o, CODE_KIND.INIT, INIT_CODE_SIZE, "init");
  const view = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const size = view.getBigUint64(50);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new OrpInvalidPairingCode("stream size out of range");
  const streamSize = Number(size);
  const blockCount = view.getUint16(90);
  const kTotal = view.getUint32(92);
  const layout = expectedLayout(streamSize);
  if (blockCount !== layout.blockCount || kTotal !== layout.kTotal) {
    throw new OrpInvalidPairingCode("block layout inconsistent with the stream size");
  }
  const flags = o[96]!;
  if ((flags & ~INIT_FLAGS_KNOWN) !== 0) throw new OrpInvalidPairingCode(`unknown init flags 0x${flags.toString(16)}`);
  return {
    sessionId: o.slice(2, 18),
    commitment: o.slice(18, 50),
    streamSize,
    streamDigest: o.slice(58, 90),
    blockCount,
    kTotal,
    compressed: (flags & INIT_FLAG.COMPRESSED) !== 0,
    byPassphrase: (flags & INIT_FLAG.BY_PASSPHRASE) !== 0,
    encrypted: (flags & INIT_FLAG.ENCRYPTED) !== 0,
  };
}

function writeKeyCode(kind: number, sessionId: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (sessionId.length !== SESSION_ID_SIZE || publicKey.length !== ECDH_PUBLIC_KEY_SIZE) {
    throw new OrpInvalidPairingCode("fields of unexpected size for a pairing code");
  }
  const o = new Uint8Array(CODE_HEADER_SIZE + SESSION_ID_SIZE + ECDH_PUBLIC_KEY_SIZE);
  o[0] = kind;
  o[1] = CODE_VERSION;
  o.set(sessionId, 2);
  o.set(publicKey, 18);
  return o;
}

export function writeResponseCode(sessionId: Uint8Array, receiverPublicKey: Uint8Array): Uint8Array {
  return writeKeyCode(CODE_KIND.RESPONSE, sessionId, receiverPublicKey);
}

export function readResponseCode(o: Uint8Array): { sessionId: Uint8Array; receiverPublicKey: Uint8Array } {
  readHeader(o, CODE_KIND.RESPONSE, RESPONSE_CODE_SIZE, "response");
  return { sessionId: o.slice(2, 18), receiverPublicKey: o.slice(18, 83) };
}

export function writeRevealCode(sessionId: Uint8Array, senderPublicKey: Uint8Array): Uint8Array {
  return writeKeyCode(CODE_KIND.REVEAL, sessionId, senderPublicKey);
}

export function readRevealCode(o: Uint8Array): { sessionId: Uint8Array; senderPublicKey: Uint8Array } {
  readHeader(o, CODE_KIND.REVEAL, REVEAL_CODE_SIZE, "reveal");
  return { sessionId: o.slice(2, 18), senderPublicKey: o.slice(18, 83) };
}

/** Kind of a pairing code (first byte), or null if unknown — lets a reader skip codes it does not expect. */
export function pairingCodeKind(o: Uint8Array): "init" | "response" | "reveal" | null {
  switch (o[0]) {
    case CODE_KIND.INIT:
      return "init";
    case CODE_KIND.RESPONSE:
      return "response";
    case CODE_KIND.REVEAL:
      return "reveal";
    default:
      return null;
  }
}

/**
 * Transcript hash: SHA-256(label ‖ init ‖ response ‖ reveal) on the codes
 * path, SHA-256(label ‖ init) on the passphrase path.
 */
export async function transcriptHash(crypto: CryptoProvider, init: Uint8Array, response?: Uint8Array, reveal?: Uint8Array): Promise<Uint8Array> {
  return crypto.sha256(concat(utf8(LABEL_TRANSCRIPT), init, response ?? new Uint8Array(0), reveal ?? new Uint8Array(0)));
}

/** Derives the session key set from a shared secret and the transcript hash. */
export async function deriveKeys(crypto: CryptoProvider, secret: Uint8Array, transcript: Uint8Array): Promise<SessionKeys> {
  const dataKey = await crypto.deriveHkdf(secret, transcript, INFO_DATA, 32);
  const nonceKey = await crypto.deriveHkdf(secret, transcript, INFO_NONCE, 32);
  const sasBytes = await crypto.deriveHkdf(secret, transcript, INFO_SAS, 4);
  const value = ((sasBytes[0]! << 24) | (sasBytes[1]! << 16) | (sasBytes[2]! << 8) | sasBytes[3]!) >>> 0;
  return { dataKey, nonceKey, sas: String(value % 1_000_000).padStart(6, "0") };
}

/** Degraded path: secret stretched from a passphrase typed by both users. */
export async function deriveSecretFromPassphrase(
  crypto: CryptoProvider,
  passphrase: string,
  sessionId: Uint8Array,
): Promise<Uint8Array> {
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
    throw new OrpInvalidPairingCode(`pairing passphrase too short (at least ${PASSPHRASE_MIN_LENGTH} characters)`);
  }
  return crypto.derivePbkdf2(utf8(passphrase), concat(utf8(LABEL_PASSPHRASE), sessionId), PASSPHRASE_ITERATIONS, 32);
}

/** Passphrase path: the full key set, bound to the init code. */
export async function deriveKeysFromPassphrase(
  crypto: CryptoProvider,
  passphrase: string,
  initCode: Uint8Array,
): Promise<SessionKeys> {
  const { sessionId } = readInitCode(initCode);
  const secret = await deriveSecretFromPassphrase(crypto, passphrase, sessionId);
  try {
    return await deriveKeys(crypto, secret, await transcriptHash(crypto, initCode));
  } finally {
    secret.fill(0);
  }
}

/**
 * AEAD nonce of a frame: HMAC-SHA-256(nonceKey, block ‖ seed) truncated to
 * 12 bytes — deterministic, unique per frame (a seed never comes back twice
 * in a block), and free on the wire.
 */
export async function frameNonce(
  crypto: CryptoProvider,
  nonceKey: Uint8Array,
  block: number,
  seed: number,
): Promise<Uint8Array> {
  const input = new Uint8Array(8);
  new DataView(input.buffer).setUint32(0, block >>> 0);
  new DataView(input.buffer).setUint32(4, seed >>> 0);
  const mac = await crypto.hmacSha256(nonceKey, input);
  return mac.slice(0, 12);
}

/** Best-effort wipe of a key set (§6: known limits of JS memory). */
export function wipeKeys(keys: SessionKeys | undefined): void {
  if (!keys) return;
  keys.dataKey.fill(0);
  keys.nonceKey.fill(0);
}
