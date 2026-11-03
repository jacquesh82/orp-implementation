import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The showcase and its /protocol/ guide share the build. The bench (/lab/),
// the application (/app/) and the APK are assembled alongside by the root
// Dockerfile.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL("./index.html", import.meta.url)),
        protocol: fileURLToPath(new URL("./protocol/index.html", import.meta.url)),
        notFound: fileURLToPath(new URL("./404.html", import.meta.url)),
      },
    },
  },
});
