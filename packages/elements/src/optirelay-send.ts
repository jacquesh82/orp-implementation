/**
 * <optirelay-send> — sending surface (F-19, §8.3): Shadow DOM, customization
 * slots, documented DOM events. NO camera, NO sending before an explicit
 * user action; dispose releases everything (ELEM-02/03).
 *
 * Attributes: `codec` (COLOR_8 | COLOR_4 | MONO_2, default COLOR_8).
 * Slots: `label` (button label), `help` (help text).
 * Parts: `button`, `sas`, `state`, `matrix`.
 * Events: `orp:state` {state}, `orp:sas` {sas}, `orp:progress` {framesSent},
 * `orp:error` {message}, `orp:end` {reason}.
 */

import { CODEC, Codec, CryptoWebCrypto, SenderSession, type SessionState } from "@optirelay/core";
import { detectCapabilities, recommendCodecs } from "@optirelay/browser";

export class OptirelaySend extends HTMLElement {
  static readonly observation = ["codec"];

  private session: SenderSession | undefined = undefined;
  private stopLoop: (() => void) | undefined = undefined;
  private root = this.attachShadow({ mode: "open" });

  connectedCallback(): void {
    if (this.root.childElementCount > 0) return;
    this.root.innerHTML = `
      <style>
        :host { display: block; font: 14px/1.5 system-ui, sans-serif; }
        button { padding: 0.6rem 1.2rem; border-radius: 8px; border: 1px solid #444;
                 background: #1e88e5; color: white; cursor: pointer; }
        button:disabled { opacity: 0.5; cursor: default; }
        canvas { display: block; margin-top: 0.8rem; max-width: 100%; image-rendering: pixelated; }
        .sas { margin-top: 0.5rem; letter-spacing: 0.3em; font-weight: 700; }
        .state { color: #555; }
      </style>
      <button part="button"><slot name="label">Send</slot></button>
      <p class="sas" part="sas" hidden></p>
      <p class="state" part="state" aria-live="polite"></p>
      <canvas part="matrix"></canvas>
      <slot name="help"></slot>
    `;
    this.root.querySelector("button")!.addEventListener("click", () => void this.start());
  }

  disconnectedCallback(): void {
    this.dispose();
  }

  attributeChangedCallback(): void {
    // The codec only changes before prepare — active sessions do not move.
  }

  private get requestedCodec(): Codec {
    switch (this.getAttribute("codec")) {
      case "COLOR_4":
        return CODEC.COLOR_4;
      case "MONO_2":
        return CODEC.MONO_2;
      default:
        return CODEC.COLOR_8;
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(`orp:${type}`, { detail, bubbles: true, composed: true }));
  }

  private async start(): Promise<void> {
    const file = (this.querySelector('input[type="file"]') as HTMLInputElement | null)?.files?.[0];
    if (!file) {
      this.emit("error", { message: "No file provided: place an <input type=file> inside <optirelay-send>." });
      return;
    }
    const capabilities = detectCapabilities();
    const advice = recommendCodecs(capabilities);
    if (advice.messages.length > 0) this.emit("error", { message: advice.messages.join(" ") });

    const data = new Uint8Array(await file.arrayBuffer());
    const session = new SenderSession(new CryptoWebCrypto(), {
      codecs: [this.requestedCodec, CODEC.COLOR_4, CODEC.MONO_2],
    });
    this.session = session;
    session.events.on("progress", ({ sentFrames }) => this.emit("progress", { framesSent: sentFrames }));
    session.events.on("end", ({ reason }) => this.emit("end", { reason }));

    const reportState = (e: SessionState) => this.emit("state", { state: e });
    try {
      await session.prepare(data);
      reportState(session.state);
      // Init code: displayed in COLOR_4 (§7 of the protocol).
      const { encodePairingCode, render } = await import("@optirelay/optical");
      const image = render(encodePairingCode(session.initCode()), (await import("@optirelay/optical")).paletteOf(CODEC.COLOR_4), { moduleSize: 8 });
      const canvas = this.root.querySelector("canvas")!;
      canvas.width = image.width;
      canvas.height = image.height;
      (canvas.getContext("2d")!).putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    } catch (e) {
      this.emit("error", { message: (e as Error).message });
      return;
    }
    // The rest (response code, SAS, transmission) is driven by the host through
    // the public methods — the component does not decide for the user (§8.1:
    // explicit lifecycle).
  }

  /** Delivers the response code scanned by the host camera and shows the SAS. */
  async respond(responseCode: Uint8Array): Promise<string> {
    const session = this.session;
    if (!session) throw new Error("optirelay-send: no session prepared");
    await session.receiveResponseCode(responseCode);
    const sas = session.sas();
    const zone = this.root.querySelector(".sas") as HTMLElement;
    zone.hidden = false;
    zone.textContent = `SAS ${sas.slice(0, 3)} ${sas.slice(3)}`;
    this.emit("sas", { sas });
    return sas;
  }

  /** After the SAS confirmation: starts the optical transmission. */
  async transmit(onFrame: (t: Uint8Array) => void): Promise<void> {
    const session = this.session;
    if (!session) throw new Error("optirelay-send: no session prepared");
    session.confirmSas();
    const { encodeRawFrame, render, paletteOf } = await import("@optirelay/optical");
    const canvas = this.root.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    await session.start((frame) => {
      const image = render(encodeRawFrame(frame, session.codec), paletteOf(session.codec), { moduleSize: 8 });
      canvas.width = image.width;
      canvas.height = image.height;
      context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
      onFrame(frame);
    });
  }

  /** Stops the sending and releases everything (§8.1 dispose). */
  dispose(): void {
    this.stopLoop?.();
    this.stopLoop = undefined;
    this.session?.dispose();
    this.session = undefined;
  }
}

customElements?.define?.("optirelay-send", OptirelaySend);

declare global {
  interface HTMLElementTagNameMap {
    "optirelay-send": OptirelaySend;
  }
}
