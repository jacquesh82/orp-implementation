import { CODEC } from "@optirelay/core";
import { tmTestPattern, TM_PALETTE, render } from "@optirelay/optical";
import "./motion.js";
import { animateConvergence } from "./convergence.ts";

const convergence = document.querySelector<HTMLElement>(".convergence-art");
if (convergence) animateConvergence(convergence);

// Use the protocol implementation for both the illustration and the Web guide.
// Local SVGs provide an initial image before this module has loaded.
for (const [mode, codec] of [["tm4", CODEC.COLOR_4], ["tm8", CODEC.COLOR_8]] as const) {
  const testPattern = tmTestPattern(codec);
  // data-subframe ("reference" / "payload") names the test-pattern subframe.
  for (const subframe of ["reference", "payload"] as const) {
    const targets = document.querySelectorAll(`[data-optical-mode="${mode}"][data-subframe="${subframe}"]`);
    if (!targets.length) continue;
    const image = render(testPattern[subframe], TM_PALETTE, { moduleSize: 6, quietZone: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    const url = canvas.toDataURL("image/png");
    for (const target of targets) {
      target.setAttribute(target instanceof HTMLImageElement ? "src" : "href", url);
    }
  }
}

const apkInfo = document.getElementById("apk-info");
if (apkInfo) {
  // Written by apps/android-lab/rebuild.sh: size in bytes, SHA-256, build date (YYYY-MM-DD).
  void fetch("./download/optirelay.json", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then((metadata: { size?: number; sha256?: string; built?: string } | null) => {
      if (!metadata?.size || !metadata.sha256) return;
      const size = (metadata.size / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 });
      const date = metadata.built?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const built = date
        ? new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
        : null;
      apkInfo.textContent = `Android APK · ${size} MB${built ? ` · Built ${built}` : ""} · SHA-256: ${metadata.sha256}`;
    })
    .catch(() => undefined);
}
