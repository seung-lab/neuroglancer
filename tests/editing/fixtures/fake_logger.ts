/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LogLevel, LoggerChannel } from "@zetta-ai/edit-session";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";

export interface RecordedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly channel: LoggerChannel;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Silent test double for `NgLogger`. Captures every call so tests can assert
 * on what was logged without writing to the console or surfacing
 * `StatusMessage` toasts.
 */
export class FakeLogger {
  readonly level: LogLevel = "debug";
  readonly logs: RecordedLog[] = [];

  debug(channel: LoggerChannel, message: string, data?: unknown): void {
    this.logs.push({ level: "debug", channel, message, data });
  }
  info(channel: LoggerChannel, message: string, data?: unknown): void {
    this.logs.push({ level: "info", channel, message, data });
  }
  warn(channel: LoggerChannel, message: string, data?: unknown): void {
    this.logs.push({ level: "warn", channel, message, data });
  }
  error(channel: LoggerChannel, message: string, data?: unknown): void {
    this.logs.push({ level: "error", channel, message, data });
  }

  /** Cast helper for adapters that take an `NgLogger`. */
  asNgLogger(): NgLogger {
    return this as unknown as NgLogger;
  }
}
