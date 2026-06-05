import type { Logger, LoggerChannel, LogLevel } from "@zettaai/edit-session";

import { StatusMessage } from "#src/status.js";

export class NgLogger implements Logger {
  readonly level: LogLevel = "info";

  debug(channel: LoggerChannel, message: string, data?: unknown): void {
    if (data !== undefined) {
      console.debug(`[edit-session:${channel}] ${message}`, data);
    } else {
      console.debug(`[edit-session:${channel}] ${message}`);
    }
  }

  info(channel: LoggerChannel, message: string, data?: unknown): void {
    if (data !== undefined) {
      console.info(`[edit-session:${channel}] ${message}`, data);
    } else {
      console.info(`[edit-session:${channel}] ${message}`);
    }
  }

  warn(channel: LoggerChannel, message: string, data?: unknown): void {
    if (data !== undefined) {
      console.warn(`[edit-session:${channel}] ${message}`, data);
    } else {
      console.warn(`[edit-session:${channel}] ${message}`);
    }
    StatusMessage.showTemporaryMessage(message, 4000);
  }

  error(channel: LoggerChannel, message: string, data?: unknown): void {
    if (data !== undefined) {
      console.error(`[edit-session:${channel}] ${message}`, data);
    } else {
      console.error(`[edit-session:${channel}] ${message}`);
    }
    StatusMessage.showTemporaryMessage(message, 8000);
  }
}
