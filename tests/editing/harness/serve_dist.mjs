/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Static server for the BUILT prod bundle (`dist/client`) used by the paint
 * benchmark — the portal-style "serve the prod build, not the dev-server"
 * pattern. Unlike the webpack dev-server it has NO HMR, so it never recompiles
 * or reloads the page mid-run (the stale-bundle / mid-stroke-reload problem).
 *
 * Sets the same cross-origin-isolation headers the dev-server does
 * (`COOP: same-origin` + `COEP: require-corp`) so `crossOriginIsolated` is true
 * → SharedArrayBuffer + self-hosted pyodide work. Same-origin subresources also
 * get `Cross-Origin-Resource-Policy: cross-origin` so COEP lets them load.
 *
 * Run (the bench config's webServer does this):  node tests/editing/harness/serve_dist.mjs
 * Port via BENCH_PORT (default 9777). Exits with a clear error if the build is
 * missing — run `npm run build:zetta` first (or `npm run e2e`).
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mime from "mime-types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../dist/client");
const PORT = Number(process.env.BENCH_PORT ?? 9777);

const INDEX = path.join(ROOT, "index.html");
if (!existsSync(INDEX)) {
  console.error(
    `[bench-serve] no built client at ${ROOT}\n` +
      `Run a prod build first:  npm run build:zetta   (or just: npm run e2e)`,
  );
  process.exit(1);
}

const COI = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://localhost").pathname,
    );
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    // Resolve within ROOT (path-traversal guard); fall back to index.html.
    let filePath = path.normalize(path.join(ROOT, pathname));
    if (
      !filePath.startsWith(ROOT) ||
      !existsSync(filePath) ||
      statSync(filePath).isDirectory()
    ) {
      filePath = INDEX;
    }
    const type = mime.lookup(filePath) || "application/octet-stream";
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      ...COI,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`bench-serve error: ${err}`);
  }
}).listen(PORT, () => {
  // The bench config's webServer waits for this URL.
  console.log(`[bench-serve] dist/client → http://localhost:${PORT}`);
});
