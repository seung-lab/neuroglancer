/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useReducer } from "preact/hooks";

import type { NullaryReadonlySignal } from "#src/util/signal.js";

export function useSignal(
  signal: NullaryReadonlySignal | undefined,
): void {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (signal === undefined) return;
    return signal.add(() => bump(0));
  }, [signal, bump]);
}
