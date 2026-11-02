/**
 * <optirelay-transfer-dialog> — transfer modal window (§8.3): opens an
 * isolated Shadow DOM dialog, hosts send or receive, closes with its button —
 * no camera nor transmission without a user action.
 *
 * Slots: `title`, default slot (content). Parts: `backdrop`, `box`.
 * Event: `orp:close` when the dialog closes.
 */

import { OptirelaySend } from "./optirelay-send.ts";
import { OptirelayReceive } from "./optirelay-receive.ts";

export class OptirelayTransferDialog extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });

  connectedCallback(): void {
    if (this.root.childElementCount > 0) return;
    this.root.innerHTML = `
      <style>
        :host { display: contents; }
        .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45);
                 display: grid; place-items: center; z-index: 999; }
        .box { background: white; border-radius: 12px; padding: 1.2rem;
                 max-width: min(92vw, 640px); max-height: 90vh; overflow: auto; }
        header { display: flex; justify-content: space-between; align-items: center; }
        button.close { border: none; background: none; font-size: 1.2rem; cursor: pointer; }
      </style>
      <div class="backdrop" part="backdrop">
        <div class="box" part="box" role="dialog" aria-modal="true">
          <header>
            <strong><slot name="title">OptiRelay transfer</slot></strong>
            <button class="close" aria-label="Close">✕</button>
          </header>
          <div class="content"><slot></slot></div>
        </div>
      </div>
    `;
    this.root.querySelector("button.close")!.addEventListener("click", () => this.close());
    this.root.querySelector(".backdrop")!.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.close();
    });
  }

  disconnectedCallback(): void {
    this.dispose();
  }

  close(): void {
    // The child components clean up their camera and their session.
    for (const child of this.querySelectorAll("optirelay-send, optirelay-receive")) {
      (child as OptirelaySend | OptirelayReceive).dispose();
    }
    this.dispatchEvent(new CustomEvent("orp:close", { bubbles: true, composed: true }));
    this.remove();
  }

  dispose(): void {
    // nothing beyond the children — the dialog holds no resource.
  }
}

customElements?.define?.("optirelay-transfer-dialog", OptirelayTransferDialog);

declare global {
  interface HTMLElementTagNameMap {
    "optirelay-transfer-dialog": OptirelayTransferDialog;
  }
}
