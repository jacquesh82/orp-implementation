/**
 * Camera pipeline (F-12, rule 7.1-2): getUserMedia under control, typed
 * errors and guided messages, clean stop of the tracks. No capture before an
 * explicit user action (§8.3).
 */

/** DOM-independent RGBA image — same contract as @optirelay/optical. */
export interface ImageRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export class CameraError extends Error {
  readonly code: "permission-denied" | "camera-unavailable" | "insecure-context" | "failed";
  readonly advice: string;

  constructor(code: CameraError["code"], message: string, advice: string) {
    super(message);
    this.name = "ErreurCamera";
    this.code = code;
    this.advice = advice;
  }
}

export interface CameraOptions {
  /** Rear camera if available (smartphone reception). */
  rearFacing?: boolean;
  /** Specific sensor (chosen among listCameras — S25: main, ultra wide, telephotos). */
  deviceId?: string;
}

/** Opens the camera and returns the stream; the caller keeps control of its lifecycle. */
export async function openCamera(options: CameraOptions = {}): Promise<MediaStream> {
  if (typeof globalThis.navigator === "undefined" || !globalThis.navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(
      "camera-unavailable",
      "This browser does not expose getUserMedia.",
      "Use a recent browser (Chromium, Firefox, Safari) or check the compatibility matrix.",
    );
  }
  if (globalThis.isSecureContext === false) {
    throw new CameraError(
      "insecure-context",
      "The camera requires a secure context.",
      "Serve the app over HTTPS (or localhost for development).",
    );
  }
  try {
    return await globalThis.navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: options.rearFacing ? "environment" : "user",
        // 4K if the device allows it: the 4:2:0 chroma of the video stream is
        // twice as dense relative to the modules — this is THE margin factor
        // for the color codecs (seen on the REC-05 bench).
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        // 60 fps if the sensor allows it: 17 ms subframes become readable live
        // (at 30 fps, one subframe out of two is missed).
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
  } catch (e) {
    const error = e as DOMException;
    if (error.name === "NotAllowedError") {
      throw new CameraError(
        "permission-denied",
        "Camera access was denied.",
        "Allow the camera for this site again in the browser settings, then retry.",
      );
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      throw new CameraError(
        "camera-unavailable",
        "No compatible camera was found.",
        "Connect or allow a camera, then retry.",
      );
    }
    throw new CameraError("failed", `Camera failure: ${error.name ?? "unknown"}`, "Retry; if the failure persists, check the diagnostic log.");
  }
}

/** Cleanly stops every track of a stream. */
export function closeCamera(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}


// ── Multiple sensors, high-resolution photo and locks (REC-05) ────────────

/** The available cameras (video devices), labels included after permission. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return [];
  const all = await globalThis.navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

export interface SensorCapabilities {
  zoom?: { min: number; max: number; step?: number };
  exposureCompensation?: { min: number; max: number; step?: number };
  focusDistance?: { min: number; max: number };
  whiteBalanceModes?: string[];
  torch?: boolean;
}

/** What the ACTIVE sensor can do (zoom, exposure, white balance…). */
export function sensorCapabilities(stream: MediaStream): SensorCapabilities {
  const track = stream.getVideoTracks()[0];
  if (!track) return {};
  const rawCaps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const cap: SensorCapabilities = {};
  const zoom = rawCaps.zoom as { min?: number; max?: number; step?: number } | undefined;
  if (zoom?.max !== undefined) cap.zoom = { min: zoom.min ?? 1, max: zoom.max!, ...(zoom.step !== undefined ? { step: zoom.step } : {}) };
  const expo = rawCaps.exposureCompensation as { min?: number; max?: number; step?: number } | undefined;
  if (expo?.max !== undefined) cap.exposureCompensation = { min: expo.min ?? 0, max: expo.max!, ...(expo.step !== undefined ? { step: expo.step } : {}) };
  const focus = rawCaps.focusDistance as { min?: number; max?: number } | undefined;
  if (focus?.max !== undefined) cap.focusDistance = { min: focus.min ?? 0, max: focus.max! };
  const wb = rawCaps.whiteBalanceMode as string[] | undefined;
  if (Array.isArray(wb)) cap.whiteBalanceModes = wb;
  if (rawCaps.torch === true) cap.torch = true;
  return cap;
}

/** Applies locks/constraints — returns what the device accepted. */
export async function applyCameraConstraints(
  stream: MediaStream,
  { zoom, exposureCompensation, lockWhiteBalance }: { zoom?: number; exposureCompensation?: number; lockWhiteBalance?: boolean },
): Promise<string[]> {
  const track = stream.getVideoTracks()[0];
  if (!track) return [];
  const advanced: Record<string, unknown>[] = [];
  const notes: string[] = [];
  if (zoom !== undefined) {
    advanced.push({ zoom });
    notes.push(`zoom=${zoom}`);
  }
  if (exposureCompensation !== undefined) {
    advanced.push({ exposureCompensation });
    notes.push(`expoComp=${exposureCompensation}`);
  }
  if (lockWhiteBalance !== undefined) {
    advanced.push({ whiteBalanceMode: lockWhiteBalance ? "manual" : "continuous" });
    notes.push(lockWhiteBalance ? "white balance: lock requested (unverified — see verrouillerCapteur)" : "continuous white balance");
  }
  try {
    await track.applyConstraints({ advanced } as MediaTrackConstraints);
  } catch (e) {
    notes.push(`refused: ${(e as Error).message.slice(0, 60)}`);
  }
  return notes;
}

export interface LockState {
  /** White balance is actually locked (read back from getSettings). */
  whiteBalance: boolean;
  /** Exposure is actually locked. */
  exposure: boolean;
  /** Focus is actually locked. */
  focus: boolean;
  notes: string[];
}

type TrackSettings = MediaTrackSettings & Record<string, unknown>;

/**
 * Locks white balance, exposure and focus AT THEIR CURRENT VALUES — to call
 * when the grid is in view, not blindly (a lock applied with the camera
 * facing the room keeps the temperature of the room, not that of the screen).
 *
 * Each lock is applied SEPARATELY and READ BACK from getSettings(): an
 * applyConstraints({advanced}) silently ignores what it cannot do, so the
 * former "LOCKED" report could lie. Order of the attempts: "manual" with the
 * current value (temperature, exposure time, distance), then "single-shot"
 * (adjusts once then locks), then bare "manual" for the white balance only
 * (Chromium Android: AWB lock).
 */
export async function lockSensor(
  stream: MediaStream,
  what: { whiteBalance?: boolean; exposure?: boolean; focus?: boolean } = { whiteBalance: true, exposure: true },
): Promise<LockState> {
  const state: LockState = { whiteBalance: false, exposure: false, focus: false, notes: [] };
  const track = stream.getVideoTracks()[0];
  if (!track?.applyConstraints) return { ...state, notes: ["no controllable video track"] };
  const cap = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const before = (track.getSettings?.() ?? {}) as TrackSettings;

  const tryApply = async (key: string, trials: Record<string, unknown>[]): Promise<boolean> => {
    for (const trial of trials) {
      try {
        await track.applyConstraints({ advanced: [trial] } as MediaTrackConstraints);
        const readBack = (track.getSettings?.() ?? {}) as TrackSettings;
        if (readBack[key] === trial[key]) return true;
      } catch {
        // next attempt
      }
    }
    return false;
  };
  const modes = (key: string) => (Array.isArray(cap[key]) ? (cap[key] as string[]) : []);

  if (what.whiteBalance) {
    const m = modes("whiteBalanceMode");
    const trials: Record<string, unknown>[] = [];
    if (m.includes("manual") && cap.colorTemperature && typeof before.colorTemperature === "number") {
      trials.push({ whiteBalanceMode: "manual", colorTemperature: before.colorTemperature });
    }
    if (m.includes("single-shot")) trials.push({ whiteBalanceMode: "single-shot" });
    if (m.includes("manual")) trials.push({ whiteBalanceMode: "manual" });
    state.whiteBalance = trials.length > 0 && (await tryApply("whiteBalanceMode", trials));
    const t = (track.getSettings?.() as TrackSettings | undefined)?.colorTemperature;
    state.notes.push(
      trials.length === 0
        ? "white balance: not controllable on this device"
        : state.whiteBalance
          ? `white balance LOCKED${typeof t === "number" ? ` (${t} K)` : ""}`
          : "white balance: lock REFUSED by the device",
    );
  }
  if (what.exposure) {
    const m = modes("exposureMode");
    const trials: Record<string, unknown>[] = [];
    if (m.includes("manual") && cap.exposureTime && typeof before.exposureTime === "number") {
      trials.push({ exposureMode: "manual", exposureTime: before.exposureTime });
    }
    if (m.includes("single-shot")) trials.push({ exposureMode: "single-shot" });
    state.exposure = trials.length > 0 && (await tryApply("exposureMode", trials));
    state.notes.push(
      trials.length === 0 ? "exposure: not controllable" : state.exposure ? "exposure LOCKED" : "exposure: lock REFUSED",
    );
  }
  if (what.focus) {
    const m = modes("focusMode");
    const trials: Record<string, unknown>[] = [];
    if (m.includes("manual") && cap.focusDistance && typeof before.focusDistance === "number") {
      trials.push({ focusMode: "manual", focusDistance: before.focusDistance });
    }
    if (m.includes("single-shot")) trials.push({ focusMode: "single-shot" });
    state.focus = trials.length > 0 && (await tryApply("focusMode", trials));
    state.notes.push(
      trials.length === 0 ? "focus: not controllable" : state.focus ? "focus LOCKED" : "focus: lock REFUSED",
    );
  }
  return state;
}

/** Gives the automatic mode back to the sensor (continuous white balance, exposure, focus). */
export async function unlockSensor(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  const cap = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  for (const key of ["whiteBalanceMode", "exposureMode", "focusMode"]) {
    if (!Array.isArray(cap[key]) || !(cap[key] as string[]).includes("continuous")) continue;
    try {
      await track.applyConstraints({ advanced: [{ [key]: "continuous" }] } as MediaTrackConstraints);
    } catch {
      // the device keeps its current state
    }
  }
}

/**
 * HIGH-RESOLUTION photo through ImageCapture.takePhoto — the video stream is
 * capped at 4K in 4:2:0, the photo of the main sensor goes well beyond: the
 * chromatic density per module is several times that of the video. This is
 * the lever of the color codecs (REC-05 finding: the 4:2:0 chroma halves the
 * margins). Fallback: grabFrame (full resolution of the stream), then the
 * video frame.
 */
export async function capturePhoto(stream: MediaStream): Promise<ImageRGBA> {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new CameraError("camera-unavailable", "no video track", "Open the camera first.");
  const ImageCaptureCtor = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob>; grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
  let source: Blob | ImageBitmap;
  if (ImageCaptureCtor) {
    const ic = new ImageCaptureCtor(track);
    try {
      source = await ic.takePhoto();
    } catch {
      source = await ic.grabFrame();
    }
  } else {
    throw new CameraError(
      "camera-unavailable",
      "ImageCapture unavailable in this WebView",
      "Use the video frame (default mode).",
    );
  }
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}
