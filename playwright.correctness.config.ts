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
 * Playwright config for the edit-session PAINT CORRECTNESS e2e (TM-331, phase 2).
 *
 * Like the paint benchmark it serves the built prod bundle via `serve_dist.mjs`
 * (COOP/COEP → cross-origin isolation → SAB + pyodide). Unlike the bench it does
 * NOT need live `gs://` auth: the spec boots a local `fake-gcs-server` over the
 * generated fixtures and route-rewrites the app's GCS reads onto it, so the run
 * is reproducible and offline.
 *
 *   npm run bench:correctness        # fixtures + build + run
 *   npm run bench:correctness:run    # run only (build + fixtures already fresh)
 *
 * ⚠ Needs the prod build (`dist/client`) + generated fixtures
 * (`uv run testdata/editing/generate.py`). Run headless with software WebGL2.
 */

import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.CORRECTNESS_PORT ?? 9782);

export default defineConfig({
  testDir: "tests/editing/bench",
  testMatch: /edit_paint_correctness\.spec\.ts/,
  timeout: 8 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
      ],
    },
  },
  webServer: {
    // Serve the prebuilt `dist/client` (fresh each run, no HMR).
    command: "node tests/editing/bench/serve_dist.mjs",
    url: `http://localhost:${PORT}`,
    env: { BENCH_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60 * 1000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
