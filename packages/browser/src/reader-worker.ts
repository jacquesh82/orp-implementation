/**
 * TM decoding off the main thread (TmReader, `worker` option).
 *
 * The main thread only grabs each camera image (createImageBitmap,
 * transferred without copy); the whole pipeline — grid tracking, location,
 * photometry, decision, Reed-Solomon — runs here. Benefit: the page stays
 * smooth and every camera image is taken, even when a 4K mosaic costs more
 * than one camera period to decode.
 *
 * Protocol (messages):
 *   → { type: "init", options }             creates the pipeline
 *   → { type: "image", id, bitmap, t }      an image to decode
 *   → { type: "reset" }                     forgets geometry and pairings
 *   → { type: "resetReceiver" }             forgets the pairings only
 *   ← { type: "result", id, all, width, height, stats }
 *   ← { type: "error", id, message }
 */

import type { TmReceiverOptions, TmImageResult } from "@optirelay/optical";
import { TmPipeline } from "./tm-pipeline.ts";

export type MessageToWorker =
  | { type: "init"; options: TmReceiverOptions }
  | { type: "image"; id: number; bitmap: ImageBitmap; t: number }
  | { type: "reset" }
  | { type: "resetReceiver" };

export type MessageFromWorker =
  | {
      type: "result";
      id: number;
      all: TmImageResult[];
      width: number;
      height: number;
      stats: { valid: number; pairs: number; mixed: number; images: number };
    }
  | { type: "error"; id: number; message: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<MessageToWorker>) => void) | null;
  postMessage(message: MessageFromWorker): void;
}

const scope = globalThis as unknown as WorkerScope;
let pipeline = new TmPipeline();
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;

scope.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "init":
      pipeline = new TmPipeline(m.options);
      return;
    case "reset":
      pipeline.reset();
      return;
    case "resetReceiver":
      pipeline.receiver.reset();
      return;
    case "image": {
      const { bitmap } = m;
      try {
        if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          context = canvas.getContext("2d", { willReadFrequently: true });
        }
        context!.drawImage(bitmap, 0, 0);
        const d = context!.getImageData(0, 0, bitmap.width, bitmap.height);
        const all = pipeline.process({ width: d.width, height: d.height, data: d.data }, m.t);
        scope.postMessage({ type: "result", id: m.id, all, width: d.width, height: d.height, stats: pipeline.stats });
      } catch (e) {
        scope.postMessage({ type: "error", id: m.id, message: (e as Error).message });
      } finally {
        bitmap.close();
      }
      return;
    }
  }
};
