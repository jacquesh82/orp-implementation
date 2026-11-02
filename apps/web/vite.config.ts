import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  base: "./",
  build: {
    // PWA preloadable offline: a single bundle, no remote code (7.1-5).
    target: "es2022",
  },
  // HTTPS in dev and preview (local certificate): WebCrypto and the camera
  // require a secure context, including from another device on the network.
  plugins: [basicSsl()],
});
