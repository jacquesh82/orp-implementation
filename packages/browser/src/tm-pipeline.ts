/**
 * DOM-free TM reading pipeline: usable on the main thread as well as in a
 * Worker (reader-worker.ts).
 */

import {
  TM_ALIGNMENT,
  framingAdvice,
  TmMosaicReceiver,
  TmReceiver,
  GridTracker,
  type ImageRGBA,
  type TmReceiverOptions,
  type TmImageResult,
} from "@optirelay/optical";

/**
 * The reading pipeline of an image, shared by the camera and the video: grid
 * tracking (GridTracker), then single or mosaic receiver.
 */
export class TmPipeline {
  readonly receiver: TmReceiver;
  readonly mosaic: TmMosaicReceiver;
  readonly tracker = new GridTracker(TM_ALIGNMENT);

  constructor(options: TmReceiverOptions = {}) {
    this.receiver = new TmReceiver(options);
    this.mosaic = new TmMosaicReceiver(options);
  }

  /** Valid frames and pairs, single grid and mosaic combined. */
  get stats(): { valid: number; pairs: number; mixed: number; images: number } {
    const a = this.receiver.stats;
    const b = this.mosaic.stats;
    return { valid: a.validCount + b.validCount, pairs: a.pairs + b.pairs, mixed: a.mixedCount + b.mixedCount, images: a.images + b.images };
  }

  /** Forgets geometry, cells and pairings (camera reopened, new sending). */
  reset(): void {
    this.receiver.reset();
    this.mosaic.reset();
    this.tracker.forget();
  }

  /** One entry per grid read (at least one: the single grid, located or not). */
  process(image: ImageRGBA, t: number): TmImageResult[] {
    const locs = this.tracker.locate(image, t);
    // Mosaic as soon as one has been seen — even if THIS image only shows one
    // grid of it (P subframe): R and P of the same cell must stay in the same
    // receiver, otherwise they never pair.
    if (locs.length >= 2 || this.mosaic.cellCount >= 2) {
      const all = this.mosaic.process(image, locs, t);
      return all.length > 0 ? all : [{ location: null, subframe: null, advice: framingAdvice(null, null) }];
    }
    // One grid (or none found right away): the single receiver, which keeps
    // TRACKING the finders from one image to the next.
    return [locs[0] ? this.receiver.processLocated(image, locs[0], t) : this.receiver.process(image, t)];
  }
}

