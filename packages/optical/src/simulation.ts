/**
 * Camera capture simulation — an acceptance-test instrument (§10.1): it
 * applies the degradations of the test plan to a rendered image (rotation,
 * scale, translation, tint of the screen/camera pair, blur, Gaussian noise).
 * This is NOT a validation on real hardware (J1, REC-04): it is the
 * deterministic base that makes it possible to test the pipeline beforehand.
 */

import { mulberry32 } from "@optirelay/core";
import { RgbColor } from "./palettes.ts";
import { Grid } from "./encoder.ts";
import { ImageRGBA, render } from "./render.ts";

export interface SimulationOptions {
  /** Global scale factor (default 1). */
  scale?: number;
  /** Rotation in degrees (default 0). */
  rotationDegrees?: number;
  /** Translation in pixels (default [0, 0]). */
  translation?: readonly [number, number];
  /** Per-channel gains — the tint of the screen/camera pair (default [1, 1, 1]). */
  gains?: readonly [number, number, number];
  /** Box blur radius (default 0). */
  blur?: number;
  /** Standard deviation of the per-channel Gaussian noise (default 0). */
  noise?: number;
  /** Noise seed — determinism of the acceptance tests. */
  seed?: number;
  /** Pixels per module of the source rendering (default 8). */
  moduleSize?: number;
  /**
   * Perspective (keystone): projective coefficients [px, py] relative to the
   * half-size of the image — 0.15 ≈ a phone tilted by about fifteen degrees.
   */
  perspective?: readonly [number, number];
  /** 3×3 screen→camera color matrix (crosstalk between channels), applied before the gains. */
  matrix?: readonly (readonly [number, number, number])[];
  /** Additive per-channel haze (ambient light, glare), after the gains. */
  haze?: readonly [number, number, number];
}

/** Renders the grid, then degrades it like a real capture. */
export function simulateCapture(grid: Grid, palette: readonly RgbColor[], options: SimulationOptions = {}): ImageRGBA {
  const moduleSize = options.moduleSize ?? 8;
  return degradeImage(render(grid, palette, { moduleSize, quietZone: 2 }), options);
}

/** Degrades an ALREADY rendered image (a mosaic, for instance) like a real capture. */
export function degradeImage(base: ImageRGBA, options: SimulationOptions = {}): ImageRGBA {
  const scale = options.scale ?? 1;
  const angle = ((options.rotationDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle) / scale;
  const sin = Math.sin(angle) / scale;
  const [tx, ty] = options.translation ?? [0, 0];
  const gains = options.gains ?? [1, 1, 1];
  const [pp, pq] = options.perspective ?? [0, 0];
  const matrix = options.matrix;
  const haze = options.haze ?? [0, 0, 0];

  // Inverse resampling: each output pixel reads the source back.
  const output: ImageRGBA = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data.length) };
  const cx = base.width / 2;
  const cy = base.height / 2;
  for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
      const dx = x - cx - tx;
      const dy = y - cy - ty;
      // inverse of [cos −sin ; sin cos]·scale applied around the center
      let fx = cx + dx * cos + dy * sin;
      let fy = cy - dx * sin + dy * cos;
      if (pp !== 0 || pq !== 0) {
        // Centered homography: w = 1 + p·u + q·v (u, v ∈ [−1, 1]).
        const w = 1 + (pp * (fx - cx)) / cx + (pq * (fy - cy)) / cy;
        fx = cx + (fx - cx) / w;
        fy = cy + (fy - cy) / w;
      }
      const o = (y * output.width + x) * 4;
      if (fx < 0 || fy < 0 || fx >= base.width - 1 || fy >= base.height - 1) {
        output.data[o] = 255;
        output.data[o + 1] = 255;
        output.data[o + 2] = 255;
        output.data[o + 3] = 255;
        continue;
      }
      // Bilinear interpolation: a real sensor sees continuous edges, not
      // aliased pixels.
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const rawValue = [0, 0, 0];
      for (let channel = 0; channel < 3; channel++) {
        const p00 = base.data[(y0 * base.width + x0) * 4 + channel]!;
        const p10 = base.data[(y0 * base.width + x0 + 1) * 4 + channel]!;
        const p01 = base.data[((y0 + 1) * base.width + x0) * 4 + channel]!;
        const p11 = base.data[((y0 + 1) * base.width + x0 + 1) * 4 + channel]!;
        const top = p00 + ax * (p10 - p00);
        const bottom = p01 + ax * (p11 - p01);
        rawValue[channel] = top + ay * (bottom - top);
      }
      for (let channel = 0; channel < 3; channel++) {
        const shuffle = matrix
          ? matrix[channel]![0]! * rawValue[0]! + matrix[channel]![1]! * rawValue[1]! + matrix[channel]![2]! * rawValue[2]!
          : rawValue[channel]!;
        output.data[o + channel] = shuffle * gains[channel]! + haze[channel]!;
      }
      output.data[o + 3] = 255;
    }
  }

  let image = output;
  if (options.blur && options.blur > 0) image = blurImage(image, options.blur);
  if (options.noise && options.noise > 0) image = gaussianNoise(image, options.noise, options.seed ?? 42);
  return image;
}

function blurImage(image: ImageRGBA, radius: number): ImageRGBA {
  const { width, height } = image;
  const output = new Uint8ClampedArray(image.data.length);
  for (const channel of [0, 1, 2]) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            sum += image.data[(sy * width + sx) * 4 + channel]!;
            n++;
          }
        }
        output[(y * width + x) * 4 + channel] = sum / n;
      }
    }
  }
  for (let i = 0; i < width * height; i++) output[i * 4 + 3] = 255;
  return { width, height, data: output };
}

function gaussianNoise(image: ImageRGBA, sigma: number, seed: number): ImageRGBA {
  const rng = mulberry32(seed);
  const next = (): number => {
    // Box-Muller from two uniforms.
    const u = Math.max(1e-9, rng());
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    data[i] = image.data[i]! + next() * sigma;
    data[i + 1] = image.data[i + 1]! + next() * sigma;
    data[i + 2] = image.data[i + 2]! + next() * sigma;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
