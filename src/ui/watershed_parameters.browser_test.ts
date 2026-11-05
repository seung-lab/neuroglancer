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

import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatershedParametersWidget } from "#src/ui/watershed_parameters.js";
import {
  DEFAULT_WATERSHED_HALO,
  DEFAULT_WATERSHED_OPTIONS,
  validateWatershedChannels,
} from "#src/watershed/base.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { parseWatershedRecipe } from "#src/watershed/recipe.js";

const MASK = "Use last channel as mask";
const AGGLOMERATE = "Agglomerate watershed basins";
const AGG = "Agglomeration threshold (agg_threshold)";
const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function makeRecipe(): WatershedRecipe {
  return {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: "Native affinities",
      source: { url: "precomputed://https://example.com/affinities" },
    },
    inputScaleIndex: 2,
    channelsXYZ: [0, 1, 2],
    options: { ...DEFAULT_WATERSHED_OPTIONS },
    spacingXYZ: [4e-9, 4e-9, 16e-9],
  };
}

function fixture(
  initial = makeRecipe(),
  onApply?: (
    recipe: WatershedRecipe,
    widget: WatershedParametersWidget,
  ) => void,
) {
  // A real producer may share its recipe with several consumers. Nothing in
  // this editor may mutate that object, including on invalid input or refresh.
  const original = parseWatershedRecipe(initial);
  Object.freeze(original.options);
  Object.freeze(original.channelsXYZ);
  Object.freeze(original.spacingXYZ);
  Object.freeze(original.source.source);
  Object.freeze(original.source);
  Object.freeze(original);
  let accepted = parseWatershedRecipe(original);
  const apply = vi.fn((recipe: WatershedRecipe) => {
    onApply?.(recipe, widget);
    accepted = parseWatershedRecipe(recipe);
  });
  const widget = new WatershedParametersWidget(original, apply);
  const host = document.createElement("div");
  host.style.cssText = "width:340px;background:#222;color:white";
  host.append(widget.element);
  document.body.append(host);
  disposers.push(() => host.remove());
  disposers.push(() => {
    if (!widget.wasDisposed) widget.dispose();
  });
  return { widget, host, original, apply, accepted: () => accepted };
}

function input(widget: WatershedParametersWidget, label: string) {
  const matches = Array.from(widget.element.querySelectorAll("input")).filter(
    (element) => element.getAttribute("aria-label") === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

function error(widget: WatershedParametersWidget) {
  return widget.element.querySelector<HTMLElement>('[role="alert"]')!;
}

async function fill(
  widget: WatershedParametersWidget,
  label: string,
  text: string,
) {
  const element = input(widget, label);
  expect(element.type).toBe("number");
  await userEvent.fill(element, text);
}

async function toggle(widget: WatershedParametersWidget, label: string) {
  const element = input(widget, label);
  expect(element.type).toBe("checkbox");
  await userEvent.click(element);
}

function expectOptionalEnabled(
  widget: WatershedParametersWidget,
  title: string,
  enabled: boolean,
) {
  expect(input(widget, title).disabled).toBe(!enabled);
  expect(input(widget, `${title} slider`).disabled).toBe(!enabled);
}

describe("WatershedParametersWidget", () => {
  it("shows precise defaults and read-only native context without writing", () => {
    const { widget, host, apply, original } = fixture();
    expect(widget.element.querySelector("legend")!.textContent).toBe(
      "Watershed parameters",
    );
    const defaults: Record<string, string> = {
      "High threshold": "0.99999",
      "Low threshold": "0.00005",
      "Size threshold": "50",
      "Dust threshold": "50",
      "Mask threshold": "0.3",
      [AGG]: "0.15",
      "Halo (voxels)": String(DEFAULT_WATERSHED_HALO),
      "−X affinity channel": "0",
      "−Y affinity channel": "1",
      "−Z affinity channel": "2",
    };
    for (const [label, value] of Object.entries(defaults)) {
      expect(input(widget, label).value).toBe(value);
    }
    for (const title of [
      "High threshold",
      "Low threshold",
      "Mask threshold",
      AGG,
    ]) {
      expect(input(widget, title).step).toBe("any");
      expect(input(widget, `${title} slider`).min).toBe("0");
      expect(input(widget, `${title} slider`).max).toBe("1");
    }
    const allInputs = Array.from(widget.element.querySelectorAll("input"));
    const labels = allInputs.map((element) =>
      element.getAttribute("aria-label"),
    );
    expect(allInputs).toHaveLength(17);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(allInputs.length);
    expect(input(widget, MASK).checked).toBe(false);
    expect(input(widget, AGGLOMERATE).checked).toBe(false);
    expectOptionalEnabled(widget, "Mask threshold", false);
    expectOptionalEnabled(widget, AGG, false);
    const context = widget.element.querySelector(
      '[aria-label="Watershed input context"]',
    )!;
    expect(context.textContent).toContain("Native affinities");
    expect(context.textContent).toContain("Native scale index: 2");
    expect(context.textContent).toContain("4e-9, 4e-9, 1.6e-8");
    expect(context.textContent).toContain("read-only");
    expect(context.textContent).toContain("upstream inference");
    expect(
      context.querySelector("input, select, textarea, [contenteditable]"),
    ).toBeNull();
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    widget.setRecipe(structuredClone(original));
    widget.setEnabled(false);
    widget.setEnabled(true);
    widget.dispose();
    expect(apply).not.toHaveBeenCalled();
    expect(original).toEqual(makeRecipe());
  });

  it("applies every required numeric field immediately, preserving source geometry", async () => {
    const { widget, original, apply, accepted } = fixture();
    const edits: Array<[string, string, (recipe: WatershedRecipe) => number]> =
      [
        ["High threshold", "0.987654321", (r) => r.options.highThreshold],
        ["Low threshold", "0.0000123456789", (r) => r.options.lowThreshold],
        ["Size threshold", "0", (r) => r.options.sizeThreshold],
        ["Dust threshold", "4294967295", (r) => r.options.dustThreshold],
        ["Halo (voxels)", "1024", (r) => r.halo!],
        ["−X affinity channel", "6", (r) => r.channelsXYZ[0]],
        ["−Y affinity channel", "0", (r) => r.channelsXYZ[1]],
        ["−Z affinity channel", "6", (r) => r.channelsXYZ[2]],
        ["High threshold", "1", (r) => r.options.highThreshold],
        ["Low threshold", "0", (r) => r.options.lowThreshold],
        ["Halo (voxels)", "0", (r) => r.halo!],
      ];
    for (const [label, text, get] of edits) {
      const count = apply.mock.calls.length;
      await fill(widget, label, text);
      expect(apply).toHaveBeenCalledTimes(count + 1);
      expect(get(accepted())).toBe(Number(text));
      expect(error(widget).hidden).toBe(true);
      // Native number controls also emit change on blur: no duplicate writes.
      input(widget, label).dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      expect(apply).toHaveBeenCalledTimes(count + 1);
    }
    expect(accepted().source).toEqual(original.source);
    expect(accepted().inputScaleIndex).toBe(original.inputScaleIndex);
    expect(accepted().spacingXYZ).toEqual(original.spacingXYZ);
    expect(accepted().version).toBe(1);
    expect(accepted().source).not.toBe(original.source);
    expect(original).toEqual(makeRecipe());
    // Disposing immediately after the input cannot lose a widget-side timer.
    widget.dispose();
    expect(accepted().halo).toBe(0);
  });

  it("keeps typed precision and halo values beyond the slider maximum", async () => {
    const { widget, accepted } = fixture();
    for (const [title, text] of [
      ["High threshold", "0.999999999123"],
      ["Low threshold", "0.00000000012345"],
      ["Halo (voxels)", "9007199254740991"],
    ]) {
      await fill(widget, title, text);
      expect(input(widget, title).value).toBe(text);
      expect(input(widget, title).validity.valid).toBe(true);
    }
    expect(accepted().options.highThreshold).toBe(0.999999999123);
    expect(accepted().options.lowThreshold).toBe(0.00000000012345);
    expect(accepted().halo).toBe(Number.MAX_SAFE_INTEGER);
    expect(input(widget, "Halo (voxels) slider").value).toBe("64");
    expect(input(widget, "Halo (voxels)").value).toBe("9007199254740991");
  });

  it("uses actual native sliders for every paired control", async () => {
    const { widget, apply, accepted } = fixture();
    await toggle(widget, MASK);
    await toggle(widget, AGGLOMERATE);
    const edits: Array<
      [string, string, number, (r: WatershedRecipe) => number]
    > = [
      ["High threshold", "{End}", 1, (r) => r.options.highThreshold],
      ["Low threshold", "{Home}", 0, (r) => r.options.lowThreshold],
      ["Mask threshold", "{End}", 1, (r) => r.options.maskThreshold!],
      [AGG, "{Home}", 0, (r) => r.options.aggThreshold!],
      ["Halo (voxels)", "{End}", 64, (r) => r.halo!],
    ];
    for (const [title, key, value, get] of edits) {
      const slider = input(widget, `${title} slider`);
      expect(slider.type).toBe("range");
      const count = apply.mock.calls.length;
      slider.focus();
      // Playwright sends native keys to Chrome, not synthetic input events.
      await userEvent.keyboard(key);
      expect(slider.valueAsNumber).toBe(value);
      expect(input(widget, title).valueAsNumber).toBe(value);
      expect(get(accepted())).toBe(value);
      expect(apply.mock.calls.length).toBeGreaterThan(count);
    }
  });

  it.each([
    [MASK, "Mask threshold", "maskThreshold", 0.3],
    [AGGLOMERATE, AGG, "aggThreshold", 0.15],
  ] as const)(
    "remembers %s drafts, honors zero, and survives synchronous model echoes",
    async (checkbox, title, key, defaultValue) => {
      const { widget, apply, accepted } = fixture(
        undefined,
        (recipe, widget) => {
          widget.setRecipe(recipe);
          widget.setRecipe(structuredClone(recipe));
        },
      );
      await toggle(widget, checkbox);
      expect(accepted().options[key]).toBe(defaultValue);
      expectOptionalEnabled(widget, title, true);
      await fill(widget, title, "0.123456789123");
      expect(accepted().options[key]).toBe(0.123456789123);
      await toggle(widget, checkbox);
      expect(accepted().options).not.toHaveProperty(key);
      expectOptionalEnabled(widget, title, false);
      expect(input(widget, title).value).toBe("0.123456789123");
      widget.setRecipe(structuredClone(accepted()));
      await fill(widget, "Size threshold", "51");
      expect(input(widget, title).value).toBe("0.123456789123");
      await toggle(widget, checkbox);
      expect(accepted().options[key]).toBe(0.123456789123);
      await fill(widget, title, "0");
      expect(accepted().options[key]).toBe(0);
      await toggle(widget, checkbox);
      expect(accepted().options).not.toHaveProperty(key);
      await toggle(widget, checkbox);
      expect(accepted().options[key]).toBe(0);
      expect(input(widget, title).value).toBe("0");
      expect(error(widget).hidden).toBe(true);
      expect(apply).toHaveBeenCalledTimes(8);
    },
  );

  it.each([
    [MASK, "Mask threshold", "maskThreshold"],
    [AGGLOMERATE, AGG, "aggThreshold"],
  ] as const)(
    "ignores invalid unchecked %s drafts but validates them on re-enable",
    async (checkbox, title, key) => {
      const { widget, apply, accepted } = fixture(
        undefined,
        (recipe, widget) => {
          widget.setRecipe(recipe);
        },
      );
      await toggle(widget, checkbox);
      const before = accepted();
      const count = apply.mock.calls.length;
      await fill(widget, title, "");
      expect(error(widget).hidden).toBe(false);
      expect(apply).toHaveBeenCalledTimes(count);
      expect(accepted()).toBe(before);
      await toggle(widget, checkbox);
      expect(accepted().options).not.toHaveProperty(key);
      expect(error(widget).hidden).toBe(true);
      await fill(widget, "Dust threshold", "75");
      widget.setRecipe(structuredClone(accepted()));
      expect(input(widget, title).value).toBe("");
      const offCount = apply.mock.calls.length;
      await toggle(widget, checkbox);
      expectOptionalEnabled(widget, title, true);
      expect(apply).toHaveBeenCalledTimes(offCount);
      expect(error(widget).hidden).toBe(false);
      await fill(widget, title, "0.45");
      expect(accepted().options[key]).toBe(0.45);
      expect(accepted().options.dustThreshold).toBe(75);
      expect(error(widget).hidden).toBe(true);
    },
  );

  it.each([
    ["High threshold", "", "0.9"],
    ["High threshold", "-0.1", "0.9"],
    ["High threshold", "1.1", "0.9"],
    ["High threshold", "0", "0.9"],
    ["Low threshold", "-0.1", "0.1"],
    ["Low threshold", "1", "0.1"],
    ["Low threshold", "1.1", "0.1"],
    ["Low threshold", "", "0.1"],
    ["Size threshold", "-1", "70"],
    ["Size threshold", "0.5", "70"],
    ["Size threshold", "4294967296", "70"],
    ["Dust threshold", "", "70"],
    ["Dust threshold", "-1", "70"],
    ["Dust threshold", "0.5", "70"],
    ["Dust threshold", "4294967296", "70"],
    ["Halo (voxels)", "-1", "12"],
    ["Halo (voxels)", "0.5", "12"],
    ["Halo (voxels)", "9007199254740992", "12"],
    ["−X affinity channel", "-1", "3"],
    ["−X affinity channel", "0.5", "3"],
    ["−Y affinity channel", "", "3"],
    ["−Y affinity channel", "9007199254740992", "3"],
    ["−Z affinity channel", "-1", "3"],
    ["−Z affinity channel", "0.5", "3"],
  ])(
    "rejects %s = %s without mutating the recipe, then recovers",
    async (title, invalid, valid) => {
      const { widget, original, apply, accepted } = fixture();
      const before = accepted();
      await fill(widget, title, invalid);
      expect(error(widget).hidden).toBe(false);
      expect(error(widget).textContent).not.toBe("");
      expect(apply).not.toHaveBeenCalled();
      expect(accepted()).toBe(before);
      expect(original).toEqual(makeRecipe());
      await fill(widget, title, valid);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(error(widget).hidden).toBe(true);
    },
  );

  it.each([
    [MASK, "Mask threshold"],
    [AGGLOMERATE, AGG],
  ])(
    "validates enabled %s probability bounds and recovers",
    async (checkbox, title) => {
      const { widget, apply, accepted } = fixture();
      await toggle(widget, checkbox);
      for (const text of ["-0.1", "1.1", ""]) {
        const before = accepted();
        const count = apply.mock.calls.length;
        await fill(widget, title, text);
        expect(error(widget).hidden).toBe(false);
        expect(apply).toHaveBeenCalledTimes(count);
        expect(accepted()).toBe(before);
      }
      await fill(widget, title, "1");
      expect(error(widget).hidden).toBe(true);
    },
  );

  it("validates the entire accumulated draft, including float32 threshold ordering", async () => {
    const { widget, apply, accepted } = fixture();
    await fill(widget, "Low threshold", "0.5");
    const before = accepted();
    await fill(widget, "High threshold", "0.500000001");
    expect(error(widget).textContent).toContain("in float32");
    await fill(widget, "Dust threshold", "80");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(accepted()).toBe(before);
    // A harmless model notification cannot erase an unfinished/invalid draft.
    const focused = input(widget, "Dust threshold");
    focused.focus();
    widget.setRecipe(structuredClone(before));
    expect(document.activeElement).toBe(focused);
    expect(input(widget, "High threshold").value).toBe("0.500000001");
    expect(input(widget, "Dust threshold").value).toBe("80");
    expect(error(widget).hidden).toBe(false);
    await fill(widget, "High threshold", "0.6");
    expect(accepted().options).toMatchObject({
      lowThreshold: 0.5,
      highThreshold: 0.6,
      dustThreshold: 80,
    });
    expect(error(widget).hidden).toBe(true);
  });

  it("handles Chrome's unfinished numeric badInput without coercing it to zero", async () => {
    const { widget, apply } = fixture();
    const high = input(widget, "High threshold");
    await userEvent.clear(high);
    await userEvent.type(high, "e");
    expect(high.value).toBe("");
    expect(high.validity.badInput).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(error(widget).hidden).toBe(false);
    await fill(widget, "High threshold", "0.95");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(error(widget).hidden).toBe(true);
  });

  it("reports callback channel-bound failures and allows correcting all pending drafts", async () => {
    const { widget, apply, original, accepted } = fixture(
      undefined,
      (recipe) => {
        validateWatershedChannels(4, recipe.channelsXYZ, recipe.options);
      },
    );
    const before = accepted();
    await fill(widget, "−X affinity channel", "4");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(error(widget).textContent).toBe(
      "Watershed needs three in-bounds affinity channels",
    );
    expect(accepted()).toBe(before);
    await fill(widget, "Size threshold", "123");
    expect(accepted()).toBe(before);
    await fill(widget, "−X affinity channel", "2");
    expect(accepted().channelsXYZ).toEqual([2, 1, 2]);
    expect(accepted().options.sizeThreshold).toBe(123);
    expect(error(widget).hidden).toBe(true);
    expect(original).toEqual(makeRecipe());
  });

  it("does not commit a thrown callback and permits retrying the same draft", async () => {
    let fail = true;
    const { widget, apply, accepted } = fixture(undefined, () => {
      if (fail) throw "Producer is not ready";
    });
    const before = accepted();
    await fill(widget, "Size threshold", "81");
    expect(error(widget).textContent).toBe("Producer is not ready");
    expect(accepted()).toBe(before);
    fail = false;
    input(widget, "Size threshold").dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    expect(apply).toHaveBeenCalledTimes(2);
    expect(accepted().options.sizeThreshold).toBe(81);
    expect(error(widget).hidden).toBe(true);
  });

  it("refreshes every field in place without losing focus or writing", async () => {
    const { widget, apply } = fixture();
    const elements = Array.from(widget.element.querySelectorAll("input"));
    const high = input(widget, "High threshold");
    high.focus();
    const updated = makeRecipe();
    updated.source.name = "Replacement affinities";
    updated.inputScaleIndex = 3;
    updated.spacingXYZ = [1, 2, 3];
    updated.channelsXYZ = [3, 2, 1];
    updated.halo = 4096;
    updated.options = {
      highThreshold: 0.8,
      lowThreshold: 0.2,
      sizeThreshold: 100,
      dustThreshold: 200,
      maskThreshold: 0,
      aggThreshold: 0,
    };
    widget.setRecipe(updated);
    const refreshed = Array.from(widget.element.querySelectorAll("input"));
    expect(refreshed).toHaveLength(elements.length);
    elements.forEach((element, i) => expect(refreshed[i]).toBe(element));
    expect(document.activeElement).toBe(high);
    for (const [label, value] of Object.entries({
      "High threshold": 0.8,
      "Low threshold": 0.2,
      "Size threshold": 100,
      "Dust threshold": 200,
      "Mask threshold": 0,
      [AGG]: 0,
      "Halo (voxels)": 4096,
      "−X affinity channel": 3,
      "−Y affinity channel": 2,
      "−Z affinity channel": 1,
    })) {
      expect(input(widget, label).valueAsNumber).toBe(value);
    }
    expect(widget.element.textContent).toContain("Replacement affinities");
    expect(widget.element.textContent).toContain("Native scale index: 3");
    expect(input(widget, MASK).checked).toBe(true);
    expect(input(widget, AGGLOMERATE).checked).toBe(true);
    expectOptionalEnabled(widget, "Mask threshold", true);
    expectOptionalEnabled(widget, AGG, true);
    expect(apply).not.toHaveBeenCalled();
    // Refreshes also detach caller-owned recipes from subsequent mutation.
    updated.source.name = "Do not adopt this mutation";
    await fill(widget, "Size threshold", "101");
    expect(apply.mock.calls[0][0].source.name).toBe("Replacement affinities");
  });

  it("disables all controls while loading and preserves optional enablement on refresh", async () => {
    const { widget, apply, accepted } = fixture();
    await toggle(widget, MASK);
    await fill(widget, "Halo (voxels)", "99");
    const count = apply.mock.calls.length;
    widget.setEnabled(false);
    for (const element of widget.element.querySelectorAll("input")) {
      expect(element.disabled).toBe(true);
    }
    const size = input(widget, "Size threshold");
    size.value = "999";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    expect(apply).toHaveBeenCalledTimes(count);
    widget.setRecipe(structuredClone(accepted()));
    expect(size.value).toBe("999");
    const updated = makeRecipe();
    updated.halo = 17;
    widget.setRecipe(updated);
    for (const element of widget.element.querySelectorAll("input")) {
      expect(element.disabled).toBe(true);
    }
    widget.setEnabled(true);
    expect(input(widget, "Size threshold").disabled).toBe(false);
    expect(input(widget, MASK).disabled).toBe(false);
    expectOptionalEnabled(widget, "Mask threshold", false);
    expectOptionalEnabled(widget, AGG, false);
    expect(input(widget, "Halo (voxels)").value).toBe("17");
    widget.setRecipe(makeRecipe());
    expect(input(widget, "Halo (voxels)").value).toBe("8");
    expect(apply).toHaveBeenCalledTimes(count);
  });

  it("validates external recipes before updating controls and retains a usable model", async () => {
    const { widget, original, apply } = fixture();
    widget.setRecipe({
      ...makeRecipe(),
      version: 99,
    } as unknown as WatershedRecipe);
    expect(error(widget).textContent).toBe(
      "Invalid watershed recipe version: expected 1",
    );
    expect(input(widget, "High threshold").value).toBe("0.99999");
    expect(apply).not.toHaveBeenCalled();
    await fill(widget, "Size threshold", "82");
    expect(apply.mock.calls[0][0]).toEqual({
      ...original,
      options: { ...original.options, sizeThreshold: 82 },
    });
    expect(error(widget).hidden).toBe(true);
  });

  it("removes its DOM and every input/change listener on disposal", async () => {
    const { widget, host, apply } = fixture();
    const controls = Array.from(widget.element.querySelectorAll("input"));
    await fill(widget, "Size threshold", "83");
    const count = apply.mock.calls.length;
    widget.dispose();
    expect(widget.wasDisposed).toBe(true);
    expect(widget.element.isConnected).toBe(false);
    expect(host.children).toHaveLength(0);
    for (const control of controls) {
      if (control.type === "checkbox") control.checked = !control.checked;
      else control.value = "1";
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(apply).toHaveBeenCalledTimes(count);
  });
});
