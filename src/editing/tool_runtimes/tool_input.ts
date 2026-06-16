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
 * Consumer-owned tool input contract (TM-315 migration).
 *
 * Ported from `@zettaai/edit-session`'s `tools/tool-input.event.ts` + `tool.ts`.
 * The library no longer ships a tool framework; the consumer owns the
 * normalized pointer/key event shape its `PointerEventBridge` produces and the
 * minimal `Tool` contract its tools implement and its dispatcher drives.
 */

export interface ModifierState {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type PointerButton = "primary" | "secondary" | "auxiliary";

interface ToolInputCommon {
  /** Clock-supplied timestamp (ms since some epoch). */
  readonly at: number;
  readonly modifiers: ModifierState;
}

export interface PointerDownEvent extends ToolInputCommon {
  readonly kind: "pointer-down";
  readonly button: PointerButton;
  /** Floats in voxel coords at the host's chosen reference resolution. */
  readonly voxelPosition: readonly [number, number, number];
  /** Pixel coords passed through opaquely; tools may ignore. */
  readonly screenPosition: readonly [number, number];
  /** Optional hint about which panel/canvas produced this event. */
  readonly panelHint: string | undefined;
}

export interface PointerMoveEvent extends ToolInputCommon {
  readonly kind: "pointer-move";
  /** "none" when the move is not part of a drag. */
  readonly button: PointerButton | "none";
  readonly voxelPosition: readonly [number, number, number];
  /**
   * Intermediate waypoints the host coalesced since the last delivered move
   * (oldest first, excluding `voxelPosition`). The latest-wins input bridge
   * accumulates skipped positions here so stroke tools can rasterize the true
   * pointer path instead of a straight line to `voxelPosition`. Absent /
   * empty => no coalescing happened.
   */
  readonly viaVoxelPositions?: readonly (readonly [number, number, number])[];
  readonly screenPosition: readonly [number, number];
  readonly panelHint: string | undefined;
}

export interface PointerUpEvent extends ToolInputCommon {
  readonly kind: "pointer-up";
  readonly button: PointerButton;
  readonly voxelPosition: readonly [number, number, number];
}

export interface PointerCancelEvent extends ToolInputCommon {
  readonly kind: "pointer-cancel";
}

export interface WheelEvent extends ToolInputCommon {
  readonly kind: "wheel";
  readonly deltaY: number;
  readonly voxelPosition: readonly [number, number, number];
}

export interface KeyEvent extends ToolInputCommon {
  readonly kind: "key";
  readonly phase: "down" | "up";
  /** DOM `KeyboardEvent.key`-style value. */
  readonly key: string;
}

export type ToolInputEvent =
  | PointerDownEvent
  | PointerMoveEvent
  | PointerUpEvent
  | PointerCancelEvent
  | WheelEvent
  | KeyEvent;

export const NO_MODIFIERS: ModifierState = {
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
};

export type InputHandling =
  | { readonly consumed: true; readonly refreshCursor?: boolean }
  | { readonly consumed: false };

/**
 * Minimal contract a consumer tool implements so the input bridge's dispatcher
 * can drive it. `id` identifies the tool for active-tool selection; everything
 * else is optional. The tool's own public API (e.g. radius cycling) lives on
 * the concrete class.
 */
export interface Tool {
  readonly id: string;
  /** Handle one normalized input event. */
  handleInput?(event: ToolInputEvent): InputHandling | Promise<InputHandling>;
  /** Called when the tool is deactivated; drop any in-progress pointer state. */
  onDeactivate?(): void;
  /** Called once at session end / removal. */
  dispose?(): void;
}
