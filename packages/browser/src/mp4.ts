/**
 * Minimal MP4 / MOV demuxer: the video track of a NON-fragmented file (what
 * Android's MediaRecorder and camera apps produce), as samples ready for
 * WebCodecs (VideoDecoder).
 *
 * Only the H.264 (avc1 / avc3) and H.265 (hvc1 / hev1) codecs are supported —
 * those of phones. The file is never read entirely: the `moov` box (index
 * tables) is read alone, each sample is read on demand, slice by slice of
 * the Blob.
 */

export interface VideoSample {
  /** Position and size in the file. */
  position: number;
  size: number;
  /** Presentation time (µs). */
  time: number;
  /** Duration (µs). */
  duration: number;
  keyFrame: boolean;
}

export interface VideoTrack {
  /** WebCodecs codec string (e.g. "avc1.640028", "hvc1.1.6.L120.90"). */
  codec: string;
  /** Content of avcC / hvcC: the decoder configuration. */
  description: Uint8Array;
  width: number;
  height: number;
  /** Duration of the track (s). */
  duration: number;
  samples: VideoSample[];
}

interface Mp4Box {
  type: string;
  /** Start of the content (after the header), end of the box. */
  startTime: number;
  end: number;
}

/** Child boxes of a byte range. */
function boxes(d: DataView, startTime: number, end: number): Mp4Box[] {
  const list: Mp4Box[] = [];
  let p = startTime;
  while (p + 8 <= end) {
    let size = d.getUint32(p);
    const type = String.fromCharCode(d.getUint8(p + 4), d.getUint8(p + 5), d.getUint8(p + 6), d.getUint8(p + 7));
    let header = 8;
    if (size === 1) {
      size = Number(d.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    list.push({ type, startTime: p + header, end: p + size });
    p += size;
  }
  return list;
}

function child(d: DataView, b: Mp4Box, type: string): Mp4Box | undefined {
  return boxes(d, b.startTime, b.end).find((x) => x.type === type);
}

function path(d: DataView, b: Mp4Box, ...types: string[]): Mp4Box | undefined {
  let current: Mp4Box | undefined = b;
  for (const t of types) {
    if (!current) return undefined;
    current = child(d, current, t);
  }
  return current;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** WebCodecs codec string of an HEVC configuration (ISO/IEC 14496-15, annex E). */
function hevcCodec(type: string, c: Uint8Array): string {
  const space = c[1]! >> 6;
  const tier = (c[1]! >> 5) & 1;
  const profile = c[1]! & 0x1f;
  let compat = ((c[2]! << 24) | (c[3]! << 16) | (c[4]! << 8) | c[5]!) >>> 0;
  let inverse = 0;
  for (let i = 0; i < 32; i++) {
    inverse = (inverse << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints = Array.from(c.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return (
    `${type}.${["", "A", "B", "C"][space]}${profile}.${(inverse >>> 0).toString(16)}.${tier ? "H" : "L"}${c[12]}` +
    constraints.map((x) => `.${hex(x)}`).join("")
  );
}

/** Reads the index of the first video track of an MP4 / MOV file. */
export async function readMp4Track(file: Blob): Promise<VideoTrack> {
  // Top-level boxes: only their headers are read, up to `moov`.
  let p = 0;
  let moov: { position: number; size: number } | null = null;
  while (p + 8 <= file.size) {
    const head = new DataView(await file.slice(p, p + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - p;
    if (size < 8) break;
    if (type === "moov") {
      moov = { position: p, size };
      break;
    }
    p += size;
  }
  if (!moov) throw new Error("Video file without an index (moov): MP4 / MOV expected.");
  const d = new DataView(await file.slice(moov.position, moov.position + moov.size).arrayBuffer());
  const root: Mp4Box = { type: "moov", startTime: 8, end: d.byteLength };

  for (const trak of boxes(d, root.startTime, root.end).filter((b) => b.type === "trak")) {
    const mdia = child(d, trak, "mdia");
    const hdlr = mdia && child(d, mdia, "hdlr");
    if (!mdia || !hdlr) continue;
    const handler = String.fromCharCode(d.getUint8(hdlr.startTime + 8), d.getUint8(hdlr.startTime + 9), d.getUint8(hdlr.startTime + 10), d.getUint8(hdlr.startTime + 11));
    if (handler !== "vide") continue;

    const mdhd = child(d, mdia, "mdhd")!;
    const v1 = d.getUint8(mdhd.startTime) === 1;
    const scale = d.getUint32(mdhd.startTime + (v1 ? 20 : 12));
    const rawDuration = v1 ? Number(d.getBigUint64(mdhd.startTime + 24)) : d.getUint32(mdhd.startTime + 16);
    const stbl = path(d, mdia, "minf", "stbl");
    if (!stbl) continue;

    // Sample description: codec, size, configuration.
    const stsd = child(d, stbl, "stsd")!;
    const entry = boxes(d, stsd.startTime + 8, stsd.end)[0]!;
    const width = d.getUint16(entry.startTime + 24);
    const height = d.getUint16(entry.startTime + 26);
    const config = boxes(d, entry.startTime + 78, entry.end);
    let codec: string;
    let cfg: Mp4Box | undefined;
    if (entry.type === "avc1" || entry.type === "avc3") {
      cfg = config.find((b) => b.type === "avcC");
      if (!cfg) throw new Error("H.264 video without configuration (avcC).");
      codec = `${entry.type}.${hex(d.getUint8(cfg.startTime + 1))}${hex(d.getUint8(cfg.startTime + 2))}${hex(d.getUint8(cfg.startTime + 3))}`;
    } else if (entry.type === "hvc1" || entry.type === "hev1") {
      cfg = config.find((b) => b.type === "hvcC");
      if (!cfg) throw new Error("H.265 video without configuration (hvcC).");
      codec = hevcCodec(entry.type, new Uint8Array(d.buffer, d.byteOffset + cfg.startTime, 13));
    } else {
      throw new Error(`Video codec "${entry.type}" not supported (H.264 or H.265 expected).`);
    }
    const description = new Uint8Array(d.buffer.slice(d.byteOffset + cfg.startTime, d.byteOffset + cfg.end));

    // Index tables.
    const table = (type: string) => child(d, stbl, type);
    const stsz = table("stsz")!;
    const fixedSize = d.getUint32(stsz.startTime + 4);
    const total = d.getUint32(stsz.startTime + 8);
    const sizes = Array.from({ length: total }, (_, i) => (fixedSize || d.getUint32(stsz.startTime + 12 + 4 * i)));

    const stco = table("stco");
    const co64 = table("co64");
    const chunks: number[] = [];
    if (stco) for (let i = 0, n = d.getUint32(stco.startTime + 4); i < n; i++) chunks.push(d.getUint32(stco.startTime + 8 + 4 * i));
    else if (co64) for (let i = 0, n = d.getUint32(co64.startTime + 4); i < n; i++) chunks.push(Number(d.getBigUint64(co64.startTime + 8 + 8 * i)));

    const stsc = table("stsc")!;
    const rules = Array.from({ length: d.getUint32(stsc.startTime + 4) }, (_, i) => ({
      first: d.getUint32(stsc.startTime + 8 + 12 * i),
      perChunk: d.getUint32(stsc.startTime + 12 + 12 * i),
    }));

    const stts = table("stts")!;
    const deltas: number[] = [];
    for (let i = 0, n = d.getUint32(stts.startTime + 4); i < n; i++) {
      const count = d.getUint32(stts.startTime + 8 + 8 * i);
      const delta = d.getUint32(stts.startTime + 12 + 8 * i);
      for (let k = 0; k < count && deltas.length < total; k++) deltas.push(delta);
    }
    const ctts = table("ctts");
    const offsets = new Array<number>(total).fill(0);
    if (ctts) {
      let s = 0;
      for (let i = 0, n = d.getUint32(ctts.startTime + 4); i < n; i++) {
        const count = d.getUint32(ctts.startTime + 8 + 8 * i);
        const offset = d.getInt32(ctts.startTime + 12 + 8 * i);
        for (let k = 0; k < count && s < total; k++) offsets[s++] = offset;
      }
    }
    const stss = table("stss");
    const keys = stss ? new Set(Array.from({ length: d.getUint32(stss.startTime + 4) }, (_, i) => d.getUint32(stss.startTime + 8 + 4 * i) - 1)) : null;

    const samples: VideoSample[] = [];
    let s = 0;
    let dts = 0;
    for (let m = 0; m < chunks.length && s < total; m++) {
      let rule = rules[0]!;
      for (const r of rules) if (r.first <= m + 1) rule = r;
      let position = chunks[m]!;
      for (let k = 0; k < rule.perChunk && s < total; k++, s++) {
        const delta = deltas[s] ?? deltas[deltas.length - 1] ?? 0;
        samples.push({
          position,
          size: sizes[s]!,
          time: Math.round(((dts + offsets[s]!) * 1e6) / scale),
          duration: Math.round((delta * 1e6) / scale),
          keyFrame: keys ? keys.has(s) : true,
        });
        position += sizes[s]!;
        dts += delta;
      }
    }
    return { codec, description, width, height, duration: rawDuration / scale, samples };
  }
  throw new Error("No video track in this file.");
}
