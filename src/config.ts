/**
 * Runtime configuration loader.
 *
 * Priority: environment variables > ./relay.config.json > defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  /** Upstream HTTP port this relay listens on. */
  port: number;
  /** Downstream Pixso MCP endpoint URL. */
  pixsoMcpUrl: string;
  /** DSL index TTL in ms. */
  dslTtlMs: number;
  /** Image file reuse TTL in ms. */
  imageTtlMs: number;
  /** Absolute directory where get_image writes PNG files. */
  imageOutputDir: string;
  /** Maximum number of DSL trees kept in the LRU cache. */
  dslCacheMax: number;
  /** Log level. */
  logLevel: LogLevel;
  /** Absolute path to the workspace root (used for outputDir safety checks). */
  workspaceRoot: string;
  /**
   * When the user confirms (presses Enter) but the Pixso selection turns out
   * to be empty / unreachable, wait this many ms before re-prompting. Purely
   * a tiny throttle so the retry prompt doesn't flash instantly.
   */
  bootstrapRetryDelayMs: number;
}

const DEFAULTS: Omit<Config, "workspaceRoot"> = {
  port: 3100,
  pixsoMcpUrl: "http://127.0.0.1:3667/mcp",
  dslTtlMs: 5 * 60 * 1000,
  imageTtlMs: 60 * 1000,
  imageOutputDir: "./.pixso-cache/images",
  dslCacheMax: 3,
  logLevel: "info",
  bootstrapRetryDelayMs: 500,
};

function parseIntEnv(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseLogLevel(v: string | undefined): LogLevel | undefined {
  if (!v) return undefined;
  const low = v.toLowerCase();
  if (low === "debug" || low === "info" || low === "warn" || low === "error") {
    return low;
  }
  return undefined;
}

export function loadConfig(workspaceRoot: string = process.cwd()): Config {
  // 1) file
  let fileCfg: Partial<Config> = {};
  const cfgPath = resolve(workspaceRoot, "relay.config.json");
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf8");
      fileCfg = JSON.parse(raw) as Partial<Config>;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] failed to parse ${cfgPath}, falling back to defaults:`,
        (err as Error).message
      );
    }
  }

  // 2) env
  const envCfg: Partial<Config> = {
    port: parseIntEnv(process.env.RELAY_PORT),
    pixsoMcpUrl: process.env.PIXSO_MCP_URL,
    dslTtlMs: parseIntEnv(process.env.RELAY_DSL_TTL_MS),
    imageTtlMs: parseIntEnv(process.env.RELAY_IMAGE_TTL_MS),
    imageOutputDir: process.env.RELAY_IMAGE_DIR,
    dslCacheMax: parseIntEnv(process.env.RELAY_DSL_CACHE_MAX),
    logLevel: parseLogLevel(process.env.RELAY_LOG_LEVEL),
    bootstrapRetryDelayMs: parseIntEnv(process.env.RELAY_BOOTSTRAP_RETRY_MS),
  };

  const merged: Config = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(fileCfg).filter(([, v]) => v !== undefined)
    ),
    ...Object.fromEntries(
      Object.entries(envCfg).filter(([, v]) => v !== undefined)
    ),
    workspaceRoot,
  } as Config;

  // Resolve imageOutputDir to an absolute path inside workspace.
  merged.imageOutputDir = resolve(workspaceRoot, merged.imageOutputDir);

  return merged;
}