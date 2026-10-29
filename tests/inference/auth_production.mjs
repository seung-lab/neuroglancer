/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global window, location */

/**
 * Production middleauth popup/channel smoke; no build, mocks or OAuth login.
 *
 *   BASE_URL=https://host/app/ node tests/inference/auth_production.mjs
 *
 * CHROME defaults to /usr/bin/google-chrome; HEADFUL=1 is optional.
 * TIMEOUT (milliseconds, default 60000) bounds the entire smoke, in addition
 * to Playwright's launch/navigation/wait timeouts. A fresh browser context
 * has no imported credentials/storage. Never read cookies, tokens or page
 * contents, click login, or print URL queries/fragments or raw browser errors.
 * The synthetic postMessage proves only the browser callback channel, NOT
 * successful Google OAuth or an authenticated middleauth callback.
 */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { chromium } from "playwright";

const authorizeUrl = "https://global.daf-apis.com/sticky_auth/api/v1/authorize";
const googleOrigin = "https://accounts.google.com";
const marker = "neuroglancer-auth-production-nonsecret-channel-probe";
let browser;
let deadline;
let stage = "configuration";
let report;

// Only these two nonsecret location fields may leave a page for reporting.
const safeLocation = (page) =>
  page.evaluate(() => ({ origin: location.origin, path: location.pathname }));

try {
  const timeout = Number(process.env.TIMEOUT || 60000);
  assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 600000);
  assert(process.env.BASE_URL, "BASE_URL is required (remote HTTPS app)");
  const appUrl = new URL(process.env.BASE_URL);
  assert.equal(appUrl.protocol, "https:");
  assert(
    !appUrl.username && !appUrl.password && !appUrl.search && !appUrl.hash,
  );

  const started = Date.now();
  stage = "Chrome launch";
  browser = await chromium.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: process.env.HEADFUL !== "1",
    args: ["--no-sandbox"],
    timeout,
  });
  // Launch has its own timeout. Start the remaining deadline only once the
  // browser is assigned, so a launch/deadline race cannot leak a late browser.
  const remaining = timeout - (Date.now() - started);
  assert(remaining > 0);
  const smoke = async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    const main = await context.newPage();

    stage = "production navigation and headers";
    const response = await main.goto(appUrl.href, {
      waitUntil: "domcontentloaded",
    });
    assert(response && response.ok());
    const headers = await response.allHeaders();
    assert.equal(
      headers["cross-origin-opener-policy"],
      "same-origin-allow-popups",
    );
    assert.equal(headers["cross-origin-embedder-policy"], "unsafe-none");
    assert.equal(await main.evaluate(() => window.crossOriginIsolated), false);
    const mainLocation = await safeLocation(main);

    stage = "real middleauth popup and Google redirect";
    const [popup] = await Promise.all([
      main.waitForEvent("popup", { timeout }),
      main.evaluate(
        ({ authorizeUrl, marker, googleOrigin }) => {
          const probe = (window.authProductionProbe = {
            popup: null,
            received: false,
          });
          window.addEventListener("message", (event) => {
            if (
              event.data === marker &&
              event.origin === googleOrigin &&
              event.source === probe.popup
            ) {
              probe.received = true;
            }
          });
          // Keep the actual WindowProxy returned to the production main page.
          // Do not use noopener, a replacement page, or a mocked auth response.
          probe.popup = window.open(authorizeUrl, "_blank");
        },
        { authorizeUrl, marker, googleOrigin },
      ),
    ]);
    await popup.waitForURL((url) => url.origin === googleOrigin, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    const popupLocation = await safeLocation(popup);
    assert.equal(popupLocation.origin, googleOrigin);

    stage = "preserved popup handle and opener";
    assert.equal(
      await main.evaluate(() => window.authProductionProbe.popup?.closed),
      false,
    );
    assert.equal(await popup.evaluate(() => window.opener !== null), true);

    stage = "nonsecret postMessage callback channel";
    await popup.evaluate(
      ({ marker, targetOrigin }) => {
        window.opener.postMessage(marker, targetOrigin);
      },
      { marker, targetOrigin: mainLocation.origin },
    );
    // received is set only for a genuine MessageEvent whose source is the
    // original popup WindowProxy; this is not an app/OAuth completion signal.
    await main.waitForFunction(
      () => window.authProductionProbe.received,
      null,
      {
        timeout,
      },
    );
    assert.equal(
      await main.evaluate(() => window.authProductionProbe.popup.closed),
      false,
    );
    return {
      ok: true,
      main: mainLocation,
      popup: popupLocation,
      callbackChannel: true,
      oauthCompleted: false,
    };
  };

  report = await Promise.race([
    smoke(),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("Smoke deadline")),
        remaining,
      );
    }),
  ]);
} catch {
  // Playwright errors can embed full OAuth redirect URLs. Never print them,
  // assertion actual values, network logs, page contents, or browser traces.
  console.error(`Auth production smoke failed: ${stage}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (browser) {
    // Last-resort process exit also bounds cleanup if Chrome is unresponsive.
    const cleanupDeadline = setTimeout(() => {
      console.error("Auth production smoke failed: browser cleanup timeout");
      process.exit(1);
    }, 10000);
    try {
      await browser.close();
    } catch {
      console.error("Auth production smoke failed: browser cleanup");
      process.exitCode = 1;
    } finally {
      clearTimeout(cleanupDeadline);
    }
  }
}
if (report && !process.exitCode) console.log(JSON.stringify(report));
