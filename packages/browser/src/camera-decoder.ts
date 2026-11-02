/**
 * Camera decoder (BROW-02/03): captures a video frame, converts it into an
 * ImageRGBA, hands it to the optical decoder (Workers/WASM off the main
 * thread in v0.2 — here the conversion runs on the thread, the optical
 * decoding is pure and lends itself to a Worker).
 */

import { Codec } from "@optirelay/core";
import { decodeGrid, type DecodeOptions, type DecodeResult } from "@optirelay/optical";
import { closeCamera, openCamera } from "./camera.ts";

export class CameraDecoder {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private stream: MediaStream | undefined = undefined;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  /** Opens the camera (after an explicit user action, §8.3). */
  async start(options?: Parameters<typeof openCamera>[0]): Promise<void> {
    this.stream = await openCamera(options);
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /** Captures a frame and decodes it in the requested mode. */
  captureAndDecode(codec: Codec, options: DecodeOptions = {}): DecodeResult | null {
    if (!this.video.videoWidth) return null;
    if (this.canvas.width !== this.video.videoWidth || this.canvas.height !== this.video.videoHeight) {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
    }
    this.context.drawImage(this.video, 0, 0);
    const data = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    try {
      return decodeGrid({ width: data.width, height: data.height, data: data.data }, codec, options);
    } catch {
      return null; // no finder visible in this frame — normal, try again
    }
  }

  /** Releases the camera and resources (ELEM-03, §8.1). */
  dispose(): void {
    if (this.stream) closeCamera(this.stream);
    this.stream = undefined;
    this.video.srcObject = null;
  }
}
