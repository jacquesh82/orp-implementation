import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Relative base: the bundle is served as is by the Android app
// (WebViewAssetLoader, https://appassets.androidplatform.net/assets/lab/).
//
// HTTPS in dev and preview (self-signed local certificate): WebCrypto and the
// camera only exist in a secure context. Without it, the bench opened from
// another device on the network (http://192.168.x.x) can neither send a file
// nor film.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  plugins: [basicSsl()],
});
