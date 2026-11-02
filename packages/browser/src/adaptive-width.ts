/**
 * Adaptive decoding width: 1,920 px usually, the full camera width (3,840 px
 * at most) when the captured modules become too fine — 4 × 4 mosaic and
 * beyond.
 *
 * Trap avoided: a dense mosaic may only be FOUND at full width (at 1,920 px
 * its finders are too small). Waiting to have seen a grid before widening
 * would never work: with no grid seen for a while, we PROBE the full width;
 * if nothing shows up there either, we come back.
 */

/** Usual width, and ceiling. */
export const BASE_WIDTH = 1920;
export const MAX_WIDTH = 3840;
/** Below this (decoded pixels per module), full width. */
export const FINE_MODULES = 8;
/** Images without a grid before probing the other width. */
const FRAMES_WITHOUT_GRID = 20;

export class AdaptiveWidth {
  private full = false;
  private probing = false;
  private withoutGrid = 0;

  constructor(private readonly base = BASE_WIDTH, private readonly max = MAX_WIDTH) {}

  /** Decoding width for a video `videoWidth` pixels wide. */
  width(videoWidth: number): number {
    return Math.min(this.full ? this.max : this.base, videoWidth || this.base);
  }

  get atFullWidth(): boolean {
    return this.full;
  }

  /**
   * After each image: the smallest `pxPerModule` of the grids seen (0 if
   * none). Returns true when the width changes — the tracked geometry, in
   * pixels of the old scale, must then be forgotten.
   */
  observe(pxPerModule: number, videoWidth: number): boolean {
    if (videoWidth <= this.base) {
      const changed = this.full;
      this.full = this.probing = false;
      return changed;
    }
    if (pxPerModule > 0) {
      this.withoutGrid = 0;
      this.probing = false;
      if (!this.full && pxPerModule < FINE_MODULES) return this.switchTo(true);
      // Hysteresis: back to the base width when the modules would stay large there.
      if (this.full && pxPerModule > FINE_MODULES * 2 * (this.max / this.base)) return this.switchTo(false);
      return false;
    }
    this.withoutGrid++;
    if (this.withoutGrid < FRAMES_WITHOUT_GRID * (this.full && !this.probing ? 3 : 1)) return false;
    this.withoutGrid = 0;
    // Nothing seen for a while: try the other width.
    this.probing = !this.full;
    return this.switchTo(!this.full);
  }

  reset(): void {
    this.full = this.probing = false;
    this.withoutGrid = 0;
  }

  private switchTo(full: boolean): boolean {
    this.full = full;
    return true;
  }
}
