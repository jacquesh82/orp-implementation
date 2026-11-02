/**
 * Preview of a received file, IN PLACE: image, text or first bytes depending
 * on the type. Nothing is opened in another application nor imported — the
 * user decides afterwards whether to save (F-20).
 */

import type { TransferredFile } from "./file.ts";

/** The text of the file if it is one (valid UTF-8, no null byte), otherwise null. */
export function textOf(f: TransferredFile): string | null {
  const type = f.type.toLowerCase();
  const likelyText =
    type.startsWith("text/") ||
    /json|xml|csv|javascript|yaml|markdown/.test(type) ||
    /\.(txt|md|csv|json|xml|log|ini|conf)$/i.test(f.name);
  if (!likelyText && f.data.subarray(0, 4096).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(f.data);
  } catch {
    return null;
  }
}

function hexDump(bytes: Uint8Array, count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(count, bytes.length); i += 16) {
    const chunk = [...bytes.subarray(i, Math.min(i + 16, bytes.length))].map((o) => o.toString(16).padStart(2, "0"));
    lines.push(`${i.toString(16).padStart(8, "0")}  ${chunk.slice(0, 8).join(" ")}  ${chunk.slice(8).join(" ")}`);
  }
  return lines.join("\n") + (bytes.length > count ? "\n…" : "");
}

export interface Preview {
  element: HTMLElement;
  /** True for an image or a text: enlarging makes sense. */
  enlargeable: boolean;
  /** The text, if there is one ("Copy" button). */
  text: string | null;
  /** Releases the blob URL of an image. */
  release(): void;
}

/** Builds the preview (`enlarged`: more text / bytes, for a dialog). */
export function createPreview(f: TransferredFile, enlarged = false): Preview {
  if (f.type.startsWith("image/")) {
    const url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: f.type }));
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Preview of ${f.name}`;
    return { element: img, enlargeable: true, text: null, release: () => URL.revokeObjectURL(url) };
  }
  const text = textOf(f);
  if (text !== null) {
    const pre = document.createElement("pre");
    const limit = enlarged ? 200_000 : 6000;
    pre.textContent = text.length > limit ? `${text.slice(0, limit)}\n…` : text;
    return { element: pre, enlargeable: true, text, release: () => undefined };
  }
  const block = document.createElement("div");
  block.className = "binary";
  const p = document.createElement("p");
  p.textContent = "No preview for this file type. First bytes:";
  const pre = document.createElement("pre");
  pre.textContent = hexDump(f.data, enlarged ? 1024 : 64);
  block.append(p, pre);
  return { element: block, enlargeable: false, text: null, release: () => undefined };
}
