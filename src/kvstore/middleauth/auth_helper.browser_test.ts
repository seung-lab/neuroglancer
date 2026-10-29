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

import { afterEach, expect, it, vi } from "vitest";

const frames: HTMLIFrameElement[] = [];
const channels: BroadcastChannel[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
  for (const channel of channels.splice(0)) channel.close();
  vi.restoreAllMocks();
});

async function loadHelper() {
  const name = `middleauth-${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  channels.push(channel);
  const messages: any[] = [];
  channel.onmessage = (event) => {
    messages.push(event.data);
    if (["ready", "heartbeat"].includes(event.data.type))
      channel.postMessage({ type: "ping" });
  };
  const frame = document.createElement("iframe");
  frames.push(frame);
  const url = new URL("./middleauth.html", import.meta.url);
  url.hash = new URLSearchParams({
    server: "https://auth.example",
    channel: name,
  }).toString();
  frame.src = url.href;
  document.body.appendChild(frame);
  await vi.waitFor(() => expect(messages).toContainEqual({ type: "ready" }));
  const helper = frame.contentWindow!;
  const button = frame.contentDocument!.querySelector("button")!;
  const close = vi.spyOn(helper, "close").mockImplementation(() => {});
  return { helper, button, channel, messages, close };
}

function mockPopup(helper: Window) {
  const popupFrame = document.createElement("iframe");
  frames.push(popupFrame);
  document.body.appendChild(popupFrame);
  const popup = popupFrame.contentWindow!;
  const close = vi.spyOn(popup, "close").mockImplementation(() => {});
  const open = vi.spyOn(helper, "open").mockReturnValue(popup);
  return { popup, open, close };
}

function respond(
  helper: Window,
  source: Window,
  origin: string,
  data: unknown,
) {
  helper.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

it("clears the fragment, requires an explicit click, validates source/origin, and acknowledges before close", async () => {
  const { helper, button, channel, messages, close } = await loadHelper();
  expect(helper.location.hash).toBe("");
  expect(button.textContent).toBe("Sign in with Google");
  expect(button.disabled).toBe(false);
  const { popup, open, close: closePopup } = mockPopup(helper);
  expect(open).not.toHaveBeenCalled();
  button.click();
  expect(open).toHaveBeenCalledWith(
    "https://auth.example/api/v1/authorize",
    "_blank",
    "popup,width=400,height=650",
  );
  const data = { token: "synthetic-secret", app_urls: ["https://app.example"] };
  respond(helper, window, "https://auth.example", data);
  respond(helper, popup, "https://spoof.example", data);
  // Even a malformed response from the wrong source must be ignored.
  respond(helper, window, "https://auth.example", null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(messages.some((x) => ["credentials", "error"].includes(x.type))).toBe(
    false,
  );
  respond(helper, popup, "https://auth.example", {
    ...data,
    unwanted: "not relayed",
  });
  await vi.waitFor(() =>
    expect(messages).toContainEqual({ type: "credentials", response: data }),
  );
  expect(closePopup).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  helper.dispatchEvent(new Event("pagehide"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(messages.some((x) => x.type === "closed")).toBe(false);
  channel.postMessage({ type: "complete" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("shows malformed expected responses visibly without relaying the token", async () => {
  const { helper, button, messages } = await loadHelper();
  const { popup, close } = mockPopup(helper);
  button.click();
  respond(helper, popup, "https://auth.example", {
    token: "never-relay-this",
    app_urls: [123],
  });
  await vi.waitFor(() =>
    expect(messages).toContainEqual({
      type: "error",
      code: "invalid-response",
    }),
  );
  expect(helper.document.getElementById("status")!.textContent).toContain(
    "unexpected authentication response",
  );
  expect(JSON.stringify(messages)).not.toContain("never-relay-this");
  expect(close).toHaveBeenCalledOnce();
});

it("reports a blocked authorization popup visibly", async () => {
  const { helper, button, messages } = await loadHelper();
  vi.spyOn(helper, "open").mockReturnValue(null);
  button.click();
  await vi.waitFor(() =>
    expect(messages).toContainEqual({ type: "error", code: "popup-blocked" }),
  );
  expect(helper.document.getElementById("status")!.textContent).toContain(
    "blocked",
  );
});

it("heartbeats without credentials, and cancellation closes both windows", async () => {
  const { helper, button, channel, messages, close } = await loadHelper();
  const { close: closePopup } = mockPopup(helper);
  button.click();
  await vi.waitFor(
    () => expect(messages).toContainEqual({ type: "heartbeat" }),
    { timeout: 3000 },
  );
  expect(messages.every((x) => ["ready", "heartbeat"].includes(x.type))).toBe(
    true,
  );
  channel.postMessage({ type: "cancel" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(closePopup).toHaveBeenCalledOnce();
});

it("reports helper pagehide and closes its authorization popup", async () => {
  const { helper, button, messages } = await loadHelper();
  const { close } = mockPopup(helper);
  button.click();
  helper.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() =>
    expect(messages).toContainEqual({ type: "closed", code: undefined }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it("allows a queued callback to win over popup close detection", async () => {
  const { helper, button, messages } = await loadHelper();
  const { popup } = mockPopup(helper);
  button.click();
  vi.spyOn(popup, "closed", "get").mockReturnValue(true);
  const data = { token: "synthetic-secret", app_urls: [] };
  // Exercise the actual helper interval: once its heartbeat arrives, close
  // detection has scheduled a grace period for any queued response message.
  await vi.waitFor(
    () => expect(messages).toContainEqual({ type: "heartbeat" }),
    { timeout: 3000 },
  );
  respond(helper, popup, "https://auth.example", data);
  await vi.waitFor(() =>
    expect(messages).toContainEqual({ type: "credentials", response: data }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(messages.some((x) => x.type === "closed")).toBe(false);
});

it("reports authorization popup close and closes the helper on cancel", async () => {
  const { helper, button, channel, messages, close } = await loadHelper();
  const { popup } = mockPopup(helper);
  button.click();
  vi.spyOn(popup, "closed", "get").mockReturnValue(true);
  await vi.waitFor(() => expect(messages).toContainEqual({ type: "closed" }), {
    timeout: 3000,
  });
  channel.postMessage({ type: "cancel" });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("closes both windows if the viewer disappears", async () => {
  const { helper, button, messages, close } = await loadHelper();
  const { close: closePopup } = mockPopup(helper);
  button.click();
  const helperDate = (helper as Window & typeof globalThis).Date;
  vi.spyOn(helperDate, "now").mockReturnValue(Date.now() + 300_001);
  await vi.waitFor(
    () => expect(messages).toContainEqual({ type: "error", code: "timeout" }),
    { timeout: 3000 },
  );
  expect(close).toHaveBeenCalledOnce();
  expect(closePopup).toHaveBeenCalledOnce();
});
