import * as esbuild from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await rm(new URL("./dist", import.meta.url), { force: true, recursive: true });
const context = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  minify: !watch,
  outfile: "dist/extension.cjs",
  platform: "node",
  sourcemap: watch,
  target: "node20",
});

if (watch) {
  await context.watch();
  const { build } = await import("vite");
  await build({
    build: { watch: {} },
    configFile: "vite.config.ts",
  });
  console.log("Watching VS Code extension host and webview...");
} else {
  await context.rebuild();
  await context.dispose();
}
