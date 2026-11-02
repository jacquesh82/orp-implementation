/**
 * Optional compression, negotiated by the COMPRESSE flag of the header
 * (F-08 of the user journey: "compressed when relevant, then encrypted").
 * deflate-raw through CompressionStream when the platform offers it —
 * otherwise `compress` returns null and the sender falls back to "stored"
 * mode (no compression): missing compression never prevents a transfer.
 */

import { OrpCompressionUnavailable } from "./errors.ts";

type CompressionTransform = CompressionStream;

function compressionAvailable(): boolean {
  return typeof globalThis.CompressionStream === "function" && typeof globalThis.DecompressionStream === "function";
}

async function pipeThrough(data: Uint8Array, Transform: typeof CompressionStream): Promise<Uint8Array> {
  const stream = new Transform("deflate-raw") as CompressionTransform;
  const writer = stream.writable.getWriter();
  void writer.write(data as BufferSource);
  void writer.close();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const output = new Uint8Array(total);
  let pos = 0;
  for (const m of chunks) {
    output.set(m, pos);
    pos += m.byteLength;
  }
  return output;
}

/** Compresses with deflate-raw; null if the platform cannot do it. */
export async function compress(data: Uint8Array): Promise<Uint8Array | null> {
  if (!compressionAvailable()) return null;
  const compressed = await pipeThrough(data, globalThis.CompressionStream);
  // A negative "gain" makes no sense on the wire: keep the stored form.
  return compressed.byteLength < data.byteLength ? compressed : null;
}

/** Decompresses a deflate-raw stream. */
export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (!compressionAvailable()) throw new OrpCompressionUnavailable();
  return pipeThrough(data, globalThis.DecompressionStream as unknown as typeof CompressionStream);
}
