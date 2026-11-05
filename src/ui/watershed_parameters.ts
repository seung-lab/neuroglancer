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

import "#src/widget/range.css";
import "#src/ui/watershed_parameters.css";

import { RefCounted } from "#src/util/disposable.js";
import { DEFAULT_WATERSHED_OPTIONS } from "#src/watershed/base.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { parseWatershedRecipe } from "#src/watershed/recipe.js";

type NumericKind = "probability" | "uint32";

interface NumericControl {
  title: string;
  kind: NumericKind;
  input: HTMLInputElement;
  slider?: HTMLInputElement;
}

let nextWidgetId = 0;

function sameRecipe(a: WatershedRecipe, b: WatershedRecipe) {
  // Both recipes are detached, schema-normalized JSON snapshots.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Editor for a prepared watershed's recipe, not its upstream inference config.
 * The owner supplies model refreshes via setRecipe and loading state via
 * setEnabled. apply must synchronously accept the recipe or throw; scheduling
 * and the live runtime's debounce belong to the owner, not to this widget.
 */
export class WatershedParametersWidget extends RefCounted {
  readonly element: HTMLElement = document.createElement("fieldset");
  private readonly context = document.createElement("div");
  private readonly error = document.createElement("div");
  private readonly controls: NumericControl[] = [];
  private readonly id = `neuroglancer-watershed-parameters-${nextWidgetId++}`;
  private readonly high = this.numeric(
    "High threshold",
    "probability",
    DEFAULT_WATERSHED_OPTIONS.highThreshold,
    1,
  );
  private readonly low = this.numeric(
    "Low threshold",
    "probability",
    DEFAULT_WATERSHED_OPTIONS.lowThreshold,
    1,
  );
  private readonly size = this.numeric(
    "Size threshold",
    "uint32",
    DEFAULT_WATERSHED_OPTIONS.sizeThreshold,
  );
  private readonly dust = this.numeric(
    "Dust threshold",
    "uint32",
    DEFAULT_WATERSHED_OPTIONS.dustThreshold,
  );
  private readonly useMask = this.checkbox("Use last channel as mask");
  private readonly mask = this.numeric("Mask threshold", "probability", 0.3, 1);
  private readonly useAgglomeration = this.checkbox(
    "Agglomerate watershed basins",
  );
  private readonly agglomeration = this.numeric(
    "Agglomeration threshold (agg_threshold)",
    "probability",
    0.15,
    1,
  );
  private recipe: WatershedRecipe;
  private applyingRecipe: WatershedRecipe | undefined;
  private enabled = true;

  constructor(
    recipe: WatershedRecipe,
    private readonly apply: (recipe: WatershedRecipe) => void,
  ) {
    super();
    this.recipe = parseWatershedRecipe(recipe);
    const { element, context, error } = this;
    element.className = "neuroglancer-watershed-parameters";
    const legend = document.createElement("legend");
    legend.textContent = "Watershed parameters";
    context.className = "neuroglancer-watershed-parameters-context";
    context.setAttribute("aria-label", "Watershed input context");
    element.prepend(legend, context);
    error.className = "neuroglancer-watershed-parameters-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    element.append(error);
    this.showRecipe();
  }

  private numeric(
    title: string,
    kind: NumericKind,
    initial: number,
    sliderMax?: number,
  ): NumericControl {
    const row = document.createElement("div");
    row.className = "neuroglancer-watershed-parameters-row";
    const label = document.createElement("label");
    label.textContent = title;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(kind === "probability" ? 1 : 0xffffffff);
    input.step = kind === "probability" ? "any" : "1";
    input.value = String(initial);
    input.id = `${this.id}-${this.controls.length}`;
    label.htmlFor = input.id;
    input.setAttribute("aria-label", title);
    const pair = document.createElement("div");
    pair.className = "range-slider";
    const control: NumericControl = { title, kind, input };
    if (sliderMax !== undefined) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = String(sliderMax);
      slider.step = input.step;
      slider.value = input.value;
      slider.setAttribute("aria-label", `${title} slider`);
      control.slider = slider;
      pair.append(slider);
      // Unlike RangeWidget, retain the number input as an independent draft.
      // A range sanitizes/clamps its own value; it must never normalize a typed
      // number.
      const fromSlider = () => {
        if (slider.disabled) return;
        input.value = slider.value;
        this.applyDraft();
      };
      this.registerEventListener(slider, "input", fromSlider);
      this.registerEventListener(slider, "change", fromSlider);
    }
    const fromNumber = () => {
      if (input.disabled) return;
      this.syncSlider(control);
      this.applyDraft();
    };
    this.registerEventListener(input, "input", fromNumber);
    this.registerEventListener(input, "change", fromNumber);
    pair.append(input);
    row.append(label, pair);
    this.element.append(row);
    this.controls.push(control);
    return control;
  }

  private checkbox(title: string) {
    const label = document.createElement("label");
    label.className = "neuroglancer-watershed-parameters-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", title);
    label.append(input, title);
    this.element.append(label);
    this.registerEventListener(input, "change", () => {
      if (input.disabled) return;
      this.updateEnabled();
      this.applyDraft();
    });
    return input;
  }

  private read(control: NumericControl): number {
    const text = control.input.value;
    const value = text.trim() === "" ? NaN : Number(text);
    if (control.kind === "probability") {
      if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
      throw new Error(`${control.title} must be a finite number in [0, 1]`);
    }
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff)
      return value;
    throw new Error(`${control.title} must be a uint32 integer`);
  }

  private syncSlider(control: NumericControl) {
    if (control.slider === undefined) return;
    try {
      control.slider.value = String(this.read(control));
    } catch {
      // An unfinished numeric draft leaves the slider at its last valid value.
    }
  }

  private showRecipe() {
    const { recipe } = this;
    const { options } = recipe;
    this.context.textContent =
      `Affinity source: ${recipe.source.name}. Native scale index: ${recipe.inputScaleIndex}. ` +
      `Voxel spacing XYZ: ${recipe.spacingXYZ.join(", ")}. ` +
      "Source and scale are read-only: changing them requires preparing input geometry again. " +
      "These controls do not change upstream inference settings.";
    for (const [control, value] of [
      [this.high, options.highThreshold],
      [this.low, options.lowThreshold],
      [this.size, options.sizeThreshold],
      [this.dust, options.dustThreshold],
      [this.mask, options.maskThreshold],
      [this.agglomeration, options.aggThreshold],
    ] as const) {
      // Absence disables the optional control, but does not erase its draft.
      if (value !== undefined) control.input.value = String(value);
      this.syncSlider(control);
    }
    this.useMask.checked = options.maskThreshold !== undefined;
    this.useAgglomeration.checked = options.aggThreshold !== undefined;
    this.updateEnabled();
    this.setError("");
  }

  /** Refresh controls in place. Identical echoes preserve focus and drafts. */
  public setRecipe(recipe: WatershedRecipe): void {
    try {
      const parsed = parseWatershedRecipe(recipe);
      if (sameRecipe(parsed, this.applyingRecipe ?? this.recipe)) return;
      this.recipe = parsed;
      this.showRecipe();
    } catch (error) {
      this.setError(error);
    }
  }

  /** Loading must not discard drafts, trigger writes, or re-enable optionals. */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.updateEnabled();
  }

  private updateEnabled() {
    this.useMask.disabled = this.useAgglomeration.disabled = !this.enabled;
    for (const control of this.controls) {
      const disabled =
        !this.enabled ||
        (control === this.mask && !this.useMask.checked) ||
        (control === this.agglomeration && !this.useAgglomeration.checked);
      control.input.disabled = disabled;
      if (control.slider !== undefined) control.slider.disabled = disabled;
    }
  }

  private setError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.error.textContent = message;
    this.error.hidden = message === "";
  }

  private applyDraft() {
    if (!this.enabled) return;
    try {
      const candidate = parseWatershedRecipe({
        ...this.recipe,
        options: {
          highThreshold: this.read(this.high),
          lowThreshold: this.read(this.low),
          sizeThreshold: this.read(this.size),
          dustThreshold: this.read(this.dust),
          ...(this.useMask.checked
            ? { maskThreshold: this.read(this.mask) }
            : {}),
          ...(this.useAgglomeration.checked
            ? { aggThreshold: this.read(this.agglomeration) }
            : {}),
        },
      });
      if (!sameRecipe(candidate, this.recipe)) {
        // Keep our snapshot separate from the callback's copy, and recognize
        // synchronous setRecipe echoes without overwriting remembered drafts.
        const snapshot = parseWatershedRecipe(candidate);
        const previous = this.recipe;
        this.applyingRecipe = snapshot;
        try {
          this.apply(candidate);
          if (this.recipe === previous) this.recipe = snapshot;
        } finally {
          this.applyingRecipe = undefined;
        }
      }
      this.setError("");
    } catch (error) {
      this.setError(error);
    }
  }

  disposed() {
    this.element.remove();
    super.disposed();
  }
}
