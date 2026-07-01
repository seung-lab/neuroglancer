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
 * Shared setup for the reproducible edit-session e2e specs (TM-331) — the
 * correctness suite AND the paint benchmark both load a `buildNgState` scenario
 * against the local fake-gcs fixtures (no live `gs://`, no auth). This module is
 * the single boot path so the two specs don't drift:
 *
 *   fixtures.json → fake-gcs → GCS route-rewrite → buildNgState → load →
 *   wait for the auto-opened session + harness → (optional) warm the paint path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";

import {
  buildNgState,
  type FixturesIndex,
  type Scenario,
} from "./build_ng_state.js";
import { startFakeGcsFixtures } from "./fake_gcs_fixtures.mjs";
import { installGcsRoute } from "./gcs_route.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_JSON = path.resolve(
  HERE,
  "../../../testdata/editing/fixtures.json",
);

export interface FixtureGcs {
  readonly url: string;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Load the generated fixtures index, or throw with a run-the-generator hint. */
export function loadFixturesIndex(): FixturesIndex {
  try {
    return JSON.parse(readFileSync(FIXTURES_JSON, "utf8")) as FixturesIndex;
  } catch {
    throw new Error(
      `no fixtures index at ${FIXTURES_JSON} — run: uv run testdata/editing/generate.py`,
    );
  }
}

/**
 * Boot a fake-gcs server over the generated fixture buckets. Uses a FREE
 * OS-assigned port by default so a leaked server from a prior run never blocks a
 * fresh one; pass `port` only for manual debugging.
 */
export function startFixtureGcs(port?: number): Promise<FixtureGcs> {
  return startFakeGcsFixtures(
    port !== undefined ? { port } : {},
  ) as Promise<FixtureGcs>;
}

/**
 * Open a scenario page: fresh context → GCS route-rewrite → `buildNgState` →
 * load → wait for the auto-opened session + the `__editPaintBench*` harness.
 * Does NOT warm — callers pick their warmup (correctness stamps vs the bench's
 * `__editPaintBenchWarmup`).
 */
export async function openScenarioPage(
  browser: Browser,
  opts: {
    scenario: Scenario;
    fixtures: FixturesIndex;
    fakeGcsUrl: string;
    appPort: number;
  },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${opts.appPort}`,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (/error|warn|pyodide|editPaintBench/i.test(m.text())) {
      console.log(`[page] ${m.text()}`);
    }
  });
  await installGcsRoute(page, opts.fakeGcsUrl);
  const state = buildNgState(opts.scenario, opts.fixtures);
  await page.goto(`/#!${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        viewer?: { editSessionHost?: { activeSession?: { value?: unknown } } };
        __editPaintBenchStampReadback?: unknown;
      };
      return (
        typeof w.__editPaintBenchStampReadback === "function" &&
        w.viewer?.editSessionHost?.activeSession?.value !== undefined
      );
    },
    undefined,
    { timeout: 5 * 60 * 1000 },
  );
  return page;
}

/**
 * Warm the paint path with a few discarded read-back stamps: the first stamps on
 * a cold page often don't register (slice transform not laid out, pyodide not
 * booted, params not propagated). Bounded — each gives up fast if nothing paints.
 */
export async function warmupPaintPath(
  page: Page,
  opts: { label: string; stamps?: number } = { label: "scenario" },
): Promise<void> {
  const stamps = opts.stamps ?? 4;
  await page.waitForTimeout(1000);
  for (let i = 0; i < stamps; i++) {
    const w = (await page.evaluate(async () => {
      const win = window as unknown as {
        __editPaintBenchStampReadback: (
          i: unknown,
        ) => Promise<{ paintedVoxels: number }>;
      };
      return win.__editPaintBenchStampReadback({
        radius: 8,
        prime: 0,
        clearFirst: true,
      });
    })) as { paintedVoxels: number };
    console.log(
      `[warmup] ${opts.label} stamp ${i + 1}/${stamps}: painted=${w.paintedVoxels}`,
    );
    if (w.paintedVoxels > 0 && i >= 1) break; // warm once it reliably paints
  }
  await page.evaluate(() => {
    (
      window as unknown as { __editPaintBenchClearTarget: () => void }
    ).__editPaintBenchClearTarget();
  });
}
