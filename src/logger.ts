/**
 * Minimal structured logger.
 *
 * Format: single-line JSON to stderr so it never interferes with potential stdio-MCP usage.
 */

import type { LogLevel } from "./config.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  tool?: string;
  itemId?: string;
  durationMs?: number;
  cacheHit?: boolean;
  bytes?: number;
  [extra: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  withFields(base: LogFields): Logger;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_WEIGHT[level];

  function emit(lvl: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    const record = {
      t: new Date().toISOString(),
      level: lvl,
      msg,
      ...(fields ?? {}),
    };
    // stderr keeps stdout clean for any future stdio-MCP transport.
    process.stderr.write(JSON.stringify(record) + "\n");
  }

  function make(base: LogFields = {}): Logger {
    return {
      debug: (msg, fields) => emit("debug", msg, { ...base, ...fields }),
      info: (msg, fields) => emit("info", msg, { ...base, ...fields }),
      warn: (msg, fields) => emit("warn", msg, { ...base, ...fields }),
      error: (msg, fields) => emit("error", msg, { ...base, ...fields }),
      withFields: (extra) => make({ ...base, ...extra }),
    };
  }

  return make();
}
