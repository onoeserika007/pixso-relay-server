/**
 * Tool call router.
 *
 * Surface is whitelisted: only `get_node_dsl` and `get_image` are reachable
 * through the relay. `relayServer` already enforces this at the MCP layer;
 * this module is the defense-in-depth fallback.
 *
 *  - `get_node_dsl` \u2192 served from the bootstrap-indexed root tree
 *  - `get_image`    \u2192 base64 \u2192 file path
 *  - anything else  \u2192 rejected with MethodNotFound
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import type { PixsoClient, ToolCallResult } from "../pixsoClient.js";
import { ToolDisabledError } from "../pixsoClient.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import type { TreeCache } from "../utils/treeCache.js";

import { handleGetNodeDsl } from "./getNodeDsl.js";
import { handleGetImage } from "./getImage.js";

/** The exhaustive set of tools the relay exposes. */
export const ALLOWED_TOOLS = ["get_node_dsl", "get_image"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export interface RouterDeps {
  pixso: PixsoClient;
  cache: TreeCache;
  logger: Logger;
  config: Config;
}

export async function routeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  deps: RouterDeps
): Promise<ToolCallResult> {
  if (!ALLOWED_TOOLS.includes(name as AllowedTool)) {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Tool "${name}" is not exposed by the relay. Allowed tools: ${ALLOWED_TOOLS.join(", ")}.`
    );
  }

  try {
    switch (name as AllowedTool) {
      case "get_node_dsl":
        return await handleGetNodeDsl(args, {
          pixso: deps.pixso,
          cache: deps.cache,
          logger: deps.logger,
        });
      case "get_image":
        return await handleGetImage(args, {
          pixso: deps.pixso,
          logger: deps.logger,
          config: deps.config,
        });
    }
  } catch (err) {
    if (err instanceof ToolDisabledError) {
      throw new McpError(ErrorCode.MethodNotFound, err.message);
    }
    throw err;
  }

  // Unreachable given the whitelist check above; satisfies TS exhaustiveness.
  throw new McpError(ErrorCode.MethodNotFound, `Unhandled tool "${name}".`);
}
