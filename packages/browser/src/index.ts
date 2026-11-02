/**
 * @optirelay/browser — browser adapters of the ORP SDK: camera, screen
 * rendering, permissions, capabilities. Built ONLY on @optirelay/core and
 * @optirelay/optical (D-009: no duplicated engine).
 */

export {
  openCamera,
  closeCamera,
  CameraError,
  listCameras,
  sensorCapabilities,
  applyCameraConstraints,
  lockSensor,
  unlockSensor,
  capturePhoto,
} from "./camera.ts";
export type { CameraOptions, SensorCapabilities, LockState } from "./camera.ts";
export type { ImageRGBA, RenderOptions } from "@optirelay/optical";
export { detectCapabilities, recommendCodecs } from "./capabilities.ts";
export type { Capabilities, CapabilityAdvice } from "./capabilities.ts";
export { ScreenRenderer, sendLoop } from "./canvas-renderer.ts";
export type { ScreenRendererOptions } from "./canvas-renderer.ts";
export { CameraDecoder } from "./camera-decoder.ts";
export { TmDisplay, TmPipeline, TmReader, autoModuleSize, moduleDiagnostic, CRITICAL_MODULE, COMFORT_MODULE, CRITICAL_MODULE_CSS, COMFORT_MODULE_CSS, measureRefreshRate, pairingFrame, pairingPayload, isPairingFrame, frameCodec, BENCH_PASSPHRASE, readSendState, clock } from "./tm.ts";
export type { SendState } from "./tm.ts";
export type { TmDisplayOptions, TmReaderOptions, ModuleDiagnostic } from "./tm.ts";
export { AdaptiveWidth, BASE_WIDTH, MAX_WIDTH, FINE_MODULES } from "./adaptive-width.ts";
export {
  pack,
  unpack,
  readableSize,
  readableThroughput,
  readableDuration,
  saveFile,
  TransferTracker,
  SendThroughput,
  FilmingGauge,
  suggestedSymbols,
} from "./file.ts";
export type { TransferredFile, TransferStatus, SaveResult } from "./file.ts";
export {
  CALIBRATION_TRIALS,
  CALIBRATION_SERIES_DURATION,
  CALIBRATION_PREAMBLE,
  FRAME_PAYLOAD_SIZE,
  calibrationFrame,
  readCalibration,
  CalibrationMeasurement,
  calibrationCode,
  readCalibrationCode,
  loadCalibration,
  saveCalibration,
  CALIBRATION_KEY,
  sendCalibrationSeries,
  SUBFRAME_PERIODS,
  MAX_COLUMNS,
} from "./calibration.ts";
export type { CalibrationTrial, TrialResult, SeriesOptions, StoredCalibration } from "./calibration.ts";
export { FramingSmoother } from "./framing.ts";
export { filmStream, filmSlowMotion, releaseCamera, readTmVideo, nativeSlowMotionAvailable } from "./video.ts";
export type { VideoReadOptions, VideoProgress, Recording, EncodedVideo, FilmedVideo } from "./video.ts";
export { readMp4Track } from "./mp4.ts";
export type { VideoTrack } from "./mp4.ts";
export { createPreview, textOf } from "./preview.ts";
export type { Preview } from "./preview.ts";

export {
  SenderSession,
  ReceiverSession,
  CryptoWebCrypto,
  CODEC,
} from "@optirelay/core";
export type { Codec, SessionState, TransmissionOptions, ReceiveProgress, FrameStatus } from "@optirelay/core";
