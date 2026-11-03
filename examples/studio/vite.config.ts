import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev`      → http://localhost:5173 (localhost is a secure context: camera + WebCrypto OK)
// `npm run dev:lan`  → HTTPS with a local certificate, reachable from a phone on the same network
export default defineConfig(({ mode }) => ({
  base: "./",
  build: { target: "es2022" },
  plugins: mode === "lan" ? [basicSsl()] : [],
  server: { host: mode === "lan" },
  // @optirelay/browser starts its decoding Worker with new URL("./reader-worker.js", import.meta.url):
  // pre-bundling would break that relative URL, so it is served as is.
  optimizeDeps: { exclude: ["@optirelay/browser"] },
  worker: { format: "es" },
}));
