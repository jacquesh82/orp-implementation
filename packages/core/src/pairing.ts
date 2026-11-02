/**
 * Authenticated pairing (F-07, §6) — two paths to the same key set:
 *
 *   1. by response code (strong path): the sender displays the init code
 *      (ephemeral public key included), the receiver answers with a
 *      response code that the sender's camera scans;
 *      secret = ECDH of the two ephemeral key pairs;
 *   2. by pairing passphrase (degraded path, no camera on the sender side):
 *      both users type the same passphrase; secret = HKDF of the passphrase,
 *      salt = session_id.
 *
 * In both cases, a 6-digit SAS derived from the secret is displayed on both
 * devices: the users compare it (§3-4). Encryption without authentication
 * does not protect against an active man-in-the-middle — no data transfer
 * before the SAS is confirmed.
 */

import { OrpInvalidPairingCode } from "./errors.ts";
import type { CryptoProvider } from "./encryption.ts";

export const SESSION_ID_SIZE = 16;
export const ECDH_PUBLIC_KEY_SIZE = 65;

/** Init code: session_id ‖ sender pub ‖ size ‖ digest ‖ nbBlocs ‖ kTotal ‖ flags ‖ reserved. */
export const INIT_CODE_SIZE = 16 + 65 + 8 + 32 + 2 + 2 + 1 + 1;
/** Response code: session_id ‖ receiver pub ‖ SAS seed. */
export const RESPONSE_CODE_SIZE = 16 + 65 + 4;

export interface InitCodeInfo {
  sessionId: Uint8Array;
  senderPublicKey: Uint8Array;
  streamSize: number;
  /** SHA-256 of the transferred stream (compressed if applicable, before encryption). */
  streamDigest: Uint8Array;
  blockCount: number;
  kTotal: number;
  compressed: boolean;
  /**
   * Pairing by shared PASSPHRASE (§7.2): the sender waits for no response
   * code, the receiver must ask the user for the passphrase. Absent or
   * false: strong path through the response code (§7.1). Session flags, bit 1.
   */
  byPassphrase?: boolean;
}

export interface SessionKeys {
  dataKey: Uint8Array;
  nonceKey: Uint8Array;
  /** 6-digit SAS — the only artifact meant for the users' eyes. */
  sas: string;
  sasSeed: number;
}

export function tokenOf(sessionId: Uint8Array): number {
  return ((sessionId[0]! << 24) | (sessionId[1]! << 16) | (sessionId[2]! << 8) | sessionId[3]!) >>> 0;
}

export function writeInitCode(i: InitCodeInfo): Uint8Array {
  if (i.sessionId.length !== SESSION_ID_SIZE) throw new OrpInvalidPairingCode("session_id of unexpected size");
  if (i.senderPublicKey.length !== ECDH_PUBLIC_KEY_SIZE) throw new OrpInvalidPairingCode("public key of unexpected size");
  if (i.streamDigest.length !== 32) throw new OrpInvalidPairingCode("digest of unexpected size");
  const o = new Uint8Array(INIT_CODE_SIZE);
  const view = new DataView(o.buffer);
  o.set(i.sessionId, 0);
  o.set(i.senderPublicKey, 16);
  view.setBigUint64(81, BigInt(Math.max(0, Math.floor(i.streamSize))));
  o.set(i.streamDigest, 89);
  view.setUint16(121, i.blockCount);
  view.setUint16(123, i.kTotal);
  o[125] = (i.compressed ? 0x01 : 0x00) | (i.byPassphrase ? 0x02 : 0x00);
  o[126] = 0x00; // reserved
  return o;
}

export function readInitCode(o: Uint8Array): InitCodeInfo {
  if (o.length !== INIT_CODE_SIZE) {
    throw new OrpInvalidPairingCode(`init code of ${o.length} bytes, ${INIT_CODE_SIZE} expected`);
  }
  const view = new DataView(o.buffer, o.byteOffset, o.byteLength);
  return {
    sessionId: o.slice(0, 16),
    senderPublicKey: o.slice(16, 81),
    streamSize: Number(view.getBigUint64(81)),
    streamDigest: o.slice(89, 121),
    blockCount: view.getUint16(121),
    kTotal: view.getUint16(123),
    compressed: ((o[125] ?? 0) & 0x01) !== 0,
    byPassphrase: ((o[125] ?? 0) & 0x02) !== 0,
  };
}

export function writeResponseCode(sessionId: Uint8Array, receiverPublicKey: Uint8Array, sasSeed: number): Uint8Array {
  if (sessionId.length !== SESSION_ID_SIZE || receiverPublicKey.length !== ECDH_PUBLIC_KEY_SIZE) {
    throw new OrpInvalidPairingCode("fields of unexpected size for the response code");
  }
  const o = new Uint8Array(RESPONSE_CODE_SIZE);
  o.set(sessionId, 0);
  o.set(receiverPublicKey, 16);
  new DataView(o.buffer).setUint32(81, sasSeed >>> 0);
  return o;
}

export function readResponseCode(o: Uint8Array): { sessionId: Uint8Array; receiverPublicKey: Uint8Array; sasSeed: number } {
  if (o.length !== RESPONSE_CODE_SIZE) {
    throw new OrpInvalidPairingCode(`response code of ${o.length} bytes, ${RESPONSE_CODE_SIZE} expected`);
  }
  return {
    sessionId: o.slice(0, 16),
    receiverPublicKey: o.slice(16, 81),
    sasSeed: new DataView(o.buffer, o.byteOffset, o.byteLength).getUint32(81),
  };
}

const SAS_INFO = "ORP v0.1 SAS";

/** Derives the session key set from a shared secret. */
export async function deriveKeys(
  crypto: CryptoProvider,
  secret: Uint8Array,
  sessionId: Uint8Array,
  sasSeed: number,
): Promise<SessionKeys> {
  const dataKey = await crypto.deriveHkdf(secret, sessionId, "ORP v0.1 donnees", 32);
  const nonceKey = await crypto.deriveHkdf(secret, sessionId, "ORP v0.1 nonce", 32);
  const salt = new Uint8Array(SESSION_ID_SIZE + 4);
  salt.set(sessionId, 0);
  new DataView(salt.buffer).setUint32(SESSION_ID_SIZE, sasSeed >>> 0);
  const sasBytes = await crypto.deriveHkdf(secret, salt, SAS_INFO, 4);
  const value =
    ((sasBytes[0]! << 24) | (sasBytes[1]! << 16) | (sasBytes[2]! << 8) | sasBytes[3]!) >>> 0;
  return { dataKey, nonceKey, sas: String(value % 1_000_000).padStart(6, "0"), sasSeed };
}

/** Degraded path: secret derived from a passphrase typed by both users. */
export async function deriveSecretFromPassphrase(
  crypto: CryptoProvider,
  passphrase: string,
  sessionId: Uint8Array,
): Promise<Uint8Array> {
  if (passphrase.length < 8) throw new OrpInvalidPairingCode("pairing passphrase too short (at least 8 characters)");
  return crypto.deriveHkdf(new TextEncoder().encode(passphrase), sessionId, "ORP v0.1 phrase", 32);
}

/**
 * Passphrase mode: the full key set, SAS seed included — it is DERIVED from
 * the secret, hence identical on both sides without any extra coordination
 * (the sender has no camera to read a response code).
 */
export async function deriveKeysFromPassphrase(
  crypto: CryptoProvider,
  passphrase: string,
  sessionId: Uint8Array,
): Promise<SessionKeys> {
  const secret = await deriveSecretFromPassphrase(crypto, passphrase, sessionId);
  const seedBytes = await crypto.deriveHkdf(secret, sessionId, "ORP v0.1 graine SAS", 4);
  const sasSeed =
    ((seedBytes[0]! << 24) | (seedBytes[1]! << 16) | (seedBytes[2]! << 8) | seedBytes[3]!) >>> 0;
  return deriveKeys(crypto, secret, sessionId, sasSeed);
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
