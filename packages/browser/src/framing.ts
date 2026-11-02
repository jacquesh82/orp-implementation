/**
 * SMOOTHED framing indicator: the displayed advice (and the frame color) only
 * changes once a new advice has repeated over several images. A transition
 * image (mixed subframe) says nothing about the framing: it leaves the state
 * as is. Without this smoothing, the frame blinks green/orange while the
 * phone does not move — and the user, believing they aim badly, moves.
 */
export class FramingSmoother {
  private shown: string | null = null;
  private candidate: string | null = null;
  private repetitions = 0;

  /** Agreeing images needed to turn green, and to leave green. */
  constructor(
    private readonly toGood = 2,
    private readonly toBad = 4,
  ) {}

  /**
   * `advice`: "" if the image is well framed, the advice otherwise; `null`
   * for an image that does not count (R↔P transition). Returns the advice to
   * display.
   */
  track(advice: string | null): string {
    if (advice === null) return this.shown ?? "";
    if (this.shown === null || advice === this.shown) {
      this.shown = advice;
      this.candidate = null;
      this.repetitions = 0;
      return advice;
    }
    if (advice === this.candidate) this.repetitions++;
    else {
      this.candidate = advice;
      this.repetitions = 1;
    }
    if (this.repetitions >= (advice === "" ? this.toGood : this.toBad)) {
      this.shown = advice;
      this.candidate = null;
      this.repetitions = 0;
    }
    return this.shown;
  }

  reset(): void {
    this.shown = null;
    this.candidate = null;
    this.repetitions = 0;
  }
}
