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
 * Accessors for the build-time `custom-keybinds.json` config (injected via
 * `--define CUSTOM_BINDINGS=...`). Kept dependency-free so both
 * `default_viewer_setup` (global tool/action bindings) and the edit-session
 * hotkey binder (session-scoped edit keybinds) can read it without an import
 * cycle.
 */

/**
 * Edit-session keybind overrides (TM-315): friendly action name → key event
 * identifier(s) in neuroglancer `EventActionMap` syntax (e.g. "control+keyb").
 * Lives under the reserved `editSession` key in `custom-keybinds.json` and is
 * applied to the SESSION-scoped input map (not the global maps), so edit
 * hotkeys never leak outside an active session.
 */
export type EditSessionKeybinds = {
  readonly [name: string]: string | readonly string[];
};

/** Reserved key in `custom-keybinds.json` for the edit-session keybind section. */
export const EDIT_SESSION_BINDINGS_KEY = "editSession";

// `CUSTOM_BINDINGS` is replaced at build time by the `--define`d literal (the
// contents of `config/custom-keybinds.json`); absent in unconfigured builds.
declare const CUSTOM_BINDINGS: { readonly [key: string]: unknown } | undefined;

/**
 * The edit-session keybind overrides from `custom-keybinds.json`, or undefined
 * when none are configured. The session hotkey binder merges these over its
 * built-in defaults.
 */
export function getEditSessionKeybinds(): EditSessionKeybinds | undefined {
  if (typeof CUSTOM_BINDINGS === "undefined" || CUSTOM_BINDINGS === null) {
    return undefined;
  }
  const section = CUSTOM_BINDINGS[EDIT_SESSION_BINDINGS_KEY];
  return section !== undefined &&
    typeof section === "object" &&
    !Array.isArray(section)
    ? (section as EditSessionKeybinds)
    : undefined;
}
