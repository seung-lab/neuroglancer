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

export type MiddleAuthResponse = { token: string; app_urls: string[] };

export function parseMiddleAuthResponse(data: unknown): MiddleAuthResponse {
  if (
    typeof data !== "object" ||
    data === null ||
    !("token" in data) ||
    typeof data.token !== "string" ||
    data.token.length === 0 ||
    !("app_urls" in data) ||
    !Array.isArray(data.app_urls) ||
    !data.app_urls.every((url) => typeof url === "string")
  ) {
    // Do not include the response (which may contain credentials) in errors.
    throw new Error("Received unexpected authentication response");
  }
  return { token: data.token, app_urls: data.app_urls };
}

/**
 * The helper must be served with relaxed COOP/COEP headers. It deliberately has
 * no opener: even a non-null WindowProxy may appear closed after a COOP split.
 * Liveness and cancellation therefore use only a per-attempt BroadcastChannel.
 * Keep this protocol in sync with the standalone middleauth.html asset.
 */
export function loginWithMiddleAuthHelper(
  serverUrl: string,
  signal: AbortSignal,
): Promise<MiddleAuthResponse> {
  signal.throwIfAborted();
  const url = new URL("./middleauth.html", import.meta.url);
  if (url.origin !== window.location.origin) {
    return Promise.reject(
      new Error("Authentication helper must be same-origin"),
    );
  }
  const channelName = `middleauth-${crypto.randomUUID()}`;
  url.hash = new URLSearchParams({
    server: serverUrl,
    channel: channelName,
  }).toString();
  const channel = new BroadcastChannel(channelName);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastSeen = started;
    let ready = false;
    let finished = false;
    function finish(error?: unknown, response?: MiddleAuthResponse) {
      if (finished) return;
      finished = true;
      channel.postMessage({ type: response ? "complete" : "cancel" });
      channel.onmessage = null;
      channel.close();
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      window.removeEventListener("pagehide", unload);
      if (response) resolve(response);
      else reject(error);
    }
    const abort = () => finish(signal.reason);
    const unload = () => finish(new Error("Authentication viewer was closed"));
    const timer = setInterval(() => {
      const now = Date.now();
      if (!ready && now - started >= 10_000) {
        finish(
          new Error(
            "Authentication helper did not open. Allow popups and retry.",
          ),
        );
      } else if (now - lastSeen >= 15_000) {
        finish(
          new Error("Authentication helper was closed or stopped responding"),
        );
      } else if (now - started >= 300_000) {
        finish(new Error("Authentication timed out"));
      } else {
        channel.postMessage({ type: "ping" });
      }
    }, 1000);
    channel.onmessage = (event) => {
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      switch (data.type) {
        case "ready":
        case "heartbeat":
          ready = true;
          lastSeen = Date.now();
          channel.postMessage({ type: "ping" });
          break;
        case "credentials":
          try {
            finish(undefined, parseMiddleAuthResponse(data.response));
          } catch (error) {
            finish(error);
          }
          break;
        case "closed":
          finish(new Error("Authentication window was closed"));
          break;
        case "error":
          // Only fixed, locally-defined errors cross the channel, never server
          // responses or exception text that might include a token.
          finish(
            new Error(
              data.code === "popup-blocked"
                ? "Failed to create authentication popup window. Allow popups and retry."
                : data.code === "invalid-response"
                  ? "Received unexpected authentication response"
                  : "Authentication helper failed or timed out",
            ),
          );
          break;
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    window.addEventListener("pagehide", unload);
    try {
      // With noopener a successful open normally returns null. Do not interpret
      // that as blocked, and never inspect .closed: await the ready message.
      window.open(url.href, "_blank", "noopener,popup,width=440,height=650");
    } catch {
      finish(new Error("Failed to create authentication helper window"));
    }
  });
}
