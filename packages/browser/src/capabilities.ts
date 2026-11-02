/**
 * Capability detection (rule 7.1-2) and choice of the fallback mode — the
 * full compatibility matrix is kept in docs/ (INT-07).
 */

export interface Capabilities {
  /** WebCrypto available (encryption required). */
  crypto: boolean;
  /** CompressionStream (optional deflate-raw compression). */
  compression: boolean;
  /** getUserMedia (camera reception). */
  camera: boolean;
  /** Secure context — required by the camera and by full WebCrypto. */
  secureContext: boolean;
}

export function detectCapabilities(): Capabilities {
  const g = globalThis as Record<string, unknown>;
  return {
    crypto: Boolean(g.crypto && (g.crypto as Crypto).subtle),
    compression: typeof g.CompressionStream === "function",
    camera: typeof g.navigator === "object" && typeof (g.navigator as Navigator).mediaDevices?.getUserMedia === "function",
    secureContext: typeof g.isSecureContext === "boolean" ? (g.isSecureContext as boolean) : false,
  };
}

export interface CapabilityAdvice {
  /** Codecs the device can reasonably try, in order of preference. */
  recommendedCodecs: number[];
  messages: string[];
}

import { CODEC } from "@optirelay/core";

/** Recommends a codec order according to the capabilities — the calibration (F-05) decides. */
export function recommendCodecs(capabilities: Capabilities): CapabilityAdvice {
  const messages: string[] = [];
  if (!capabilities.secureContext) messages.push("Insecure context: the browser will refuse the camera (HTTPS required).");
  if (!capabilities.crypto) messages.push("WebCrypto unavailable: the required encryption cannot be provided.");
  if (!capabilities.camera) messages.push("getUserMedia unavailable: receiving is impossible in this browser.");
  if (!capabilities.compression) messages.push("CompressionStream unavailable: transfer without compression (no loss of function).");
  // The calibration decides the actual mode; MONO_2 is always the fallback (F-02/F-06).
  return { recommendedCodecs: [CODEC.COLOR_8, CODEC.COLOR_4, CODEC.MONO_2], messages };
}
