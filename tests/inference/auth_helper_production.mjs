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

/* global window, location, document, AbortController, localStorage */

/**
 * BASE_URL=https://bundle-onnx-dot-seung-lab.appspot.com/ node tests/inference/auth_helper_production.mjs
 *
 * Uses built production provider/helper code, strict viewer headers and relaxed
 * helper headers. One synthetic authorize response verifies the full credential
 * relay; a separate fresh context checks the REAL Google popup opener without
 * completing OAuth. Never print credentials, URL queries/fragments or raw errors.
 */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { chromium } from "playwright";

const serverUrl = "https://global.daf-apis.com/sticky_auth";
const authorizeUrl = `${serverUrl}/api/v1/authorize`;
const googleOrigin = "https://accounts.google.com";
const syntheticToken = "nonsecret-auth-helper-production-fixture";
const timeout = Number(process.env.TIMEOUT || 90000);
let browser;
let deadline;
let stage = "configuration";
let report;
let activeMain;
let activeHelper;

try {
  assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 600000);
  const appUrl = new URL(process.env.BASE_URL);
  assert(
    appUrl.protocol === "https:" ||
      (appUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(appUrl.hostname)),
  );
  assert(
    !appUrl.username && !appUrl.password && !appUrl.search && !appUrl.hash,
  );
  stage = "browser launch";
  browser = await chromium.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: process.env.HEADFUL !== "1",
    args: ["--no-sandbox"],
    timeout,
  });
  const smoke = async () => {
    async function startFlow(context) {
      context.setDefaultTimeout(timeout);
      context.setDefaultNavigationTimeout(timeout);
      const main = await context.newPage();
      activeMain = main;
      stage = "isolated production viewer";
      const response = await main.goto(appUrl.href, {
        waitUntil: "domcontentloaded",
      });
      assert(response?.ok());
      const headers = await response.allHeaders();
      assert.equal(headers["cross-origin-opener-policy"], "same-origin");
      assert.equal(headers["cross-origin-embedder-policy"], "require-corp");
      await main.waitForFunction(() => window.viewer?.dataSourceProvider);
      assert.equal(await main.evaluate(() => window.crossOriginIsolated), true);
      await main.evaluate(
        ({ serverUrl, syntheticToken }) => {
          const abort = (window.authHelperSmokeAbort = new AbortController());
          window.authHelperSmokeState = "pending";
          const provider =
            window.viewer.dataSourceProvider.credentialsManager.getCredentialsProvider(
              "middleauth",
              serverUrl,
            );
          provider.get(undefined, { signal: abort.signal }).then(
            ({ credentials }) => {
              window.authHelperSmokeState =
                credentials.accessToken === syntheticToken &&
                credentials.url === serverUrl &&
                credentials.tokenType === "Bearer"
                  ? "synthetic-success"
                  : "unexpected-result";
            },
            () => {
              window.authHelperSmokeState = "rejected";
            },
          );
        },
        { serverUrl, syntheticToken },
      );
      stage = "production helper launch";
      const [helper] = await Promise.all([
        context.waitForEvent("page"),
        main
          .getByRole("button", { name: "Request login.", exact: true })
          .click(),
      ]);
      activeHelper = helper;
      stage = "helper navigation";
      await helper.waitForURL(
        (url) => url.pathname === new URL("middleauth.html", appUrl).pathname,
        { waitUntil: "domcontentloaded" },
      );
      stage = "helper response headers";
      const helperResponse = await context.request.get(
        new URL("middleauth.html", appUrl).href,
      );
      assert(helperResponse.ok());
      const helperHeaders = helperResponse.headers();
      assert.equal(
        helperHeaders["cross-origin-opener-policy"],
        "same-origin-allow-popups",
      );
      assert.equal(
        helperHeaders["cross-origin-embedder-policy"],
        "unsafe-none",
      );
      stage = "helper nonisolation";
      assert.equal(
        await helper.evaluate(() => window.crossOriginIsolated),
        false,
      );
      stage = "helper opener separation";
      assert.equal(await helper.evaluate(() => window.opener === null), true);
      stage = "helper fragment cleanup";
      assert.equal(await helper.evaluate(() => location.hash), "");
      stage = "helper explicit sign-in button";
      await helper
        .getByRole("button", { name: "Sign in with Google", exact: true })
        .waitFor();
      return { main, helper };
    }

    stage = "synthetic callback fixture";
    const synthetic = await browser.newContext({ serviceWorkers: "block" });
    await synthetic.route(authorizeUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Nonsecret synthetic authorize callback</title>",
      }),
    );
    const fixture = await startFlow(synthetic);
    stage = "synthetic authorize callback navigation";
    const [callback] = await Promise.all([
      synthetic.waitForEvent("page"),
      fixture.helper
        .getByRole("button", { name: "Sign in with Google", exact: true })
        .click(),
    ]);
    await callback.waitForURL(authorizeUrl, { waitUntil: "domcontentloaded" });
    assert.equal(await callback.evaluate(() => window.opener !== null), true);
    stage = "synthetic valid callback and BroadcastChannel relay";
    await callback.evaluate(
      ({ token, origin }) => {
        window.opener.postMessage({ token, app_urls: [] }, origin);
      },
      { token: syntheticToken, origin: appUrl.origin },
    );
    await fixture.main.waitForFunction(
      () => window.authHelperSmokeState !== "pending",
    );
    assert.equal(
      await fixture.main.evaluate(() => window.authHelperSmokeState),
      "synthetic-success",
    );
    if (!fixture.helper.isClosed()) await fixture.helper.waitForEvent("close");
    if (!callback.isClosed()) await callback.waitForEvent("close");
    assert.equal(
      await fixture.main.evaluate(() =>
        Object.keys(localStorage).some((key) =>
          key.startsWith("auth_token_v2_"),
        ),
      ),
      false,
    );
    await synthetic.close();

    stage = "fresh real middleauth Google popup";
    const real = await browser.newContext({ serviceWorkers: "block" });
    const live = await startFlow(real);
    stage = "real authorize-to-Google navigation";
    const [google] = await Promise.all([
      real.waitForEvent("page"),
      live.helper
        .getByRole("button", { name: "Sign in with Google", exact: true })
        .click(),
    ]);
    await google.waitForURL((url) => url.origin === googleOrigin, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(await google.evaluate(() => window.opener !== null), true);
    stage = "rejecting Google-origin credential spoof";
    await google.evaluate(
      ({ token, origin }) => {
        window.opener.postMessage({ token, app_urls: [] }, origin);
      },
      { token: syntheticToken, origin: appUrl.origin },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await live.main.evaluate(() => window.authHelperSmokeState),
      "pending",
    );
    stage = "cancellation cleanup";
    await live.main.evaluate(() => window.authHelperSmokeAbort.abort());
    await live.main.waitForFunction(
      () => window.authHelperSmokeState === "rejected",
    );
    if (!live.helper.isClosed()) await live.helper.waitForEvent("close");
    if (!google.isClosed()) await google.waitForEvent("close");
    await real.close();
    return {
      ok: true,
      viewerIsolated: true,
      helperIsolated: false,
      syntheticCredentialRelay: true,
      googlePopupOpener: true,
      wrongOriginRejected: true,
      cancellationCleanup: true,
      oauthCompleted: false,
    };
  };
  report = await Promise.race([
    smoke(),
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Smoke deadline")), timeout);
    }),
  ]);
} catch (error) {
  const reason =
    [
      "Target page",
      "strict mode violation",
      "Timeout",
      "Execution context was destroyed",
      "page has been closed",
    ].find((text) => String(error?.message).includes(text)) ||
    "assertion or browser error";
  console.error(`Auth helper production smoke failed: ${stage} (${reason})`);
  console.error(
    JSON.stringify({
      mainClosed: activeMain?.isClosed(),
      helperClosed: activeHelper?.isClosed(),
      state: await activeMain
        ?.evaluate(() => window.authHelperSmokeState)
        .catch(() => "unavailable"),
      helper: await activeHelper
        ?.evaluate(() => ({
          isolated: window.crossOriginIsolated,
          status: document.getElementById("status")?.textContent,
          buttons: document.querySelectorAll("button").length,
        }))
        .catch(() => "unavailable"),
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (browser) {
    const cleanup = setTimeout(() => process.exit(1), 10000);
    try {
      await browser.close();
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(cleanup);
    }
  }
}
if (report && !process.exitCode) console.log(JSON.stringify(report));
