/**
 * Framing overlay on the video: grid outline (homography), finders and
 * alignment pattern — green if the framing is good, amber otherwise. The
 * color follows a SMOOTHED advice (FramingSmoother, one per overlay): an R↔P
 * transition image or an isolated advice no longer makes it blink. The
 * video is displayed with `object-fit: contain`: the actually painted area is
 * recomputed so that the outline lands on the image.
 */

import { FramingSmoother } from "@optirelay/browser";
import { applyH, type ImageRGBA, type TmImageResult } from "@optirelay/optical";

const smoothers = new WeakMap<HTMLCanvasElement, FramingSmoother>();

/** Draws the overlay and returns the SMOOTHED advice to display ("" : good framing). */
export function drawOverlay(
  overlay: HTMLCanvasElement,
  video: HTMLVideoElement,
  r: TmImageResult | null,
  image: ImageRGBA | null,
  all: readonly TmImageResult[] = [],
): string {
  let smoother = smoothers.get(overlay);
  if (!smoother) smoothers.set(overlay, (smoother = new FramingSmoother()));
  const advice = smoother.track(r && r.location && r.subframe?.type === "mixed" ? null : (r?.advice ?? ""));
  const ratio = window.devicePixelRatio || 1;
  const l = overlay.clientWidth;
  const h = overlay.clientHeight;
  if (overlay.width !== Math.round(l * ratio) || overlay.height !== Math.round(h * ratio)) {
    overlay.width = Math.round(l * ratio);
    overlay.height = Math.round(h * ratio);
  }
  const c = overlay.getContext("2d")!;
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.clearRect(0, 0, l, h);
  const loc = r?.location;
  if (!loc || !image || !video.videoWidth) return advice;

  // Area painted by object-fit: contain.
  const videoScale = Math.min(l / video.videoWidth, h / video.videoHeight);
  const ox = (l - video.videoWidth * videoScale) / 2;
  const oy = (h - video.videoHeight * videoScale) / 2;
  const k = videoScale * (video.videoWidth / image.width);
  const to = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];

  const color = advice === "" ? "#22c55e" : "#f59e0b";
  c.lineWidth = 3;
  c.strokeStyle = color;
  c.beginPath();
  for (const [x, y] of [[0, 0], [41, 0], [41, 41], [0, 41]] as const) c.lineTo(...to(...applyH(loc.h, x, y)));
  c.closePath();
  c.stroke();
  c.fillStyle = color;
  for (const [x, y] of loc.finders) {
    c.beginPath();
    c.arc(...to(x, y), 6, 0, 2 * Math.PI);
    c.fill();
  }
  if (loc.alignment) {
    c.fillStyle = "#06b6d4";
    c.beginPath();
    c.arc(...to(loc.alignment[0], loc.alignment[1]), 5, 0, 2 * Math.PI);
    c.fill();
  }
  // Mosaic: one outline per tracked grid, in the color of the overall framing.
  c.strokeStyle = color;
  for (const other of all) {
    if (other === r || !other.location) continue;
    c.beginPath();
    for (const [x, y] of [[0, 0], [41, 0], [41, 41], [0, 41]] as const) c.lineTo(...to(...applyH(other.location.h, x, y)));
    c.closePath();
    c.stroke();
  }
  return advice;
}
