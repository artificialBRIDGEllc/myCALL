import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Builds the Chrome extension (MV3) into dist/extension — load it via chrome://extensions → "Load unpacked". */
export default defineConfig({
  root: "extension",
  publicDir: "public",
  base: "./",
  build: {
    outDir: "../dist/extension",
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve("extension/popup.html"),
        setup: resolve("extension/setup.html"),
        offscreen: resolve("extension/offscreen.html"),
        "service-worker": resolve("extension/src/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
