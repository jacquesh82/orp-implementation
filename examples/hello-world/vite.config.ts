import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS (local certificate): the camera and WebCrypto require a secure
// context, including when the second device opens the page over the network.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  plugins: [basicSsl()],
});
