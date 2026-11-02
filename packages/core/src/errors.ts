/**
 * Typed ORP errors — every failure has a name, never an ambiguous string.
 * Messages never carry a secret (§6 of the requirements): public
 * identifiers only (token, blocks, seeds, versions).
 *
 * The machine codes (`code`) are frozen protocol values (registry of the
 * specification): they stay byte-identical, in French.
 */

export class OrpError extends Error {
  /** Stable machine code, meant for machines, not humans. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Incompatible protocol version — explicit rejection, never an approximate decode. */
export class OrpIncompatibleVersion extends OrpError {
  constructor(
    readonly received: { major: number; minor: number },
    readonly supported: { major: number; minor: number },
  ) {
    super(
      "version-incompatible",
      `ORP frame ${received.major}.${received.minor} incompatible with ${supported.major}.${supported.minor}`,
    );
  }
}

/** Unknown session token: the frame does not belong to this session. */
export class OrpUnknownSession extends OrpError {
  constructor(token: number) {
    super("session-inconnue", `session token 0x${token.toString(16).padStart(8, "0")} unknown`);
  }
}

/** Malformed frame: magic, length, codec, flags or fields out of range. */
export class OrpInvalidFrame extends OrpError {
  constructor(message: string) {
    super("trame-invalide", message);
  }
}

/** Wrong CRC-32 after Reed-Solomon correction. */
export class OrpCorruptedFrame extends OrpError {
  constructor(block: number, seed: number) {
    super("trame-corrompue", `invalid CRC — block ${block}, seed ${seed}`);
  }
}

/** AEAD authentication failed: forged frame or different key. */
export class OrpForgedFrame extends OrpError {
  constructor(block: number, seed: number) {
    super("trame-falsifiee", `authentication failed — block ${block}, seed ${seed}`);
  }
}

/** Replay: a frame already received (same block, same seed) is ignored. */
export class OrpReplay extends OrpError {
  constructor(block: number, seed: number) {
    super("rejeu", `frame already received — block ${block}, seed ${seed}`);
  }
}

/** Reed-Solomon correction impossible: too many errors within the frame. */
export class OrpUncorrectable extends OrpError {
  constructor() {
    super("correction-impossible", "Reed-Solomon: more than 4 erroneous bytes in the frame");
  }
}

/** Global file integrity check (SHA-256 or size) failed. */
export class OrpIntegrityError extends OrpError {
  constructor(detail: string) {
    super("integrite", `file integrity check failed: ${detail}`);
  }
}

/** Forbidden transition of the session state machine. */
export class OrpInvalidState extends OrpError {
  constructor(action: string, state: string) {
    super("etat-invalide", `action "${action}" forbidden in state "${state}"`);
  }
}

/** Pairing missing or incomplete when it is required. */
export class OrpPairingRequired extends OrpError {
  constructor(detail: string) {
    super("appairage-requis", detail);
  }
}

/** Malformed init or response code. */
export class OrpInvalidPairingCode extends OrpError {
  constructor(detail: string) {
    super("code-appairage-invalide", detail);
  }
}

/** The requested compression is not available on this platform. */
export class OrpCompressionUnavailable extends OrpError {
  constructor() {
    super("compression-indisponible", "CompressionStream unavailable on this platform");
  }
}
