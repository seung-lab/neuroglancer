/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ComponentType, RenderableProps } from "preact";
import { createElement, render } from "preact";

import type { Disposer } from "#src/util/disposable.js";

/**
 * Mount a Preact component into `target`. Returns a disposer that unmounts the
 * component (which also runs all component-level useEffect cleanups).
 *
 * To re-render with new props, call mountComponent again with the same target
 * — Preact reuses the existing component tree where possible.
 */
export function mountComponent<T>(
  target: HTMLElement,
  component: ComponentType<T>,
  props: RenderableProps<T>,
): Disposer {
  render(createElement(component, props), target);
  return () => render(null, target);
}
