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

import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { parseWatershedRecipe } from "#src/watershed/recipe.js";

/** Editable recipe state for an existing producer, never a replacement input. */
export class WatershedParametersState implements Trackable {
  readonly changed = new NullarySignal();
  private readonly initial: WatershedRecipe;
  private recipe: WatershedRecipe;

  constructor(
    recipe: WatershedRecipe,
    private readonly apply: (recipe: WatershedRecipe) => void,
  ) {
    this.initial = parseWatershedRecipe(recipe);
    this.recipe = this.initial;
  }

  toJSON(): WatershedRecipe {
    return parseWatershedRecipe(this.recipe);
  }

  restoreState(value: unknown): void {
    const recipe = parseWatershedRecipe(
      value === undefined ? this.initial : value,
    );
    if (
      recipe.inputScaleIndex !== this.initial.inputScaleIndex ||
      JSON.stringify(recipe.source) !== JSON.stringify(this.initial.source) ||
      recipe.spacingXYZ.some((n, i) => n !== this.initial.spacingXYZ[i])
    ) {
      throw new Error(
        "Changing the watershed input or native scale requires a new layer",
      );
    }
    if (JSON.stringify(recipe) === JSON.stringify(this.recipe)) return;
    // Producer validation must succeed before shared state is changed.
    this.apply(recipe);
    this.recipe = recipe;
    this.changed.dispatch();
  }

  reset(): void {
    this.restoreState(this.initial);
  }
}
