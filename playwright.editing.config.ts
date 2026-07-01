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
 * Playwright config for the edit-session e2e + perf suites (TM-331). ONE config,
 * two projects:
 *
 *   --project e2e    tests/editing/e2e/*.e2e.ts     (correctness)
 *   --project perf   tests/editing/perf/*.perf.ts   (paint benchmark)
 *
 * Both serve the BUILT prod bundle via `serve_dist.mjs` (COOP/COEP → cross-origin
 * isolation → SAB + pyodide) and load `buildNgState` scenarios against the LOCAL
 * fake-gcs fixtures — reproducible, no live `gs://`. Run via the npm scripts:
 *
 *   npm run e2e[:headed|:ui]   npm run perf[:headed]
 *
 * ⚠ Needs the prod build (`dist/client`) + generated fixtures
 * (`uv run testdata/editing/generate.py`) + WebGL2. Not a normal-CI gate.
 */

import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

// Software WebGL2 in headless chromium. TUNE per host/CI if the canvas stays
// black or WebGL2 is unavailable.
const WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
];

export default defineConfig({
  timeout: 10 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    headless: true,
    launchOptions: { args: WEBGL_ARGS },
  },
  webServer: {
    // Serve the prebuilt `dist/client` — fresh each run, no HMR.
    command: "node tests/editing/harness/serve_dist.mjs",
    url: `http://localhost:${PORT}`,
    env: { BENCH_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60 * 1000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    { name: "e2e", testDir: "tests/editing/e2e", testMatch: /\.e2e\.ts$/ },
    { name: "perf", testDir: "tests/editing/perf", testMatch: /\.perf\.ts$/ },
  ],
});
