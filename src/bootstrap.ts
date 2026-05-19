/**
 * Startup bootstrap:
 *
 * Why this exists:
 *   Whether a given Pixso selection is "the right root" is entirely a user
 *   intent question — a designer can legitimately work with a frame that has
 *   3 children or one with 3000. There is no reliable programmatic way to
 *   tell "root" from "leaf" from inside the DSL. So we don't try.
 *
 * What we do instead:
 *   1. Print an explicit instruction to the operator asking them to select
 *      the frame they want to work on in Pixso.
 *   2. Wait for the operator to press Enter on stdin to confirm.
 *   3. Fetch `get_node_dsl` (no itemId = current Pixso selection). If the
 *      response contains a non-empty pixTreeNodes, we trust it as the root,
 *      cache it, and flip readiness.
 *   4. If the response is empty or unparseable (i.e. nothing was actually
 *      selected), we re-prompt and loop.
 *
 * Ctrl+C aborts at any time.
 */

import * as readline from "node:readline";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { PixsoClient, ToolCallResult } from "./pixsoClient.js";
import type { TreeCache } from "./utils/treeCache.js";
import { DslIndex, parseRootDsl } from "./utils/dslIndex.js";

/** Shared readiness flag flipped once a valid root tree has been indexed. */
export interface ReadinessState {
  ready: boolean;
  /** Human-readable summary of the current bootstrap state, for /healthz. */
  message: string;
  /** How many nodes got indexed on the last successful build. */
  indexedNodes: number;
}

export interface BootstrapDeps {
  config: Config;
  logger: Logger;
  pixso: PixsoClient;
  cache: TreeCache;
  readiness: ReadinessState;
}

/** Shared cache key for "the current Pixso selection root". */
export const ROOT_CACHE_KEY = "<selection>";

/**
 * Run the bootstrap loop. Returns only after the operator has confirmed a
 * selection and we've successfully indexed the resulting DSL.
 */
export async function runBootstrap(deps: BootstrapDeps): Promise<void> {
  const { config, logger, pixso, cache, readiness } = deps;
  const log = logger.withFields({ mod: "bootstrap" });

  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  try {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      readiness.message = `awaiting operator confirmation (attempt ${attempt})`;

      await promptConfirm(
        rl,
        attempt === 1
          ? "▶ Select the frame in Pixso, then press Enter to index it... "
          : "▶ Press Enter again once the selection is ready... "
      );

      readiness.message = "fetching root DSL from Pixso";
      process.stdout.write("  …fetching root DSL from Pixso\n");

      let res: ToolCallResult;
      try {
        res = await pixso.callTool("get_node_dsl", {});
      } catch (err) {
        const msg = (err as Error).message;
        process.stdout.write(
          `  ✗ Pixso call failed: ${msg}\n    Make sure Pixso is running and the MCP endpoint is reachable, then try again.\n`
        );
        log.warn("bootstrap: Pixso call failed", { attempt, err: msg });
        readiness.message = `not ready: Pixso call failed (${msg})`;
        await sleep(config.bootstrapRetryDelayMs);
        continue;
      }

      const outcome = evaluate(res, log);
      if (outcome.kind === "ok") {
        cache.set(ROOT_CACHE_KEY, outcome.index);
        readiness.ready = true;
        readiness.indexedNodes = outcome.index.size();
        readiness.message = `ready (indexed ${outcome.index.size()} nodes)`;
        process.stdout.write(
          `  ✓ Indexed ${outcome.index.size()} nodes from current Pixso selection — relay is ready.\n\n`
        );
        log.info("bootstrap complete", {
          attempt,
          indexedNodes: outcome.index.size(),
          rootCount: outcome.rootCount,
        });

        // DEBUG: list downstream Pixso tools to verify get_screenshot availability
        try {
          const tools = await pixso.listTools();
          const toolNames = tools.map((t) => t.name);
          process.stdout.write(
            `  ℹ Pixso downstream tools: ${toolNames.join(", ")}\n\n`
          );
          log.info("downstream tool list", { tools: toolNames });
          if (!toolNames.includes("get_screenshot")) {
            process.stdout.write(
              `  ⚠ WARNING: "get_screenshot" is NOT in the downstream tool list!\n` +
              `    Available tools: ${toolNames.join(", ")}\n\n`
            );
            log.warn("get_screenshot not found in downstream tools", { tools: toolNames });
          }
        } catch (err) {
          log.warn("failed to list downstream tools", {
            err: (err as Error).message,
          });
        }

        return;
      }

      // Retry.
      process.stdout.write(`  ✗ ${outcome.reason}\n`);
      process.stdout.write(
        `    (set logLevel to "debug" in relay.config.json for full response dump)\n`
      );
      log.warn("bootstrap: selection not usable", {
        attempt,
        reason: outcome.reason,
      });
      readiness.message = `not ready: ${outcome.reason}`;
      await sleep(config.bootstrapRetryDelayMs);
    }
  } finally {
    rl.close();
  }
}

// ---------- helpers ----------

type EvalOutcome =
  | { kind: "ok"; index: DslIndex; rootCount: number }
  | { kind: "retry"; reason: string };

/**
 * We intentionally do NOT apply any heuristic about tree size, node types or
 * child count — any non-empty pixTreeNodes from an operator-confirmed
 * selection is treated as a valid root. The operator is the ground truth.
 */
function evaluate(
  res: ToolCallResult,
  log?: ReturnType<Logger["withFields"]>
): EvalOutcome {
  const arr = res?.content;
  if (!Array.isArray(arr) || arr.length === 0) {
    log?.debug("evaluate: no content array", {
      hasContent: !!res?.content,
      contentType: typeof res?.content,
    });
    return {
      kind: "retry",
      reason: "Pixso returned no content — is anything selected?",
    };
  }

  // DEBUG: dump all content entries
  log?.debug("evaluate: content entries", {
    count: arr.length,
    entries: arr.map((e: Record<string, unknown>, i: number) => ({
      index: i,
      type: e?.type,
      textLength: typeof e?.text === "string" ? (e.text as string).length : undefined,
      textPreview:
        typeof e?.text === "string"
          ? (e.text as string).slice(0, 300) + ((e.text as string).length > 300 ? "..." : "")
          : undefined,
    })),
  });

  const first = arr[0] as { type?: string; text?: unknown };
  if (first?.type !== "text" || typeof first.text !== "string") {
    log?.debug("evaluate: content[0] is not text", {
      type: first?.type,
      keys: first ? Object.keys(first) : [],
    });
    return {
      kind: "retry",
      reason: "Pixso content[0] is not text — unexpected response shape",
    };
  }

  const root = parseRootDsl(first.text);
  if (!root) {
    // Determine whether it's a JSON parse error or a shape mismatch
    let parseError: string | null = null;
    try {
      const parsed = JSON.parse(first.text);
      // JSON is valid but shape is wrong
      parseError = `valid JSON but missing pixTreeNodes array. Top-level keys: ${Object.keys(parsed as object).join(", ")}`;
    } catch (e) {
      parseError = `JSON.parse failed: ${(e as Error).message}`;
    }
    log?.debug("evaluate: parseRootDsl returned null", {
      parseError,
      textLength: first.text.length,
      textPreview: first.text.slice(0, 500) + (first.text.length > 500 ? "..." : ""),
    });
    return {
      kind: "retry",
      reason: `Pixso response is not valid DSL JSON (${parseError})`,
    };
  }
  if (!Array.isArray(root.pixTreeNodes) || root.pixTreeNodes.length === 0) {
    return {
      kind: "retry",
      reason:
        "Pixso selection is empty (pixTreeNodes is []). Click a frame in Pixso, then press Enter.",
    };
  }
  const index = new DslIndex(root.pixTreeNodes);
  return { kind: "ok", index, rootCount: root.pixTreeNodes.length };
}

function printBanner(): void {
  const lines = [
    "",
    "================================================================",
    "  Pixso Relay — root selection required",
    "----------------------------------------------------------------",
    "  Open Pixso and click the frame / 画板 / component you want",
    "  the relay to index. Whatever you select IS the root — the",
    "  relay will not second-guess you.",
    "",
    "  Tool calls from MCP clients will be rejected until you",
    "  confirm a selection here.",
    "================================================================",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

function promptConfirm(rl: readline.Interface, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    rl.question(prompt, () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
