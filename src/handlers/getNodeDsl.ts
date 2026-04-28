/**
 * get_node_dsl handler.
 *
 * Contract with bootstrap: by the time this handler ever runs, `runBootstrap`
 * has already seeded the TreeCache under key "<selection>" with whatever root
 * tree the operator confirmed. Tool calls are gated on readiness in the MCP
 * server, so an indexed tree always exists here.
 *
 * Whether a given selection is "really a root" is a user-intent question we
 * explicitly refuse to answer with heuristics — the operator's confirmation
 * is the ground truth. Same goes for `refresh: true`: if the caller asks us
 * to rebuild, we rebuild from whatever Pixso currently reports (as long as
 * it's non-empty); we don't second-guess the selection shape.
 *
 * Strategy:
 *  - Input args: { itemId?: string, clientFrameworks?: string }
 *    + relay extensions: { refresh?: boolean, raw?: boolean }
 *  - If `itemId` is omitted: return the sanitized DSL of the bootstrap root
 *    tree itself (the frame the operator confirmed at startup). We DO NOT
 *    fall back to "whatever is currently selected in Pixso" — the root has
 *    already been fixed by bootstrap and that is the canonical answer.
 *  - If `itemId` is present: look it up inside the cached root tree and
 *    return just that sub-node's DSL. We NEVER forward the sub-node id to
 *    Pixso — that's the upstream bug this relay exists to work around.
 *  - If `refresh: true`: re-fetch the root DSL from Pixso (get_node_dsl with
 *    NO itemId forwarded), replace the cached index on success; surface an
 *    error if the selection is empty (and keep the old tree).
 *  - If the requested guid isn't present: structured error telling the
 *    caller to try `refresh: true` or re-select a containing frame in Pixso.
 *
 * Output shape matches Pixso's: a `CallToolResult` with `content` where the
 * first entry is a `text` whose value is a stringified JSON containing
 * `pixTreeNodes: [ ... ]`.
 */

import type { PixsoClient, ToolCallResult } from "../pixsoClient.js";
import type { Logger } from "../logger.js";
import type { TreeCache } from "../utils/treeCache.js";
import { DslIndex, parseRootDsl, type PixsoNode } from "../utils/dslIndex.js";
import { sanitizeNode } from "../utils/dslSanitizer.js";
import { ROOT_CACHE_KEY } from "../bootstrap.js";

/** Relay-only extension args, stripped before forwarding to Pixso. */
const EXT_KEYS = new Set(["refresh", "raw", "itemId"]);

export interface GetNodeDslDeps {
  pixso: PixsoClient;
  cache: TreeCache;
  logger: Logger;
}

export async function handleGetNodeDsl(
  args: Record<string, unknown> | undefined,
  deps: GetNodeDslDeps
): Promise<ToolCallResult> {
  const { pixso, cache, logger } = deps;
  const started = Date.now();

  const itemId =
    typeof args?.itemId === "string" && args.itemId.length > 0
      ? (args.itemId as string)
      : null;
  const refresh = args?.refresh === true;
  const raw = args?.raw === true;

  // Everything forwarded to Pixso: drop relay-only keys AND `itemId` (we never
  // ask Pixso for a sub-node — it hangs).
  const rootFetchArgs: Record<string, unknown> = {};
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (!EXT_KEYS.has(k)) rootFetchArgs[k] = v;
    }
  }

  const log = logger.withFields({
    tool: "get_node_dsl",
    itemId: itemId ?? "<selection>",
  });

  // 1) Fast path: use the bootstrap-seeded tree.
  if (!refresh) {
    const existing = cache.get(ROOT_CACHE_KEY);
    if (existing) {
      return resolveFromIndex(existing, itemId, raw, log, started, {
        cacheHit: true,
      });
    }
    log.warn(
      "root cache missing (TTL expired?) — re-fetching from Pixso"
    );
  }

  // 2) (Re)build: fetch root DSL from Pixso; accept any non-empty response.
  let downstream: ToolCallResult;
  try {
    downstream = await pixso.callTool("get_node_dsl", rootFetchArgs);
  } catch (err) {
    log.error("downstream get_node_dsl (root) failed", {
      err: (err as Error).message,
      durationMs: Date.now() - started,
    });
    throw err;
  }
  const text = extractFirstText(downstream);
  const root = text ? parseRootDsl(text) : null;
  if (!root || !Array.isArray(root.pixTreeNodes) || root.pixTreeNodes.length === 0) {
    log.warn("refresh failed: Pixso returned empty or unparseable DSL", {
      durationMs: Date.now() - started,
    });
    return refreshError(
      "Pixso returned no DSL — make sure a frame is currently selected in Pixso before retrying"
    );
  }
  const freshIndex = new DslIndex(root.pixTreeNodes);
  cache.set(ROOT_CACHE_KEY, freshIndex);
  log.info("root tree (re)built", {
    indexedNodes: freshIndex.size(),
    rootCount: root.pixTreeNodes.length,
    durationMs: Date.now() - started,
  });

  return resolveFromIndex(freshIndex, itemId, raw, log, started, {
    cacheHit: false,
  });
}

// ---------- helpers ----------

function resolveFromIndex(
  index: DslIndex,
  itemId: string | null,
  raw: boolean,
  log: Logger,
  started: number,
  meta: { cacheHit: boolean }
): ToolCallResult {
  if (itemId) {
    const node = index.get(itemId);
    if (node) {
      const body = buildResponseBody([node], raw);
      log.info("tree lookup → hit", {
        cacheHit: meta.cacheHit,
        indexSize: index.size(),
        bytes: body.length,
        durationMs: Date.now() - started,
      });
      return textResult(body);
    }
    log.warn("guid not present in root tree", {
      indexSize: index.size(),
      durationMs: Date.now() - started,
    });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `relay: node "${itemId}" was not found in the current Pixso ` +
            `root tree (${index.size()} nodes indexed). ` +
            `If the user has re-selected a different frame in Pixso, retry ` +
            `with \`refresh: true\` to rebuild the tree. Otherwise ask them ` +
            `to select an ancestor frame that contains this node.`,
        },
      ],
    };
  }
  // No itemId → return whole root tree.
  const body = buildResponseBody(index.roots, raw);
  log.info("returned root selection", {
    cacheHit: meta.cacheHit,
    indexSize: index.size(),
    bytes: body.length,
    durationMs: Date.now() - started,
  });
  return textResult(body);
}

function refreshError(msg: string): ToolCallResult {
  return {
    isError: true,
    content: [{ type: "text", text: `relay: ${msg}` }],
  };
}

function extractFirstText(res: ToolCallResult): string | null {
  const arr = res?.content;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0] as { type?: string; text?: unknown };
  if (first?.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return null;
}

function buildResponseBody(roots: PixsoNode[], raw: boolean): string {
  const pixTreeNodes = raw
    ? roots
    : roots.map((r) => sanitizeNode(r) as PixsoNode);
  return JSON.stringify({ pixTreeNodes });
}

function textResult(text: string): ToolCallResult {
  return {
    content: [{ type: "text", text }],
  };
}
