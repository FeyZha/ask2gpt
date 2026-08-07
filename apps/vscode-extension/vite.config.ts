import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: "dist/webview",
    rollupOptions: {
      input: "src/webview/main.tsx",
      output: {
        assetFileNames: "webview.[ext]",
        entryFileNames: "webview.js",
      },
    },
  },
});
