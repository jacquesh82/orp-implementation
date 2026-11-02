/**
 * Screen rendering (BROW-01, rule 7.1-2): projects an ORP grid onto a
 * <canvas> at the requested rate. Canvas 2D for v0.1 — WebGL remains the
 * next step if the benchmarks (QA-02) call for it. No dependency on the host
 * framework: a canvas as input, events in return.
 */

import { Codec } from "@optirelay/core";
import { render, paletteOf, type ImageRGBA, type RenderOptions } from "@optirelay/optical";

export interface ScreenRendererOptions extends RenderOptions {
  /** Target rate in images/s (§9: 5/10/15/30). */
  fps?: number;
}

export class ScreenRenderer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private moduleSize: number;
  private quietZone: number;
  private fps: number;

  constructor(canvas: HTMLCanvasElement, options: ScreenRendererOptions = {}) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("renderer: 2D canvas unavailable");
    this.context = context;
    this.moduleSize = options.moduleSize ?? 8;
    this.quietZone = options.quietZone ?? 2;
    this.fps = options.fps ?? 10;
  }

  /** Displays a frame (complete bytes) in the requested mode — one image, no loop. */
  showFrame(_raw: Uint8Array, codec: Codec, grid: Uint8Array): void {
    this.showImage(render(grid, paletteOf(codec), { moduleSize: this.moduleSize, quietZone: this.quietZone }));
  }

  /** Projects an RGBA image onto the canvas (direct copy of the bytes). */
  showImage(image: ImageRGBA): void {
    if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    this.context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }

  get frameRate(): number {
    return this.fps;
  }
}

/**
 * Sending loop: calls `produce` at the target rate through
 * requestAnimationFrame, until stopped. The acceptance harness replaces
 * requestAnimationFrame with a synchronous scheduler.
 */
export function sendLoop(produce: () => void, fps: number, schedule: (cb: () => void, ms: number) => void = (cb, ms) => setTimeout(cb, ms) as unknown as void): () => void {
  let stopped = false;
  const period = Math.max(1, Math.round(1000 / fps));
  const tick = () => {
    if (stopped) return;
    produce();
    schedule(tick, period);
  };
  tick();
  return () => {
    stopped = true;
  };
}
