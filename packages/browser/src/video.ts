/**
 * Reading a recorded VIDEO (typically a 120 / 240 fps slow motion filmed with
 * the phone camera app): each image is rendered by the browser decoder, then
 * goes through the same pipeline as the live camera (TmPipeline). Outside
 * real time, computation no longer limits the subframe duration: the sender
 * can go down to a single screen refresh.
 *
 * Decoding: WebCodecs (VideoDecoder) on the samples of the MP4 / MOV file
 * (readMp4Track) — EVERY image, in order, at the pace of the analysis. A
 * <video> player played in slow motion skips dozens of images: it is only a
 * last resort (unknown format, no WebCodecs).
 *
 * Two regimes:
 *   - SEARCH: as long as no grid is seen (the time to aim), one image is
 *     analyzed every 80 ms of media time — we do not pay for analyzing
 *     seconds of useless video;
 *   - READING: as soon as a grid appears, every image is analyzed.
 * The pipeline time is the MEDIA time of each image.
 *
 * Filming: `filmSlowMotion` (Android APK: native camera screen at 120/240 fps)
 * or `filmStream` (browser: images of the camera stream encoded in memory by
 * VideoEncoder, 60 fps at best). The app films, then reads.
 */

import type { Codec } from "@optirelay/core";
import type { ImageRGBA, TmReceiverOptions } from "@optirelay/optical";
import { TmPipeline } from "./tm.ts";
import { readMp4Track } from "./mp4.ts";

/** Encoded video kept in memory (browser filming): no container. */
export interface EncodedVideo {
  config: VideoDecoderConfig;
  chunks: EncodedVideoChunk[];
  /** Duration (s). */
  duration: number;
}

export interface VideoProgress {
  /** Position and duration (s) in the video. */
  position: number;
  duration: number;
  /** Images analyzed, and images the decoder skipped. */
  images: number;
  skipped: number;
  /** Estimated frame rate of the video (images per second of media time). */
  frameRate: number | null;
  /** Grids seen in the last image. */
  grids: number;
  valid: number;
  pairs: number;
  mixed: number;
  /** Mean analysis time of an image (ms). */
  msPerImage: number;
}

export interface VideoReadOptions extends TmReceiverOptions {
  /** Called for each new VALID frame. */
  /** New valid frame; `t`: time in the video (s). */
  onFrame?: (bytes: Uint8Array, codec: Codec, t: number) => void;
  /** Called regularly (≈ 4 times per second of real time). */
  onProgress?: (p: VideoProgress) => void;
  /** Decoding width (default 1920). */
  width?: number;
  signal?: AbortSignal;
}

type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
};

function newProgress(): VideoProgress {
  return { position: 0, duration: 0, images: 0, skipped: 0, frameRate: null, grids: 0, valid: 0, pairs: 0, mixed: 0, msPerImage: 0 };
}

/**
 * Reads the whole video (MP4 / MOV file, or video encoded in memory);
 * returns the final progress. The valid frames go out through `onFrame`.
 */
export async function readTmVideo(source: Blob | EncodedVideo, options: VideoReadOptions = {}): Promise<VideoProgress> {
  if (!(source instanceof Blob)) return decodeAndRead(source.config, source.chunks, source.duration, options);
  if (source.size === 0) throw new Error("Empty video.");
  if (typeof VideoDecoder !== "undefined") {
    let track: Awaited<ReturnType<typeof readMp4Track>> | null = null;
    try {
      track = await readMp4Track(source);
    } catch (e) {
      console.warn("[optirelay] MP4 demuxing failed, reading through <video>:", (e as Error).message);
    }
    if (track) {
      const config: VideoDecoderConfig = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description };
      const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (!support.supported) throw new Error(`This browser cannot decode this video (${track.codec}).`);
      const file = source;
      const samples = track.samples;
      async function* chunks(): AsyncGenerator<EncodedVideoChunk> {
        for (const e of samples) {
          const data = new Uint8Array(await file.slice(e.position, e.position + e.size).arrayBuffer());
          yield new EncodedVideoChunk({ type: e.keyFrame ? "key" : "delta", timestamp: e.time, duration: e.duration, data });
        }
      }
      return decodeAndRead(config, chunks(), track.duration, options);
    }
  }
  return readWithElement(source, options);
}

/** WebCodecs core: decodes each chunk, analyzes the images in order. */
async function decodeAndRead(
  config: VideoDecoderConfig,
  chunks: Iterable<EncodedVideoChunk> | AsyncIterable<EncodedVideoChunk>,
  duration: number,
  options: VideoReadOptions,
): Promise<VideoProgress> {
  // Several images per subframe: average them (noise of a short exposure).
  const pipeline = new TmPipeline({ averaging: true, ...options });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const progress = newProgress();
  progress.duration = duration;
  let analysisTime = 0;
  let lastNotification = 0;
  let lastSearch = -Infinity;
  let lastGrid = -Infinity;
  let previous: number | null = null;
  const gaps: number[] = [];
  // Duration of the sender subframes, measured at the R↔P switches: with
  // subframes long compared to the frame rate, ~3 images per subframe are enough.
  const switches: number[] = [];
  let lastType: "R" | "P" | null = null;
  let lastSwitch: number | null = null;
  let lastAnalysis = -Infinity;
  const queue: VideoFrame[] = [];
  let error: Error | null = null;

  const notify = (force = false) => {
    const now = performance.now();
    if (!force && now - lastNotification < 250) return;
    lastNotification = now;
    Object.assign(progress, pipeline.stats, { msPerImage: progress.images ? analysisTime / progress.images : 0 });
    options.onProgress?.({ ...progress });
  };

  const analyze = (image: VideoFrame) => {
    const t = image.timestamp / 1e6;
    progress.position = t;
    if (previous !== null && t > previous) {
      const gap = t - previous;
      if (gaps.length < 15) {
        gaps.push(gap);
        if (gaps.length === 15) progress.frameRate = 1 / [...gaps].sort((a, b) => a - b)[7]!;
      }
    }
    previous = t;
    // SEARCH while there is no recent grid: one image every 80 ms.
    const searching = t - lastGrid > 0.5;
    if (searching && t - lastSearch < 0.08) return;
    if (searching) lastSearch = t;
    if (!searching && switches.length >= 4 && progress.frameRate) {
      const subframe = [...switches].sort((a, b) => a - b)[switches.length >> 1]!;
      if (t - lastAnalysis < subframe / 3 - 0.5 / progress.frameRate) return;
    }
    lastAnalysis = t;
    const width = options.width ?? 1920;
    const scale = Math.min(1, width / image.displayWidth);
    const l = Math.round(image.displayWidth * scale);
    const h = Math.round(image.displayHeight * scale);
    if (canvas.width !== l || canvas.height !== h) {
      canvas.width = l;
      canvas.height = h;
    }
    context.drawImage(image, 0, 0, l, h);
    const d = context.getImageData(0, 0, l, h);
    const startTime = performance.now();
    const all = pipeline.process({ width: d.width, height: d.height, data: d.data }, t * 1000);
    analysisTime += performance.now() - startTime;
    progress.images++;
    progress.grids = all.filter((r) => r.location).length;
    if (progress.grids > 0) lastGrid = t;
    const type = all[0]?.subframe?.type;
    if ((type === "R" || type === "P") && type !== lastType) {
      if (lastSwitch !== null && lastType !== null && t - lastSwitch < 1) {
        switches.push(t - lastSwitch);
        if (switches.length > 9) switches.shift();
      }
      lastSwitch = t;
      lastType = type;
    }
    for (const r of all) if (r.frame?.isNew) options.onFrame?.(r.frame.bytes, r.frame.codec, t);
  };

  const drain = () => {
    while (queue.length) {
      const image = queue.shift()!;
      try {
        analyze(image);
      } catch (e) {
        console.warn("[optirelay] video image skipped:", (e as Error).message);
      } finally {
        image.close();
      }
    }
    notify();
  };

  const decoder = new VideoDecoder({
    output: (image) => queue.push(image),
    error: (e) => (error = e instanceof Error ? e : new Error(String(e))),
  });
  try {
    decoder.configure(config);
    for await (const chunk of chunks) {
      if (options.signal?.aborted) throw new DOMException("Playback interrupted", "AbortError");
      if (error) throw error;
      decoder.decode(chunk);
      // Back-pressure: the decoder takes no more than a few images of lead.
      while (decoder.decodeQueueSize > 4 || queue.length > 2) {
        drain();
        await new Promise((r) => setTimeout(r, 0));
        if (error) throw error;
      }
      drain();
    }
    await decoder.flush();
    drain();
    if (error) throw error;
    notify(true);
    return { ...progress };
  } finally {
    for (const image of queue) image.close();
    if (decoder.state !== "closed") decoder.close();
  }
}

/** Last resort: reading through a <video> element (images may be skipped). */
async function readWithElement(file: Blob, options: VideoReadOptions): Promise<VideoProgress> {
  const video = document.createElement("video") as VideoWithCallback;
  if (!video.requestVideoFrameCallback) throw new Error("This browser cannot read a video frame by frame.");
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Off screen but RENDERED: a detached or hidden video (display:none) presents
  // no image, and requestVideoFrameCallback would never fire.
  Object.assign(video.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" });
  document.body.appendChild(video);
  video.src = url;

  // Several images per subframe: average them (noise of a short exposure).
  const pipeline = new TmPipeline({ averaging: true, ...options });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const progress = newProgress();
  let analysisTime = 0;
  let lastNotification = 0;
  const gaps: number[] = [];
  let previousMediaTime: number | null = null;

  const notify = (force = false) => {
    const now = performance.now();
    if (!force && now - lastNotification < 250) return;
    lastNotification = now;
    Object.assign(progress, pipeline.stats, { msPerImage: progress.images ? analysisTime / progress.images : 0 });
    options.onProgress?.({ ...progress });
  };

  try {
    await new Promise<void>((ok, fail) => {
      video.onloadedmetadata = () => ok();
      video.onerror = () => fail(new Error("Video unreadable by this browser (format or codec not supported)."));
    });
    progress.duration = Number.isFinite(video.duration) ? video.duration : 0;
    let searching = true;
    let lastSearch = -Infinity;
    let lastGrid = 0;
    let slowRate = 0.125;
    video.playbackRate = 1;

    await new Promise<void>((ok, fail) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        ok();
      };
      options.signal?.addEventListener("abort", () => {
        finished = true;
        fail(new DOMException("Playback interrupted", "AbortError"));
      });
      video.onended = () => finish();
      const resume = () => {
        video.requestVideoFrameCallback!(tick);
        void video.play().catch((e: Error) => {
          if (!finished) fail(e);
        });
      };

      const tick = (_now: number, meta: { mediaTime: number }) => {
        if (finished) return;
        const t = meta.mediaTime;
        progress.position = t;
        if (searching) {
          // SEARCH: the video keeps playing; one image from time to time.
          video.requestVideoFrameCallback!(tick);
          if (performance.now() - lastSearch < 80) return;
          lastSearch = performance.now();
          let view = false;
          try {
            view = analyze(t) > 0;
          } catch (e) {
            console.warn("[optirelay] video image skipped:", (e as Error).message);
          }
          notify();
          if (!view) return;
          // Grid found: step back a little, then image by image.
          searching = false;
          lastGrid = t;
          previousMediaTime = null;
          video.pause();
          video.playbackRate = slowRate;
          video.currentTime = Math.max(0, t - 0.15);
          video.addEventListener("seeked", () => resume(), { once: true });
          return;
        }
        // READING: pause while this image is analyzed.
        video.pause();
        try {
          trackFrameRate(t);
          if (analyze(t) > 0) lastGrid = t;
        } catch (e) {
          console.warn("[optirelay] video image skipped:", (e as Error).message);
        }
        notify();
        if (video.ended || (progress.duration > 0 && t >= progress.duration - 1e-3)) return finish();
        if (t - lastGrid > 0.5) {
          // No grid for half a second (the phone left the screen).
          searching = true;
          video.playbackRate = 1;
        }
        resume();
      };

      const trackFrameRate = (t: number) => {
        if (previousMediaTime !== null) {
          const gap = t - previousMediaTime;
          if (gap > 0) {
            if (gaps.length < 15) {
              gaps.push(gap);
              if (gaps.length === 15) {
                const period = [...gaps].sort((a, b) => a - b)[3]!; // low quantile: without the jumps
                progress.frameRate = 1 / period;
                // At most one image per refresh (60 Hz) of real time.
                slowRate = Math.min(1, Math.max(0.0625, period * 60 * 0.8));
                video.playbackRate = slowRate;
              }
            } else if (progress.frameRate) {
              progress.skipped += Math.max(0, Math.round(gap * progress.frameRate) - 1);
            }
          }
        }
        previousMediaTime = t;
      };

      /** Analyzes the presented image; returns the number of grids seen. */
      const analyze = (t: number): number => {
        const width = options.width ?? 1920;
        const scale = Math.min(1, width / video.videoWidth);
        const l = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);
        if (canvas.width !== l || canvas.height !== h) {
          canvas.width = l;
          canvas.height = h;
        }
        context.drawImage(video, 0, 0, l, h);
        const d = context.getImageData(0, 0, l, h);
        const image: ImageRGBA = { width: d.width, height: d.height, data: d.data };
        const startTime = performance.now();
        const all = pipeline.process(image, t * 1000);
        analysisTime += performance.now() - startTime;
        progress.images++;
        progress.grids = all.filter((r) => r.location).length;
        for (const r of all) if (r.frame?.isNew) options.onFrame?.(r.frame.bytes, r.frame.codec, t);
        return progress.grids;
      };

      resume();
    });
    notify(true);
    return { ...progress };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

// ── Filming ───────────────────────────────────────────────────────────────

export interface FilmedVideo {
  video: Blob | EncodedVideo;
  /** Frame rate requested from the sensor (images/s), if known. */
  frameRate?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  source: "native-slow-motion" | "browser";
}

interface SlowMotionBridge {
  filmSlowMotion?: (maxSeconds: number) => boolean;
}

declare global {
  interface Window {
    OptiRelayAndroid?: SlowMotionBridge & Record<string, unknown>;
    /** Callback set by filmSlowMotion, called by the APK at the end of the filming. */
    __optirelaySlowMotion?: ((result: string) => void) | undefined;
  }
}

/** True in the APK: a native camera screen films in slow motion (120 / 240 fps). */
export function nativeSlowMotionAvailable(): boolean {
  return typeof window.OptiRelayAndroid?.filmSlowMotion === "function";
}

/**
 * Android APK: opens the native camera screen (high-speed session), which
 * films until "Finish" or `maxSeconds`, then returns the video. The page
 * camera must be CLOSED first: the sensor cannot be shared.
 *
 * Android bridge contract (shared with the Kotlin side, MainActivity /
 * SlowMotionActivity): `window.OptiRelayAndroid.filmSlowMotion` and the JSON
 * fields sent back to `window.__optirelaySlowMotion` (url, error, frameRate,
 * width, height, duration).
 */
export async function filmSlowMotion(maxSeconds = 20, openStream?: MediaStream): Promise<FilmedVideo> {
  if (openStream) await releaseCamera(openStream);
  return new Promise((ok, fail) => {
    window.__optirelaySlowMotion = (text: string) => {
      window.__optirelaySlowMotion = undefined;
      const r = JSON.parse(text) as { url?: string; error?: string; frameRate?: number; width?: number; height?: number };
      if (!r.url) return fail(new Error(r.error ?? "Recording cancelled."));
      fetch(r.url)
        .then((response) => {
          if (!response.ok) throw new Error(`video not found (${response.status})`);
          return response.blob();
        })
        .then((video) => ok({ video, frameRate: r.frameRate, width: r.width, height: r.height, source: "native-slow-motion" }))
        .catch(fail);
    };
    if (!window.OptiRelayAndroid?.filmSlowMotion?.(maxSeconds)) {
      window.__optirelaySlowMotion = undefined;
      fail(new Error("The native slow-mo could not start."));
    }
  });
}

/**
 * Stops a camera stream AND waits for the sensor to be released: stopping
 * the tracks only frees the camera after a delay (≈ 100 to 300 ms on the
 * S25); a native screen that opens it right away is refused ("error 2").
 */
export async function releaseCamera(stream: MediaStream): Promise<void> {
  for (const track of stream.getTracks()) track.stop();
  for (const v of Array.from(document.querySelectorAll("video"))) if (v.srcObject === stream) v.srcObject = null;
  await new Promise((r) => setTimeout(r, 500));
}

export interface Recording {
  /** Stops the recording; `result` resolves afterwards. */
  stop(): void;
  result: Promise<FilmedVideo>;
}

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack }): TrackProcessor } | undefined;

/**
 * Browser: films the already open camera stream until stop() or
 * `maxSeconds`. Each image of the stream is encoded in memory (VideoEncoder,
 * high bitrate, no image lost as long as the encoder keeps up); without
 * WebCodecs, MediaRecorder. The frame rate is the stream's (60 fps at best).
 */
export function filmStream(stream: MediaStream, maxSeconds = 20): Recording {
  const track = stream.getVideoTracks()[0];
  if (track && typeof MediaStreamTrackProcessor !== "undefined" && typeof VideoEncoder !== "undefined") {
    return filmWithEncoder(track, maxSeconds);
  }
  return filmWithMediaRecorder(stream, maxSeconds);
}

function filmWithEncoder(track: MediaStreamTrack, maxSeconds: number): Recording {
  const settings = track.getSettings();
  const reader = new MediaStreamTrackProcessor!({ track }).readable.getReader();
  let active = true;
  const timer = setTimeout(() => stop(), maxSeconds * 1000);
  function stop(): void {
    clearTimeout(timer);
    active = false;
  }
  const result = (async (): Promise<FilmedVideo> => {
    const chunks: EncodedVideoChunk[] = [];
    let config: VideoDecoderConfig | null = null;
    let error: Error | null = null;
    let encoder: VideoEncoder | null = null;
    let first: number | null = null;
    let last = 0;
    let n = 0;
    try {
      while (active) {
        const { value: image, done } = await reader.read();
        if (done || !image) break;
        try {
          if (!encoder) {
            const base = { width: image.displayWidth, height: image.displayHeight, bitrate: 30_000_000, framerate: settings.frameRate ?? 30, latencyMode: "quality" as const };
            const candidates: VideoEncoderConfig[] = [
              { ...base, codec: "avc1.640034", avc: { format: "avc" } },
              { ...base, codec: "avc1.4d0034", avc: { format: "avc" } },
              { ...base, codec: "vp8" },
            ];
            let chosen: VideoEncoderConfig | null = null;
            for (const c of candidates) {
              if ((await VideoEncoder.isConfigSupported(c).catch(() => ({ supported: false }))).supported) {
                chosen = c;
                break;
              }
            }
            if (!chosen) throw new Error("No video encoder available in this browser.");
            encoder = new VideoEncoder({
              output: (chunk, meta) => {
                if (meta?.decoderConfig) config = meta.decoderConfig;
                chunks.push(chunk);
              },
              error: (e) => (error = e instanceof Error ? e : new Error(String(e))),
            });
            encoder.configure(chosen);
          }
          if (error) throw error;
          first ??= image.timestamp;
          last = image.timestamp;
          // Overloaded encoder: the image is lost (counted as a skip by the reading).
          if (encoder.encodeQueueSize < 8) encoder.encode(image, { keyFrame: n++ % 60 === 0 });
        } finally {
          image.close();
        }
      }
      if (encoder) await encoder.flush();
      if (error) throw error;
      if (!config || chunks.length === 0) throw new Error("Nothing was filmed.");
      return {
        video: { config, chunks, duration: first === null ? 0 : (last - first) / 1e6 },
        frameRate: settings.frameRate,
        width: settings.width,
        height: settings.height,
        source: "browser",
      };
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      if (encoder && encoder.state !== "closed") encoder.close();
    }
  })();
  return { stop, result };
}

function filmWithMediaRecorder(stream: MediaStream, maxSeconds: number): Recording {  const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  const mimeType = types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 40_000_000 });
  const chunks: Blob[] = [];
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const result = new Promise<FilmedVideo>((ok, fail) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () =>
      ok({
        video: new Blob(chunks, { type: recorder.mimeType || "video/webm" }),
        frameRate: settings?.frameRate,
        width: settings?.width,
        height: settings?.height,
        source: "browser",
      });
    recorder.onerror = () => fail(new Error("Video recording failed."));
  });
  recorder.start(1000);
  const timer = setTimeout(() => stop(), maxSeconds * 1000);
  function stop(): void {
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop();
  }
  return { stop, result };
}
