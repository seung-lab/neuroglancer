/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Helpers for the runtime edit-hotkey rebind UI (TM-315): convert a captured
 * `KeyboardEvent` into a neuroglancer `EventActionMap` key identifier (e.g.
 * `"control+keyb"`), and format an identifier for display (e.g. `"Ctrl+B"`).
 *
 * Kept dependency-free + pure so the round-trip is unit-testable without the
 * viewer. The identifier grammar mirrors what `mergeEditKeybinds` emits and
 * what neuroglancer's `parseEventIdentifier` consumes: lowercased
 * `event.code`, modifier prefixes (`control`/`meta`/`shift`/`alt`) joined with
 * `+`, modifiers ordered control→meta→shift→alt.
 */

const MODIFIER_CODE = /^(?:Control|Shift|Alt|Meta|OS)(?:Left|Right)?$/;

/**
 * Build the NG event identifier for a captured keydown, or `undefined` when the
 * event is a lone modifier press (so the caller keeps listening for the real
 * key). Modifiers are emitted in NG's canonical order.
 */
export function keyboardEventToIdentifier(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): string | undefined {
  const { code } = event;
  if (code === "" || MODIFIER_CODE.test(code)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("control");
  if (event.metaKey) parts.push("meta");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(code.toLowerCase());
  return parts.join("+");
}

const MODIFIER_LABEL: Record<string, string> = {
  control: "Ctrl",
  meta: "Cmd",
  shift: "Shift",
  alt: "Alt",
};

/** Pretty-print one segment of an identifier (a modifier or a key code). */
function formatSegment(part: string): string {
  const modifier = MODIFIER_LABEL[part];
  if (modifier !== undefined) return modifier;
  const key = /^key([a-z])$/.exec(part);
  if (key !== null) return key[1].toUpperCase();
  const digit = /^digit([0-9])$/.exec(part);
  if (digit !== null) return digit[1];
  const numpad = /^numpad(.+)$/.exec(part);
  if (numpad !== null) return `Num${formatSegment(numpad[1])}`;
  switch (part) {
    case "minus":
      return "-";
    case "equal":
      return "=";
    case "bracketleft":
      return "[";
    case "bracketright":
      return "]";
    case "escape":
      return "Esc";
    case "add":
      return "+";
    case "subtract":
      return "-";
    default:
      // Capitalise the first letter for anything else (e.g. "space" → "Space").
      return part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part;
  }
}

/** Format an NG event identifier for display, e.g. `"control+keyb"` → `"Ctrl+B"`. */
export function formatKeyIdentifier(identifier: string): string {
  return identifier.split("+").map(formatSegment).join("+");
}
