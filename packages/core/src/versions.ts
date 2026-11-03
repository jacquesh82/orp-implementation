/**
 * ORP protocol versioning on the wire — independent from the semantic
 * versioning of the packages (rule 7.1-6 of the requirements).
 *
 * Frozen compatibility rule (v0.1): a receiver accepts a sender of the same
 * MAJOR version whose MINOR version is lower than or equal to its own — it
 * can decode everything an older sender of the same major can emit. Any
 * other combination is rejected explicitly (F-21): never an approximate
 * decode.
 */

import { OrpIncompatibleVersion } from "./errors.ts";

export interface ProtocolVersion {
  major: number;
  minor: number;
}

/** Wire version described by docs/orp-protocol-v0.2.md (v0.2: commit/reveal pairing, transcript-bound keys, PBKDF2 passphrase). */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 0, minor: 2 };

export function compareVersions(a: ProtocolVersion, b: ProtocolVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

export function isVersionCompatible(sender: ProtocolVersion, receiver: ProtocolVersion): boolean {
  return sender.major === receiver.major && sender.minor <= receiver.minor;
}

/** Explicitly rejects an incompatible version (F-21). */
export function requireCompatibleVersion(sender: ProtocolVersion, receiver: ProtocolVersion): void {
  if (!isVersionCompatible(sender, receiver)) {
    throw new OrpIncompatibleVersion(sender, receiver);
  }
}

export function versionToBytes(v: ProtocolVersion): Uint8Array {
  const o = new Uint8Array(2);
  o[0] = v.major;
  o[1] = v.minor;
  return o;
}

export function versionFromBytes(o: Uint8Array): ProtocolVersion {
  return { major: o[0] ?? 0, minor: o[1] ?? 0 };
}
