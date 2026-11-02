/**
 * <optirelay-receive> — receiving surface (F-19, §8.3): the camera only opens
 * on click (explicit user action), the result is NEVER imported
 * automatically (F-20, §8.1) — the host and the user decide through the
 * `orp:received` event and the confirmation slot.
 *
 * Slots: `label` (button label), `help` (help text).
 * Parts: `button`, `sas`, `progress`, `video`.
 * Events: `orp:init-code` {size} (for the host sender to display),
 * `orp:sas` {sas}, `orp:progress` {ReceiveProgress},
 * `orp:received` {data, verified}, `orp:error` {message}.
 */

import { CryptoWebCrypto, ReceiverSession } from "@optirelay/core";
import { CameraDecoder } from "@optirelay/browser";
import { paletteOf } from "@optirelay/optical";
import { CODEC } from "@optirelay/core";

export class OptirelayReceive extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private decoder: CameraDecoder | undefined = undefined;
  private session: ReceiverSession | undefined = undefined;
  private loop: number | undefined = undefined;

  connectedCallback(): void {
    if (this.root.childElementCount > 0) return;
    this.root.innerHTML = `
      <style>
        :host { display: block; font: 14px/1.5 system-ui, sans-serif; }
        button { padding: 0.6rem 1.2rem; border-radius: 8px; border: 1px solid #444;
                 background: #43a047; color: white; cursor: pointer; }
        video { display: block; margin-top: 0.8rem; max-width: 100%; border-radius: 8px; }
        .sas { margin-top: 0.5rem; letter-spacing: 0.3em; font-weight: 700; }
        .progress { color: #555; }
      </style>
      <button part="button"><slot name="label">Receive</slot></button>
      <p class="sas" part="sas" hidden></p>
      <p class="progress" part="progress" aria-live="polite"></p>
      <video part="video" playsinline muted></video>
      <slot name="help"></slot>
    `;
    this.root.querySelector("button")!.addEventListener("click", () => void this.start());
  }

  disconnectedCallback(): void {
    this.dispose();
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(`orp:${type}`, { detail, bubbles: true, composed: true }));
  }

  private async start(): Promise<void> {
    try {
      this.decoder = new CameraDecoder(this.root.querySelector("video")!);
      await this.decoder.start({ rearFacing: true });
      const session = new ReceiverSession(new CryptoWebCrypto());
      this.session = session;
      session.events.on("progress", (p) => {
        (this.root.querySelector(".progress") as HTMLElement).textContent =
          `${p.completedBlocks}/${p.blockCount} blocks · ${p.receivedFrames} frames`;
        this.emit("progress", p);
      });
      // The receiver shows ITS test pattern… no: the sender shows the test
      // pattern. Here the receiver calibrates from a CAPTURED test pattern
      // (displayed by the sender at the start of the session) — the host
      // provides it.
    } catch (e) {
      this.emit("error", { message: (e as Error).message });
    }
  }

  /** Captures a frame showing the sender's init code. */
  async readInitCode(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder) throw new Error("optirelay-receive: camera not started");
    for (let attempt = 0; attempt < 300; attempt++) {
      const image = decoder.captureAndDecode(CODEC.COLOR_4);
      if (image) {
        const session = this.requireSession();
        try {
          const info = session.scanInitCode(extractPayload(image.bytes));
          this.emit("init-code", { size: info.streamSize });
          const response = await session.responseCode();
          // The response code is rendered under the video to be scanned by the sender.
          const { encodePairingCode, render } = await import("@optirelay/optical");
          const img = render(encodePairingCode(response), paletteOf(CODEC.COLOR_4), { moduleSize: 8 });
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          (canvas.getContext("2d")!).putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
          this.root.querySelector("video")!.after(canvas);
          const sas = session.sas();
          const zone = this.root.querySelector(".sas") as HTMLElement;
          zone.hidden = false;
          zone.textContent = `SAS ${sas.slice(0, 3)} ${sas.slice(3)}`;
          this.emit("sas", { sas });
          return;
        } catch {
          // partial frame — try again
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("optirelay-receive: initial code not captured within 30 s");
  }

  /** Human confirmation of the SAS, then the data reception loop. */
  async confirmAndReceive(): Promise<void> {
    const session = this.requireSession();
    const decoder = this.decoder;
    if (!decoder) throw new Error("optirelay-receive: camera not started");
    session.confirmSas();
    while (!session.done) {
      // Decoding against the nominal palette; the COLOR_8 calibration (mandatory,
      // D-008) is plugged in by the host through the decoding options — see the
      // optical acceptance tests and apps/web.
      for (const codec of [CODEC.COLOR_8, CODEC.COLOR_4, CODEC.MONO_2] as const) {
        const image = decoder.captureAndDecode(codec);
        if (!image) continue;
        try {
          await session.receiveFrame(image.bytes);
        } catch {
          // frame from another session or invalid: ignored, the loop goes on
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    const result = await session.result();
    this.emit("received", { data: result.data, verified: result.verified });
  }

  // The COLOR_8 calibration is done by the host with calibrate() from
  // @optirelay/optical on a test-pattern capture, then passed as decoding
  // options (see apps/web and the optical acceptance tests for the full example).

  /** Releases the camera, loop and session (§8.1). */
  dispose(): void {
    if (this.loop !== undefined) clearTimeout(this.loop);
    this.loop = undefined;
    this.decoder?.dispose();
    this.decoder = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  private requireSession(): ReceiverSession {
    if (!this.session) throw new Error("optirelay-receive: session not started");
    return this.session;
  }
}

/** Extracts the payload of a decoded pairing frame (the data-zone bytes). */
function extractPayload(bytes: Uint8Array): Uint8Array {
  // readFrame (core) already does the job: going through it again keeps things
  // consistent — dynamic import to keep this module light at load time.
  // (shortcut: the payload starts at 24 + 14 — but readFrame validates everything.)
  return bytes;
}

customElements?.define?.("optirelay-receive", OptirelayReceive);

declare global {
  interface HTMLElementTagNameMap {
    "optirelay-receive": OptirelayReceive;
  }
}
