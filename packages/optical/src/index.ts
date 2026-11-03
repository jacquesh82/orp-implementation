/**
 * @optirelay/optical — ORP optical codecs: differential temporal
 * representations TM4/TM8 (bench), static codecs MONO_2/COLOR_4/COLOR_8
 * (SDK v0.1), grid, CIELAB calibration, encoder, renderer and decoder. No DOM.
 */

export {
  NOMINAL_PALETTES,
  paletteOf,
  bitsPerModule,
  BLACK,
  WHITE,
} from "./palettes.ts";
export type { RgbColor } from "./palettes.ts";
export { rgbToLab, labDistance, classify } from "./cielab.ts";
export type { Lab, Classification } from "./cielab.ts";
export {
  GRID_SIZE,
  FINDER_SIZE,
  FINDERS,
  DATA_MODULES,
  DATA_MODULE_COUNT,
  availableBits,
  structuralGrid,
  roleOf,
} from "./grid.ts";
export type { ModuleRole } from "./grid.ts";
export {
  encodeFrame,
  encodeRawFrame,
  encodeTestPattern,
  encodePairingCode,
  frameForCodec,
  writeBytesToGrid,
} from "./encoder.ts";
export type { Grid } from "./encoder.ts";
export { render, renderMosaic } from "./render.ts";
export type { ImageRGBA, RenderOptions } from "./render.ts";
export {
  decodeGrid,
  decodeWithAffine,
  detectFinders,
  chooseTriplet,
  chooseTriplets,
  affineFromTriplet,
  applyAffine,
  luminance,
  otsuThreshold,
  sample,
} from "./decoder.ts";
export type {
  Affine,
  DecodeOptions,
  CalibratedPalette,
  DecodeResult,
} from "./decoder.ts";
export { calibrate, validateMode } from "./calibration.ts";
export {
  TM_AMPLITUDE,
  TM_PALETTE,
  TM_ALIGNMENT,
  TM_DATA_MODULES,
  TM_UNCERTAIN_THRESHOLD,
  inTmAlignment,
  tmBits,
  tmName,
  tmCapacity,
  directionIndex,
  referenceSubframe,
  payloadSubframe,
  renderTmPair,
  tmTestPattern,
  locateTm,
  analyzeSubframe,
  averageSubframes,
  subframeDifference,
  measureTmPair,
  decideTm,
  decodeTm,
} from "./temporal.ts";
export type { TmSubframe, TmPhotometry, TmMeasurement, TmDecision, TmResult } from "./temporal.ts";
export { locate, locateAll, trackLocation, GridTracker, applyH, homographyFrom4, homographyFromAffine } from "./location.ts";
export type { Homography, Location } from "./location.ts";
export { simulateCapture, degradeImage } from "./simulation.ts";
export type { SimulationOptions } from "./simulation.ts";
export { RetainedGeometry, TmReceiver, TmMosaicReceiver, framingAdvice } from "./tm-receiver.ts";
export type { TmReceivedFrame, TmImageResult, TmReceiverStats, TmReceiverOptions } from "./tm-receiver.ts";
