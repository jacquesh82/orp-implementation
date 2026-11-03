/**
 * Optional compression, negotiated by the COMPRESSE flag of the header
 * (F-08 of the user journey: "compressed when relevant, then encrypted").
 * deflate-raw through CompressionStream when the platform offers it —
 * otherwise `compress` returns null and the sender falls back to "stored"
 * mode (no compression): missing compression never prevents a transfer.
 */

import { OrpCompressionUnavailable, OrpError } from "./errors.ts";

function compressionAvailable(): boolean {
  return typeof globalThis.CompressionStream === "function" && typeof globalThis.DecompressionStream === "function";
}

/**
 * Pushes `data` through the transform and collects its output, stopping
 * (and cancelling the stream) past `maxOutput` bytes. The write side is
 * awaited: a malformed deflate stream surfaces as ONE rejection here, never
 * as an unhandled one.
 */
async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream, maxOutput: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(data as BufferSource).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxOutput) {
        await reader.cancel().catch(() => undefined);
        await writer.abort().catch(() => undefined);
        throw new OrpError("taille-excessive", `decompressed data larger than ${maxOutput} bytes`);
      }
      chunks.push(value);
    }
  })();
  // The reading side decides: its rejection (bound exceeded, bad data) is the
  // one reported, even if aborting the writer rejected the writing side too.
  const [read, written] = await Promise.allSettled([reading, writing]);
  if (read.status === "rejected") throw read.reason;
  if (written.status === "rejected") throw written.reason;
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
  const compressed = await pipeThrough(data, new CompressionStream("deflate-raw"), Number.MAX_SAFE_INTEGER);
  // A negative "gain" makes no sense on the wire: keep the stored form.
  return compressed.byteLength < data.byteLength ? compressed : null;
}

/** Decompresses a deflate-raw stream — throws past `maxOutput` bytes (deflate bomb). */
export async function decompress(data: Uint8Array, maxOutput: number = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  if (!compressionAvailable()) throw new OrpCompressionUnavailable();
  return pipeThrough(data, new DecompressionStream("deflate-raw"), maxOutput);
}
