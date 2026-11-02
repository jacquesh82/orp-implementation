/**
 * @optirelay/core — ORP protocol: messages, session, pairing, encryption,
 * segmentation and fountain codes. No DOM (F-16): dependencies are injected.
 */

export * from "./errors.ts";
export * from "./versions.ts";
export * from "./logger.ts";
export {
  SYMBOL_SIZE,
  K_MAX,
  MAX_FRAME_SYMBOLS,
  META_SIZE,
  META_COPIES,
  BODY_HEADER_SIZE,
  SEGMENT_SIZE,
  TAG_SIZE,
  CRC_SIZE,
  CODEC,
  FLAG,
  SYMBOL_CAPACITY,
  codecName,
  crc32,
  bodySize,
  segmentCount,
  frameSize,
  writeMeta,
  writeBodyHeader,
  buildFrame,
  readFrame,
  frameAad,
  majorityMeta,
  readMetaByMajority,
  FRAME_VERSION,
} from "./frames.ts";
export type { Codec, FrameHeader, DecodedFrame } from "./frames.ts";
export { rsParity, rsCorrect, RS_PARITY } from "./rs.ts";
export { mulberry32, ltNeighbors, fountainSymbol, FountainDecoder } from "./fountain.ts";
export { planBlocks, blockCount, kTotal, blockSymbols, assemble } from "./blocks.ts";
export type { BlockPlan } from "./blocks.ts";
export {
  CryptoWebCrypto,
  type CryptoProvider,
  type EcdhKeyPair,
} from "./encryption.ts";
export {
  deriveKeys,
  deriveSecretFromPassphrase,
  wipeKeys,
  writeInitCode,
  writeResponseCode,
  tokenOf,
  readInitCode,
  readResponseCode,
  frameNonce,
  INIT_CODE_SIZE,
  RESPONSE_CODE_SIZE,
  ECDH_PUBLIC_KEY_SIZE,
  SESSION_ID_SIZE,
} from "./pairing.ts";
export type { SessionKeys, InitCodeInfo } from "./pairing.ts";
export { compress, decompress } from "./compression.ts";
export { Events, SenderSession, ReceiverSession } from "./session.ts";
export type { SessionState, TransmissionOptions, ReceiveProgress, FrameStatus } from "./session.ts";
