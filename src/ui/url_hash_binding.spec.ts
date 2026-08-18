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

import { afterEach, describe, expect, test, vi } from "vitest";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { UrlHashBinding } from "#src/ui/url_hash_binding.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

const bindings: UrlHashBinding[] = [];

afterEach(() => {
  for (const binding of bindings) binding.dispose();
  bindings.length = 0;
  history.replaceState(null, "", location.pathname);
});

describe("UrlHashBinding state upgrades", () => {
  test("retains the upgrader for subsequent hash changes", () => {
    const restoredStates: any[] = [];
    const root: Trackable = {
      changed: new NullarySignal(),
      reset: vi.fn(),
      restoreState: (state) => restoredStates.push(state),
      toJSON: () => ({}),
    };
    const upgradeState = vi.fn((state) => ({ ...state, upgraded: true }));
    const binding = new UrlHashBinding(root, {} as SharedKvStoreContext, {
      upgradeState,
    });
    bindings.push(binding);

    history.replaceState(null, "", "#!%7B%22value%22%3A1%7D");
    binding.updateFromUrlHash();
    history.replaceState(null, "", "#!%7B%22value%22%3A2%7D");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(upgradeState).toHaveBeenCalledTimes(2);
    expect(restoredStates).toEqual([
      { value: 1, upgraded: true },
      { value: 2, upgraded: true },
    ]);
  });
});
