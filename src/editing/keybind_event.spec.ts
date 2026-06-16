/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  formatKeyIdentifier,
  keyboardEventToIdentifier,
} from "#src/editing/keybind_event.js";

type Ev = Parameters<typeof keyboardEventToIdentifier>[0];
function ev(over: Partial<Ev>): Ev {
  return {
    code: "KeyB",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

describe("keyboardEventToIdentifier", () => {
  it("builds a plain key identifier", () => {
    expect(keyboardEventToIdentifier(ev({ code: "KeyB" }))).toBe("keyb");
  });

  it("prefixes modifiers in canonical order", () => {
    expect(
      keyboardEventToIdentifier(
        ev({ code: "KeyZ", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("control+shift+keyz");
    expect(
      keyboardEventToIdentifier(
        ev({ code: "KeyZ", metaKey: true, altKey: true }),
      ),
    ).toBe("meta+alt+keyz");
  });

  it("returns undefined for a lone modifier press", () => {
    expect(
      keyboardEventToIdentifier(ev({ code: "ControlLeft", ctrlKey: true })),
    ).toBeUndefined();
    expect(
      keyboardEventToIdentifier(ev({ code: "ShiftRight", shiftKey: true })),
    ).toBeUndefined();
    expect(keyboardEventToIdentifier(ev({ code: "" }))).toBeUndefined();
  });

  it("lowercases non-letter codes (brackets, minus, numpad)", () => {
    expect(keyboardEventToIdentifier(ev({ code: "BracketLeft" }))).toBe(
      "bracketleft",
    );
    expect(keyboardEventToIdentifier(ev({ code: "Minus" }))).toBe("minus");
    expect(keyboardEventToIdentifier(ev({ code: "NumpadAdd" }))).toBe(
      "numpadadd",
    );
  });
});

describe("formatKeyIdentifier", () => {
  it("formats modifiers + letters", () => {
    expect(formatKeyIdentifier("control+keyb")).toBe("Ctrl+B");
    expect(formatKeyIdentifier("meta+shift+keyz")).toBe("Cmd+Shift+Z");
  });

  it("formats punctuation and numpad keys", () => {
    expect(formatKeyIdentifier("minus")).toBe("-");
    expect(formatKeyIdentifier("bracketleft")).toBe("[");
    expect(formatKeyIdentifier("bracketright")).toBe("]");
    expect(formatKeyIdentifier("numpadsubtract")).toBe("Num-");
    expect(formatKeyIdentifier("escape")).toBe("Esc");
  });

  it("round-trips an identifier produced from an event", () => {
    const id = keyboardEventToIdentifier({
      code: "KeyF",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(id).toBe("control+keyf");
    expect(formatKeyIdentifier(id!)).toBe("Ctrl+F");
  });
});
