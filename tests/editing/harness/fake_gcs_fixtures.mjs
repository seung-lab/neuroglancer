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
 * Boot a `fake-gcs-server` serving the generated edit-session fixtures
 * (TM-331, phase 2). The filesystem backend serves `testdata/editing/buckets`
 * verbatim — each top-level subdir is a bucket — so the app loads
 * `precomputed://gs://<bucket>/<fixture-id>` against a LOCAL GCS with the SAME
 * URL scheme as prod (no auth, no cold `gs://`, fully reproducible).
 *
 * Reusable from the bench/e2e config (import `startFakeGcsFixtures`) or runnable
 * standalone for a quick check:
 *
 *   node tests/editing/harness/fake_gcs_fixtures.mjs --port 9778
 *   curl "http://localhost:9778/storage/v1/b/zetta-editing-test/o/img_u8_raw%2Finfo?alt=media"
 *
 * The Playwright side still has to point the app's GCS requests at this server
 * (route-rewrite `storage.googleapis.com` → localhost) — see build_ng_state.ts
 * and the bench config. Run `uv run testdata/editing/generate.py` first so the
 * buckets exist.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const BUCKETS_ROOT = path.join(REPO_ROOT, "testdata", "editing", "buckets");
const BIN = path.join(
  REPO_ROOT,
  "node_modules",
  ".cache",
  "gobin",
  "fake-gcs-server" + (process.platform === "win32" ? ".exe" : ""),
);

/**
 * Start the server. Resolves to `{ url, bucketsRoot, [Symbol.asyncDispose] }`
 * once the server reports ready. `url` is the GCS JSON-API origin
 * (`http://localhost:<port>`).
 */
export async function startFakeGcsFixtures({ port = 9778 } = {}) {
  if (!existsSync(BIN)) {
    throw new Error(
      `fake-gcs-server not built at ${BIN}\n` +
        `It is built by the vitest workspace setup, or run:\n` +
        `  npx tsx -e "import('./build_tools/vitest/build_fake_gcs_server.ts').then(m=>m.getFakeGcsServerBin())"`,
    );
  }
  if (!existsSync(BUCKETS_ROOT)) {
    throw new Error(
      `no fixtures at ${BUCKETS_ROOT}\nRun:  uv run testdata/editing/generate.py`,
    );
  }

  const proc = spawn(
    BIN,
    [
      // Load the generated `<root>/<bucket>/<objects>` tree into an in-memory
      // store (`-data` seeds; `filesystem-root` alone serves an empty store).
      "-backend",
      "memory",
      "-data",
      BUCKETS_ROOT,
      "-scheme",
      "http",
      "-host",
      "localhost",
      "-port",
      `${port}`,
      // Don't rewrite object URLs in responses — we serve the JSON API directly.
      "-public-host",
      `localhost:${port}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const { resolve, reject, promise } = Promise.withResolvers();
  (async () => {
    for await (const line of readline.createInterface({ input: proc.stderr })) {
      if (process.env.FAKE_GCS_VERBOSE) console.log(`fake_gcs: ${line}`);
      if (/server started at/.test(line)) resolve();
    }
    reject(new Error("fake-gcs-server exited before reporting ready"));
  })();
  await promise;

  return {
    url: `http://localhost:${port}`,
    bucketsRoot: BUCKETS_ROOT,
    async [Symbol.asyncDispose]() {
      proc.kill();
    },
  };
}

// Standalone mode: boot and stay up until killed.
if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 9778;
  const server = await startFakeGcsFixtures({ port });
  console.log(`[fake-gcs-fixtures] serving ${server.bucketsRoot}`);
  console.log(`[fake-gcs-fixtures] GCS JSON API → ${server.url}`);
  console.log(
    `[fake-gcs-fixtures] try: curl "${server.url}/storage/v1/b/zetta-editing-test/o/img_u8_raw%2Finfo?alt=media"`,
  );
}
