import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "verify-classic-content-script",
      generateBundle(_options, bundle) {
        for (const fileName of ["content-script.js", "page-model-bridge.js"]) {
          const contentScript = bundle[fileName];
          if (
            !contentScript ||
            contentScript.type !== "chunk" ||
            contentScript.imports.length > 0 ||
            contentScript.dynamicImports.length > 0
          ) {
            this.error(
              `${fileName} must be a self-contained classic script; manifest content scripts cannot import Vite chunks.`,
            );
          }
        }
      },
    },
  ],
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        "service-worker": resolve(import.meta.dirname, "src/service-worker.ts"),
        "page-model-bridge": resolve(import.meta.dirname, "src/page-model-bridge.ts"),
        "content-script": resolve(import.meta.dirname, "src/content-script.ts"),
        popup: resolve(import.meta.dirname, "popup.html"),
      },
      output: {
        assetFileNames: "[name].[ext]",
        chunkFileNames: "[name].js",
        entryFileNames: "[name].js",
      },
    },
  },
});
