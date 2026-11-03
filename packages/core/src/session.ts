/**
 * Session lifecycle (§8.1): prepare → pair → calibrate → start →
 * pause/resume (within the active session) → cancel/dispose, typed errors.
 *
 * Sending and receiving are two symmetric classes. They know NOTHING about
 * optics: they produce and consume ORP frames. The optical layer (package
 * `optical`) adds the RS parity and encodes the frames as matrices; the
 * browser adapter displays and captures them.
 *
 * In V1, without a back channel (§5.5), the sender does not know when the
 * receiver is done: it sends in a loop (fountain code: every new pass brings
 * new combinations) until `finish()` — manually, or after a fixed number of
 * passes. The synthetic acceptance test drives `finish()` once reception is
 * complete.
 *
 * The state names, rejection reasons and end reasons are frozen protocol
 * values (specification registry): they stay byte-identical, in French.
 */

import {
  SYMBOL_CAPACITY,
  CODEC,
  Codec,
  FLAG,
  FrameHeader,
  buildFrame,
  readFrame,
  frameAad,
  writeBodyHeader,
  writeMeta,
  majorityMeta,
  SYMBOL_SIZE,
  FRAME_VERSION,
} from "./frames.ts";
import { planBlocks, blockCount, kTotal, blockSymbols, assemble, BlockPlan } from "./blocks.ts";
import { FountainDecoder, fountainSymbol } from "./fountain.ts";
import {
  SessionKeys,
  deriveKeys,
  deriveKeysFromPassphrase,
  wipeKeys,
  writeInitCode,
  writeResponseCode,
  writeRevealCode,
  InitCodeInfo,
  tokenOf,
  readInitCode,
  readResponseCode,
  readRevealCode,
  frameNonce,
  commitmentOf,
  transcriptHash,
  expectedK,
  SESSION_ID_SIZE,
} from "./pairing.ts";
import { CryptoProvider } from "./encryption.ts";
import { compress, decompress } from "./compression.ts";
import { PROTOCOL_VERSION, requireCompatibleVersion } from "./versions.ts";
import {
  OrpPairingRequired,
  OrpError,
  OrpInvalidState,
  OrpIntegrityError,
  OrpUnknownSession,
  OrpCorruptedFrame,
  OrpInvalidPairingCode,
} from "./errors.ts";
import { Logger, silentLogger } from "./logger.ts";

/** Lifecycle of §8.1 — "initial" only exists on the receiving side, before the init code. */
export type SessionState =
  | "initial"
  | "prepare"
  | "appairage"
  | "sas"
  | "calibre"
  | "transmission"
  | "pause"
  | "termine"
  | "annule";

export interface TransmissionOptions {
  /**
   * Defaults to "required": without authenticated pairing, no transfer (§6).
   * "optional" behaves like "required" on the sender side (kept for API
   * compatibility); "none" sends clear frames — the receiver must accept them
   * explicitly (ReceptionOptions.encryption).
   */
  encryption?: "required" | "optional" | "none";
  /** Offered codecs, in order of preference. Default: 8 → 4 → 2 colors. */
  codecs?: Codec[];
  /** Try deflate-raw before segmentation (default: true, gain checked). */
  compression?: boolean;
  /**
   * Pairing path announced in the init code (§7): "codes" (default, response
   * code scanned by the sender) or "passphrase" (shared passphrase typed on both
   * sides, the sender needs no camera).
   */
  pairing?: "codes" | "passphrase";
  logger?: Logger;
}

/** Typed events — no content and no secret in the payloads. */
export class Events<T extends Record<string, unknown>> {
  private listeners = new Map<keyof T, Set<(c: unknown) => void>>();

  on<K extends keyof T>(type: K, fn: (payload: T[K]) => void): () => void {
    const handlers = this.listeners.get(type) ?? new Set<(c: unknown) => void>();
    handlers.add(fn as (c: unknown) => void);
    this.listeners.set(type, handlers);
    return () => handlers.delete(fn as (c: unknown) => void);
  }

  emit<K extends keyof T>(type: K, payload: T[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (c: T[K]) => void)(payload);
  }
}

export interface ReceiveProgress {
  completedBlocks: number;
  blockCount: number;
  receivedSymbols: number;
  receivedFrames: number;
  replays: number;
  forged: number;
  corrupted: number;
}

export interface ReceptionOptions {
  /**
   * "required" (default): an init code announcing clear frames is refused,
   * and every data frame must be encrypted. "optional": a sender in
   * encryption "none" is accepted — its frames are then authenticated by
   * nothing but the final SHA-256 of the init code.
   */
  encryption?: "required" | "optional";
  /** Upper bound of the decompressed file (default 256 MiB): a deflate bomb stops there. */
  maxFileSize?: number;
  logger?: Logger;
}

/** Default upper bound of a decompressed file. */
export const DEFAULT_MAX_FILE_SIZE = 256 * 1024 * 1024;

type SenderEvents = {
  frame: { block: number; seed: number; codec: Codec; symbolCount: number };
  progress: { sentFrames: number };
  codec: { codec: Codec };
  end: { reason: "passes" | "terminer" | "annule" };
};

type ReceiverEvents = {
  progress: ReceiveProgress;
  block: { block: number };
  complete: { streamSize: number };
  rejection: { reason: string; block?: number; seed?: number };
};

function assertState(action: string, state: SessionState, allowed: SessionState[]): void {
  if (!allowed.includes(state)) throw new OrpInvalidState(action, state);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, m) => a + m.length, 0);
  const t = new Uint8Array(total);
  let pos = 0;
  for (const m of chunks) {
    t.set(m, pos);
    pos += m.length;
  }
  return t;
}

// ── Sending ───────────────────────────────────────────────────────────────

export class SenderSession {
  readonly events = new Events<SenderEvents>();
  private _state: SessionState = "prepare";
  private readonly crypto: CryptoProvider;
  private readonly logger: Logger;
  private readonly encryptionMode: "required" | "optional" | "none";
  private readonly offeredCodecs: Codec[];
  private readonly wantsCompression: boolean;
  private readonly byPassphrase: boolean;

  private sessionId = new Uint8Array(SESSION_ID_SIZE);
  private ephemeralPrivateKey: CryptoKey | undefined = undefined;
  private ephemeralPublicKey: Uint8Array | undefined = undefined;
  private commitment: Uint8Array | undefined = undefined;
  private initCodeBytes: Uint8Array | undefined = undefined;
  private revealCodeBytes: Uint8Array | undefined = undefined;
  private keys: SessionKeys | undefined = undefined;
  private plan: BlockPlan | undefined = undefined;
  private streamSize = 0;
  private streamDigest: Uint8Array | undefined = undefined;
  private compressed = false;
  private encryptionActive = false;
  private currentCodec: Codec = CODEC.COLOR_8;
  private seedCounter = 1;
  private frameCount = 0;
  private paused = false;
  private resumeWaiter: (() => void) | undefined = undefined;
  private stopRequested = false;
  private cancelRequested = false;

  constructor(crypto: CryptoProvider, options: TransmissionOptions = {}) {
    this.crypto = crypto;
    this.logger = options.logger ?? silentLogger;
    this.encryptionMode = options.encryption ?? "required";
    this.wantsCompression = options.compression ?? true;
    this.byPassphrase = options.pairing === "passphrase";
    this.offeredCodecs = options.codecs ?? [CODEC.COLOR_8, CODEC.COLOR_4, CODEC.MONO_2];
    if (this.offeredCodecs.length === 0) throw new OrpError("aucun-codec", "the codec list is empty");
    for (const c of this.offeredCodecs) {
      if (!(c in SYMBOL_CAPACITY)) throw new OrpError("aucun-codec", `unknown codec: 0x${String(c)}`);
    }
    this.currentCodec = this.offeredCodecs[0]!;
  }

  get state(): SessionState {
    return this._state;
  }

  get codec(): Codec {
    return this.currentCodec;
  }

  get token(): number {
    return tokenOf(this.sessionId);
  }

  /** Number of frames sent since the start of the transmission. */
  get sentFrames(): number {
    return this.frameCount;
  }

  /** prepare step: optional compression, block plan, ephemeral key pair. */
  async prepare(input: Uint8Array): Promise<void> {
    assertState("prepare", this._state, ["prepare"]);
    if (this.plan) throw new OrpInvalidState("prepare", this._state);
    this.sessionId = this.crypto.randomBytes(SESSION_ID_SIZE);
    const pair = await this.crypto.generateEcdhKeyPair();
    this.ephemeralPrivateKey = pair.privateKey;
    this.ephemeralPublicKey = pair.publicKey;
    this.commitment = await commitmentOf(this.crypto, this.sessionId, pair.publicKey);
    let stream = input;
    if (this.wantsCompression) {
      const compressed = await compress(input);
      if (compressed) {
        stream = compressed;
        this.compressed = true;
      }
    }
    this.streamSize = stream.length;
    this.streamDigest = await this.crypto.sha256(stream);
    this.plan = planBlocks(stream);
    this.encryptionActive = this.encryptionMode !== "none";
    this._state = "appairage";
    this.logger.info("session prepared", {
      size: this.streamSize,
      blocks: blockCount(this.plan),
      compressed: this.compressed,
      encryption: this.encryptionActive,
    });
  }

  private get requirePlan(): BlockPlan {
    if (!this.plan) throw new OrpPairingRequired("prepare() must run first");
    return this.plan;
  }

  private get requireKeys(): SessionKeys {
    if (!this.keys) throw new OrpPairingRequired("keys not derived — pairing incomplete");
    return this.keys;
  }

  /** Payload of the init code — the optical layer encodes it. Same bytes on every call (transcript). */
  initCode(): Uint8Array {
    if (this.initCodeBytes) return this.initCodeBytes;
    const plan = this.requirePlan;
    if (!this.commitment) throw new OrpPairingRequired("prepare() must run before the init code");
    this.initCodeBytes = writeInitCode({
      sessionId: this.sessionId,
      commitment: this.commitment,
      streamSize: this.streamSize,
      streamDigest: this.streamDigest!,
      blockCount: blockCount(plan),
      kTotal: kTotal(plan),
      compressed: this.compressed,
      byPassphrase: this.byPassphrase,
      encrypted: this.encryptionActive,
    });
    return this.initCodeBytes;
  }

  /**
   * Strong path, step 2: reads the response code (receiver pub), derives the
   * keys and the SAS. The reveal code (`revealCode()`) must then be shown to
   * the receiver: without it, it cannot compute its own SAS.
   */
  async receiveResponseCode(code: Uint8Array): Promise<void> {
    assertState("receiveResponseCode", this._state, ["appairage"]);
    if (this.byPassphrase) throw new OrpInvalidState("receiveResponseCode", "passphrase pairing");
    if (!this.ephemeralPrivateKey || !this.ephemeralPublicKey) throw new OrpPairingRequired("ephemeral key pair missing");
    const parsed = readResponseCode(code);
    if (!bytesEqual(parsed.sessionId, this.sessionId)) {
      throw new OrpInvalidPairingCode("response code from another session");
    }
    const init = this.initCode();
    const reveal = writeRevealCode(this.sessionId, this.ephemeralPublicKey);
    const secret = await this.crypto.deriveEcdhSecret(this.ephemeralPrivateKey, parsed.receiverPublicKey);
    try {
      this.keys = await deriveKeys(this.crypto, secret, await transcriptHash(this.crypto, init, code, reveal));
    } finally {
      secret.fill(0);
    }
    this.revealCodeBytes = reveal;
    this._state = "sas";
  }

  /**
   * Strong path, step 3: the reveal code (sender pub) to display for the
   * receiver once its response code has been read — it opens the commitment
   * of the init code.
   */
  revealCode(): Uint8Array {
    if (!this.revealCodeBytes) throw new OrpPairingRequired("response code not received yet");
    return this.revealCodeBytes;
  }

  /** Degraded path: shared passphrase typed on both sides, stretched by PBKDF2, bound to the init code. */
  async receivePassphrase(passphrase: string): Promise<void> {
    assertState("receivePassphrase", this._state, ["appairage"]);
    if (!this.byPassphrase) throw new OrpInvalidState("receivePassphrase", "pairing by codes");
    this.keys = await deriveKeysFromPassphrase(this.crypto, passphrase, this.initCode());
    this._state = "sas";
  }

  /** SAS to compare on both devices before any transfer (F-07). */
  sas(): string {
    assertState("sas", this._state, ["sas"]);
    return this.requireKeys.sas;
  }

  /** Human confirmation of the SAS — unlocks the transmission. */
  confirmSas(): void {
    assertState("confirmSas", this._state, ["sas"]);
    this._state = "calibre";
  }

  /**
   * calibrate step: in V1 it only affects the CHOICE of the initial codec —
   * color calibration belongs to the optical layer.
   */
  calibrate(recommendedCodec?: Codec): void {
    assertState("calibrate", this._state, ["calibre"]);
    if (recommendedCodec && this.offeredCodecs.includes(recommendedCodec)) {
      this.currentCodec = recommendedCodec;
      this.events.emit("codec", { codec: recommendedCodec });
    }
  }

  /** Fallback 8 → 4 → 2 (F-06): the next frames go out in the other mode. */
  setCodec(codec: Codec): void {
    assertState("setCodec", this._state, ["calibre", "transmission", "pause"]);
    if (!this.offeredCodecs.includes(codec)) {
      throw new OrpError("codec-refuse", `codec not offered: 0x${String(codec)}`);
    }
    this.currentCodec = codec;
    this.events.emit("codec", { codec });
  }

  /**
   * start step: sends in a loop through `emit` (round-robin over the blocks,
   * increasing seeds). `passes` bounds the number of passes over each block
   * — 0 (default) sends until `finish()` or `cancel()`.
   */
  async start(emit: (frame: Uint8Array) => void | Promise<void>, passes = 0): Promise<void> {
    assertState("start", this._state, ["calibre"]);
    const plan = this.requirePlan;
    this._state = "transmission";
    this.stopRequested = false;
    this.cancelRequested = false;
    let endReason: "passes" | "terminer" | "annule" = "passes";
    let pass = 0;
    // Blocks INTERLEAVED frame by frame (0, 1, 2, …, 0, 1, …): a video of a
    // few seconds covers every block equally. Sent one after the other
    // (≈ 35 s per block on the bench), a 5-block file left blocks never
    // filmed — "99 %" and no file. The receiver accepts any order: nothing
    // changes on the wire.
    const blockSources = Array.from({ length: blockCount(plan) }, (_, b) => blockSymbols(plan, b));
    while (!this.stopRequested && (passes === 0 || pass < passes)) {
      const js = plan.kPerBlock.map(() => 0);
      let remaining = true;
      while (remaining && !this.stopRequested) {
        remaining = false;
        for (let block = 0; block < blockCount(plan) && !this.stopRequested; block++) {
          const k = plan.kPerBlock[block]!;
          if (js[block]! >= k) continue;
          remaining = true;
          await this.waitForResume();
          if (this.stopRequested) break;
          // Capacity re-read at EVERY frame: a codec fallback (setCodec) during a
          // block must not produce a frame too large for the new mode.
          const count = Math.min(SYMBOL_CAPACITY[this.currentCodec] ?? 1, k - js[block]!);
          await this.sendFrame(emit, block, k, blockSources[block]!, count);
          js[block]! += count;
        }
      }
      pass++;
      if (passes > 0 && pass >= passes && !this.stopRequested) break;
    }
    if (this.stopRequested) {
      endReason = this.cancelRequested ? "annule" : "terminer";
      this._state = this.cancelRequested ? "annule" : "termine";
    } else {
      this._state = "termine";
    }
    this.events.emit("end", { reason: endReason });
    if (this._state === "annule") this.dispose();
  }

  private async sendFrame(
    emit: (frame: Uint8Array) => void | Promise<void>,
    block: number,
    k: number,
    sources: Uint8Array[],
    symbolCount: number,
  ): Promise<void> {
    // A frame carries the combinations `seed`, `seed+1`… `seed+n−1`: the
    // counter therefore advances by symbolCount, otherwise the next frame
    // would repeat n−1 combinations already sent — a single new symbol per
    // frame, useful throughput divided by symbolCount (seen on the bench:
    // 104 frames of 4 symbols for a 63-symbol file).
    const seed = this.seedCounter;
    this.seedCounter = (this.seedCounter + symbolCount) >>> 0;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < symbolCount; i++) {
      chunks.push(fountainSymbol(sources, k, seed + i));
    }
    const payload = concatBytes(chunks);
    const flags =
      (this.encryptionActive ? FLAG.ENCRYPTED : 0) | (this.compressed ? FLAG.COMPRESSED : 0);
    const header: FrameHeader = {
      version: FRAME_VERSION,
      codec: this.currentCodec,
      flags,
      token: tokenOf(this.sessionId),
      block,
      k,
      symbolCount,
      seed,
    };
    let frame: Uint8Array;
    if (this.encryptionActive) {
      const keys = this.requireKeys;
      const aad = frameAad(writeMeta(header), writeBodyHeader(header));
      const nonce = await frameNonce(this.crypto, keys.nonceKey, block, seed);
      const { ciphertext, tag } = await this.crypto.encryptAead(keys.dataKey, nonce, payload, aad);
      frame = buildFrame(header, ciphertext, tag);
    } else {
      frame = buildFrame(header, payload);
    }
    this.frameCount++;
    this.events.emit("frame", { block, seed, codec: this.currentCodec, symbolCount });
    this.events.emit("progress", { sentFrames: this.sentFrames });
    await emit(frame);
  }

  private async waitForResume(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((r) => {
      this.resumeWaiter = r;
    });
    this.resumeWaiter = undefined;
  }

  /** pause step — only within the active session (§8.1). */
  pause(): void {
    assertState("pause", this._state, ["transmission"]);
    this.paused = true;
    this._state = "pause";
  }

  resume(): void {
    assertState("resume", this._state, ["pause"]);
    this.paused = false;
    this._state = "transmission";
    this.resumeWaiter?.();
  }

  finish(): void {
    this.stopRequested = true;
    if (this.paused) this.resume();
  }

  cancel(): void {
    this.cancelRequested = true;
    this.stopRequested = true;
    if (this.paused) this.resume();
  }

  /** Best-effort wipe of the keys, symbols and plaintext in memory (§6). */
  dispose(): void {
    wipeKeys(this.keys);
    this.keys = undefined;
    if (this.plan) {
      for (const s of this.plan.symbols) s.fill(0);
      this.plan = undefined;
    }
    this.ephemeralPrivateKey = undefined;
    this.ephemeralPublicKey = undefined;
    this.streamDigest = undefined;
    this.revealCodeBytes = undefined;
  }
}

// ── Receiving ─────────────────────────────────────────────────────────────

export type FrameStatus =
  | { accepted: true }
  | { accepted: false; rejection: "corrompue" | "invalide" | "version" | "falsifiee" | "rejeu" };

export class ReceiverSession {
  readonly events = new Events<ReceiverEvents>();
  private _state: SessionState = "initial";
  private readonly crypto: CryptoProvider;
  private readonly logger: Logger;

  private readonly acceptClear: boolean;
  private readonly maxFileSize: number;

  private info: InitCodeInfo | undefined = undefined;
  private initCodeBytes: Uint8Array | undefined = undefined;
  private responseCodeBytes: Uint8Array | undefined = undefined;
  private keys: SessionKeys | undefined = undefined;
  private ephemeralPrivateKey: CryptoKey | undefined = undefined;
  private decoders = new Map<number, FountainDecoder>();
  private seen = new Set<string>();
  private completeAnnounced = false;
  private stats = { frames: 0, replays: 0, forged: 0, corrupted: 0 };

  constructor(crypto: CryptoProvider, options: ReceptionOptions = {}) {
    this.crypto = crypto;
    this.logger = options.logger ?? silentLogger;
    this.acceptClear = options.encryption === "optional";
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  get state(): SessionState {
    return this._state;
  }

  get token(): number | undefined {
    return this.info ? tokenOf(this.info.sessionId) : undefined;
  }

  /**
   * Reads the init code displayed by the sender. Refuses a sender announcing
   * clear frames unless the receiver accepts them (`encryption: "optional"`).
   */
  scanInitCode(code: Uint8Array): InitCodeInfo {
    assertState("scanInitCode", this._state, ["initial"]);
    const parsed = readInitCode(code);
    if (!parsed.encrypted && !this.acceptClear) {
      throw new OrpInvalidPairingCode("the sender announces clear frames, this receiver requires encryption");
    }
    this.info = parsed;
    this.initCodeBytes = code.slice();
    this._state = "appairage";
    return parsed;
  }

  /**
   * Strong path, step 2: produces the response code for the sender to scan.
   * The keys and the SAS only exist once the reveal code has been read
   * (`receiveRevealCode`).
   */
  async responseCode(): Promise<Uint8Array> {
    assertState("responseCode", this._state, ["appairage"]);
    const info = this.requireInfo();
    if (info.byPassphrase) throw new OrpInvalidState("responseCode", "passphrase pairing");
    if (this.responseCodeBytes) return this.responseCodeBytes;
    const pair = await this.crypto.generateEcdhKeyPair();
    this.ephemeralPrivateKey = pair.privateKey;
    this.responseCodeBytes = writeResponseCode(info.sessionId, pair.publicKey);
    return this.responseCodeBytes;
  }

  /**
   * Strong path, step 3: reads the reveal code (sender pub), checks it opens
   * the commitment of the init code, derives the keys and the SAS.
   */
  async receiveRevealCode(code: Uint8Array): Promise<void> {
    assertState("receiveRevealCode", this._state, ["appairage"]);
    const info = this.requireInfo();
    if (!this.ephemeralPrivateKey || !this.responseCodeBytes) throw new OrpPairingRequired("response code not produced yet");
    const parsed = readRevealCode(code);
    if (!bytesEqual(parsed.sessionId, info.sessionId)) throw new OrpInvalidPairingCode("reveal code from another session");
    const expected = await commitmentOf(this.crypto, info.sessionId, parsed.senderPublicKey);
    if (!constantTimeEqual(expected, info.commitment)) {
      throw new OrpInvalidPairingCode("the reveal code does not open the commitment of the init code");
    }
    const secret = await this.crypto.deriveEcdhSecret(this.ephemeralPrivateKey, parsed.senderPublicKey);
    try {
      const transcript = await transcriptHash(this.crypto, this.initCodeBytes!, this.responseCodeBytes, code);
      this.keys = await deriveKeys(this.crypto, secret, transcript);
    } finally {
      secret.fill(0);
    }
    this.ephemeralPrivateKey = undefined;
    this._state = "sas";
  }

  /** Degraded path: shared passphrase, stretched by PBKDF2, bound to the init code. */
  async pairWithPassphrase(passphrase: string): Promise<void> {
    assertState("pairWithPassphrase", this._state, ["appairage"]);
    if (!this.requireInfo().byPassphrase) throw new OrpInvalidState("pairWithPassphrase", "pairing by codes");
    this.keys = await deriveKeysFromPassphrase(this.crypto, passphrase, this.initCodeBytes!);
    this._state = "sas";
  }

  sas(): string {
    assertState("sas", this._state, ["sas"]);
    return this.requireKeys().sas;
  }

  confirmSas(): void {
    assertState("confirmSas", this._state, ["sas"]);
    this._state = "calibre";
  }

  /**
   * Receives a frame — corrected or not by the optical layer: the
   * Reed-Solomon correction is redone here if needed (idempotent on a sound
   * frame). Any frame from an unknown session throws OrpUnknownSession: the
   * caller must stop listening to this channel.
   */
  async receiveFrame(t: Uint8Array): Promise<FrameStatus> {
    assertState("receiveFrame", this._state, ["calibre", "transmission", "termine"]);
    if (this._state === "calibre") this._state = "transmission";
    let decoded;
    try {
      decoded = readFrame(t);
    } catch (e) {
      const reason = e instanceof OrpCorruptedFrame ? "corrompue" : "invalide";
      if (reason === "corrompue") this.stats.corrupted++;
      this.events.emit("rejection", { reason });
      return { accepted: false, rejection: reason as "corrompue" | "invalide" };
    }
    const { header } = decoded;
    try {
      requireCompatibleVersion(header.version, PROTOCOL_VERSION);
    } catch {
      this.events.emit("rejection", { reason: "version" });
      return { accepted: false, rejection: "version" };
    }
    if (header.flags & (FLAG.TEST_PATTERN | FLAG.PAIRING)) {
      // Service frames: test pattern and pairing follow another path.
      return { accepted: true };
    }
    const info = this.requireInfo();
    this.requireKeys();
    if (header.token !== tokenOf(info.sessionId)) {
      this.logger.warn("frame from an unknown session", { token: header.token });
      throw new OrpUnknownSession(header.token);
    }
    // Frame outside the layout announced by the init code: block that does
    // not exist, or K that is not the one of the block. Rejected before any
    // allocation — a decoder per forged block number would grow without bound.
    if (header.k !== expectedK(info.streamSize, header.block)) {
      this.events.emit("rejection", { reason: "invalide", block: header.block, seed: header.seed });
      return { accepted: false, rejection: "invalide" };
    }
    // Encryption announced by the init code (bound to the keys by the
    // transcript): a clear frame in an encrypted session is a forgery, never
    // a frame to decode.
    const encrypted = (header.flags & FLAG.ENCRYPTED) !== 0;
    if (encrypted !== info.encrypted) {
      this.stats.forged++;
      this.events.emit("rejection", { reason: "falsifiee", block: header.block, seed: header.seed });
      return { accepted: false, rejection: "falsifiee" };
    }
    // Replay: (block, seed) already seen — ignored, counted, never decoded again.
    const key = `${header.block}/${header.seed}`;
    if (this.seen.has(key)) {
      this.stats.replays++;
      this.events.emit("rejection", { reason: "rejeu", block: header.block, seed: header.seed });
      return { accepted: false, rejection: "rejeu" };
    }
    let payload = decoded.payload;
    if (encrypted) {
      try {
        const keys = this.requireKeys();
        const nonce = await frameNonce(this.crypto, keys.nonceKey, header.block, header.seed);
        const aad = frameAad(majorityMeta(t), writeBodyHeader(header));
        payload = await this.crypto.decryptAead(keys.dataKey, nonce, decoded.payload, decoded.tag!, aad);
      } catch {
        this.stats.forged++;
        this.events.emit("rejection", { reason: "falsifiee", block: header.block, seed: header.seed });
        return { accepted: false, rejection: "falsifiee" };
      }
    }
    this.seen.add(key);
    this.stats.frames++;
    const decoder = this.decoderFor(header);
    for (let i = 0; i < header.symbolCount; i++) {
      const chunk = payload.subarray(i * SYMBOL_SIZE, (i + 1) * SYMBOL_SIZE);
      decoder.receive(header.seed + i, chunk);
    }
    if (decoder.complete) {
      this.events.emit("block", { block: header.block });
      if (!this.completeAnnounced && this.allComplete()) {
        this.completeAnnounced = true;
        this.events.emit("complete", { streamSize: info.streamSize });
      }
    }
    this.events.emit("progress", this.progress());
    return { accepted: true };
  }

  private requireInfo(): InitCodeInfo {
    if (!this.info) throw new OrpPairingRequired("init code not seen");
    return this.info;
  }

  private requireKeys(): SessionKeys {
    if (!this.keys) throw new OrpPairingRequired("keys not derived — pairing incomplete");
    return this.keys;
  }

  private decoderFor(header: { block: number; k: number }): FountainDecoder {
    let d = this.decoders.get(header.block);
    if (!d) {
      d = new FountainDecoder(header.k);
      this.decoders.set(header.block, d);
    }
    return d;
  }

  /**
   * State of EACH block. The file is only complete when all of them are: a
   * total of symbols ≥ K says nothing about a lagging block. K of a block
   * never seen yet: estimated from what remains (same rule as orp-core).
   */
  blocks(): { k: number; received: number; complete: boolean }[] {
    const count = this.totalBlocks();
    const size = this.info?.streamSize ?? 0;
    return Array.from({ length: count }, (_, b) => {
      const d = this.decoders.get(b);
      return d ? { k: d.k, received: d.receivedSymbols, complete: d.complete } : { k: expectedK(size, b), received: 0, complete: false };
    });
  }

  private totalBlocks(): number {
    return this.info?.blockCount ?? 0;
  }

  private allComplete(): boolean {
    for (let b = 0; b < this.totalBlocks(); b++) {
      if (!this.decoders.get(b)?.complete) return false;
    }
    return true;
  }

  get done(): boolean {
    return this.allComplete();
  }

  progress(): ReceiveProgress {
    return {
      completedBlocks: [...this.decoders.values()].filter((d) => d.complete).length,
      blockCount: this.totalBlocks(),
      receivedSymbols: [...this.decoders.values()].reduce((a, d) => a + d.receivedSymbols, 0),
      receivedFrames: this.stats.frames,
      replays: this.stats.replays,
      forged: this.stats.forged,
      corrupted: this.stats.corrupted,
    };
  }

  /** Reconstruction, global integrity check (F-09) and decompression. */
  async result(): Promise<{ data: Uint8Array; verified: boolean }> {
    assertState("result", this._state, ["transmission", "termine"]);
    const info = this.requireInfo();
    this.requireKeys();
    if (!this.allComplete()) throw new OrpInvalidState("result", "incomplete transmission");
    const chunks: Uint8Array[] = [];
    for (let b = 0; b < info.blockCount; b++) {
      chunks.push(assemble(this.decoders.get(b)!.reconstruct(), Number.MAX_SAFE_INTEGER));
    }
    let stream = concatTruncated(chunks, info.streamSize);
    const digest = await this.crypto.sha256(stream);
    if (!bytesEqual(digest, info.streamDigest)) {
      throw new OrpIntegrityError("the SHA-256 digest of the rebuilt stream does not match");
    }
    if (info.compressed) stream = await decompress(stream, this.maxFileSize);
    this._state = "termine";
    return { data: stream, verified: true };
  }

  dispose(): void {
    wipeKeys(this.keys);
    this.keys = undefined;
    this.decoders.clear();
  }
}

/** Comparison whose duration does not depend on where the arrays differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function concatTruncated(chunks: Uint8Array[], size: number): Uint8Array {
  const stream = new Uint8Array(size);
  let pos = 0;
  for (const m of chunks) {
    const cut = Math.min(pos + m.length, size);
    stream.set(m.subarray(0, cut - pos), pos);
    pos = cut;
    if (pos >= size) break;
  }
  return stream;
}
