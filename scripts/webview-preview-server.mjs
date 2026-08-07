import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createPreviewState, validatePreviewState } from "./webview-preview-state.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const previewRoot = join(dirname(fileURLToPath(import.meta.url)), "webview-preview");
const webviewRoot = join(repoRoot, "apps", "vscode-extension", "dist", "webview");
const templatePath = join(previewRoot, "index.html");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function serializeForHtml(value) {
  return JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");
}

async function renderIndex() {
  const [template] = await Promise.all([
    readFile(templatePath, "utf8"),
    stat(join(webviewRoot, "webview.js")),
    stat(join(webviewRoot, "webview.css")),
  ]);
  const state = validatePreviewState(createPreviewState());
  return template.replace("__ask2gpt_INITIAL_STATE__", serializeForHtml(state));
}

function safeAssetPath(root, requestPath) {
  const relativePath = normalize(decodeURIComponent(requestPath)).replace(/^([/\\])+/, "");
  const candidate = resolve(root, relativePath);
  const candidateRelativePath = relative(root, candidate);
  if (
    candidateRelativePath === "" ||
    candidateRelativePath === ".." ||
    candidateRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelativePath)
  ) {
    return undefined;
  }
  return candidate;
}

async function serveFile(response, path) {
  const body = await readFile(path);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes.get(extname(path)) ?? "application/octet-stream",
  });
  response.end(body);
}

export function createPreviewServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const body = await renderIndex();
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/health") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ ok: true, state: "ready" }));
        return;
      }

      let path;
      if (url.pathname === "/preview/harness.js") path = join(previewRoot, "harness.js");
      if (url.pathname.startsWith("/webview/")) {
        path = safeAssetPath(webviewRoot, url.pathname.slice("/webview/".length));
      }
      if (!path) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      await serveFile(response, path);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1])
) {
  const host = argument("--host", "127.0.0.1");
  const port = Number(argument("--port", "4177"));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid --port: ${port}`);
  }
  const server = createPreviewServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`Ask2GPT webview preview: http://${host}:${actualPort}/?controls=1\n`);
    process.stdout.write(
      `Autoplay: http://${host}:${actualPort}/?scenario=sequence (Ctrl+C to stop)\n`,
    );
  });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
