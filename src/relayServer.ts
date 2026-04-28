/**
 * Upstream MCP server: exposes the relayed Pixso tools over Streamable HTTP at
 * `/mcp`, compatible with the VSCode HTTP MCP client.
 *
 * Tool surface is intentionally whitelisted to exactly the two wrapped tools
 * the relay exists to serve:
 *   - `get_node_dsl` (tree-indexed, sanitized, with relay-specific semantics)
 *   - `get_image`   (base64 → file path on disk)
 * Every other tool upstream exposes (including `get_export_image`, which
 * hangs Pixso) is hidden from `tools/list` and rejected on `tools/call`.
 *
 * Tool descriptions / input schemas are also overridden here so the upstream
 * agent sees relay-specific semantics (e.g. `itemId` being resolved against
 * an already-indexed root tree, relay extensions like `refresh` / `raw`,
 * `get_image` returning a file path instead of base64, etc.).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import express from "express";
import type { Request, Response } from "express";
import type { Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { PixsoClient } from "./pixsoClient.js";
import { TreeCache } from "./utils/treeCache.js";
import { routeToolCall, ALLOWED_TOOLS } from "./handlers/index.js";
import type { ReadinessState } from "./bootstrap.js";

/**
 * Relay-owned tool descriptions. These replace whatever upstream Pixso sends
 * in `tools/list` so the MCP client sees the actual wrapped semantics.
 */
const TOOL_OVERRIDES: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  get_node_dsl: {
    description:
      "Return the sanitized Pixso DSL for the indexed root tree or a specific node within it.\n\n" +
      "Behavior:\n" +
      "  • If `itemId` is omitted, returns the full DSL of the root frame that was indexed at startup " +
      "(the frame the operator explicitly confirmed in Pixso). Does NOT look at the current Pixso selection.\n" +
      "  • If `itemId` is provided, looks it up inside the cached root tree and returns that sub-node's DSL." +
      " The relay never forwards sub-node ids to Pixso (the upstream call is unreliable for sub-nodes).\n" +
      "  • If the requested `itemId` is not present in the cached tree, an error is returned; pass " +
      "`refresh: true` to rebuild the cache from Pixso's current selection.\n\n" +
      "Output: `content[0].text` is a JSON string of the form `{ \"pixTreeNodes\": [ ... ] }`.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description:
            "Optional guid of a node inside the indexed root tree. Omit to get the whole root DSL.",
        },
        clientFrameworks: {
          type: "string",
          description: "Forwarded to Pixso unchanged (e.g. 'html').",
        },
        refresh: {
          type: "boolean",
          description:
            "Relay extension. If true, the root tree is rebuilt from Pixso's current selection before resolving.",
        },
        raw: {
          type: "boolean",
          description:
            "Relay extension. If true, skip the relay's DSL sanitizer and return the raw upstream fields.",
        },
      },
      additionalProperties: false,
    },
  },
  get_image: {
    description:
      "Capture an image of a Pixso node and write it to disk. Unlike the upstream tool this does NOT " +
      "return a base64 string — it writes a PNG to the relay's cache directory and returns its absolute " +
      "file path in `content[0].text` (plus metadata in `structuredContent`). `itemId` is required.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "Guid of the node to capture (required).",
        },
        clientFrameworks: {
          type: "string",
          description: "Forwarded to Pixso unchanged (e.g. 'html').",
        },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
};

export interface RelayServerDeps {
  config: Config;
  logger: Logger;
  pixso: PixsoClient;
}

export interface RelayServerHandles {
  httpServer: HttpServer;
  /** Shared tree cache, exposed so bootstrap can seed it. */
  cache: TreeCache;
  /** Shared readiness state, flipped by bootstrap once a valid root is indexed. */
  readiness: ReadinessState;
  /** Closes everything: HTTP server, MCP transports, Pixso client. */
  close: () => Promise<void>;
}

const PROTOCOL_VERSION = "2024-11-05";

export async function startRelayServer(
  deps: RelayServerDeps
): Promise<RelayServerHandles> {
  const { config, logger, pixso } = deps;
  const cache = new TreeCache({
    max: config.dslCacheMax,
    ttlMs: config.dslTtlMs,
  });

  // Readiness is flipped to `true` by bootstrap once a valid root DSL has
  // been indexed. Until then tool calls are rejected with a clear message.
  const readiness: ReadinessState = {
    ready: false,
    message: "starting",
    indexedNodes: 0,
  };

  // ---- MCP Server factory ----
  //
  // Why a factory (and not a single shared `Server`): the MCP SDK's `Server`
  // class holds a single transport field internally — calling `.connect()` on
  // it twice throws `"Already connected to a transport. Call close() before
  // connecting to a new transport, or use a separate Protocol instance per
  // connection."`. To serve multiple concurrent MCP clients we therefore need
  // one `Server` per session, paired with its own transport.
  //
  // The heavy stuff (pixso client, tree cache, readiness flag, config, logger)
  // is captured from the outer closure and *shared across sessions* — that's
  // exactly what we want: every client sees the same indexed root tree, same
  // readiness state, same upstream Pixso connection. The per-session object
  // is just the thin MCP protocol surface.
  function createMcpServer(): Server {
    const server = new Server(
      { name: "pixso-relay", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Relay advertises ONLY the whitelisted, wrapped tools with relay-owned
      // descriptions / schemas. We do not proxy Pixso's own tool list — the
      // whole point of this relay is to narrow and reshape the surface.
      const tools = ALLOWED_TOOLS.map((name) => ({
        name,
        description: TOOL_OVERRIDES[name].description,
        inputSchema: TOOL_OVERRIDES[name].inputSchema,
      }));
      logger.debug("tools/list", { count: tools.length });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      // Whitelist gate: reject anything outside the relay's published surface.
      // This blocks `get_export_image` and every other upstream-only tool from
      // being reachable through the relay.
      if (!ALLOWED_TOOLS.includes(name as (typeof ALLOWED_TOOLS)[number])) {
        logger.warn("tool call rejected: not in relay whitelist", { tool: name });
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Tool "${name}" is not exposed by the relay. Allowed tools: ${ALLOWED_TOOLS.join(", ")}.`
        );
      }

      // Bootstrap gate: no tool calls until a root tree has been indexed. We
      // return a structured tool-result error (not a protocol error) so the
      // upstream agent gets a clear, human-readable reason rather than a raw
      // JSON-RPC failure.
      if (!readiness.ready) {
        logger.warn("tool call rejected: relay not ready", {
          tool: name,
          state: readiness.message,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `relay: not ready yet — ${readiness.message}. ` +
                `Please open Pixso, select the root frame/画板 you want to work with, ` +
                `and wait for the relay to finish indexing.`,
            },
          ],
        };
      }

      return routeToolCall(name, args, {
        pixso,
        cache,
        logger,
        config,
      });
    });

    return server;
  }

  // ---- HTTP (Express) ----
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Stateful Streamable HTTP: keep one transport **and one MCP Server** per
  // Mcp-Session-Id. On `initialize`, we mint a new session id, spin up a
  // fresh Server + transport pair, wire them together via `server.connect()`,
  // and remember both. All subsequent requests carry the `Mcp-Session-Id`
  // header and are routed to their existing transport. The per-session
  // Server is a cheap object — all heavy state (pixso client, cache,
  // readiness) is shared via closure, so concurrent clients all see the
  // same indexed tree.
  interface Session {
    transport: StreamableHTTPServerTransport;
    server: Server;
  }
  const sessions = new Map<string, Session>();

  async function handleMcp(req: Request, res: Response): Promise<void> {
    try {
      const sessionId =
        (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — reuse its transport.
        transport = sessions.get(sessionId)!.transport;
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        // New session — mint a fresh (Server, transport) pair.
        const server = createMcpServer();
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newId: string) => {
            sessions.set(newId, { transport: newTransport, server });
            logger.info("mcp session opened", {
              sessionId: newId,
              totalSessions: sessions.size,
            });
          },
        });

        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            // Release the per-session Server too.
            server.close().catch(() => {
              /* best effort */
            });
            logger.info("mcp session closed", {
              sessionId: sid,
              totalSessions: sessions.size,
            });
          }
        };

        await server.connect(newTransport);
        transport = newTransport;
      } else {
        // No session id and not an initialize — reject per spec.
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: no valid session id (initialize first to obtain Mcp-Session-Id).",
          },
          id: null,
        });
        return;
      }

      await transport!.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (err) {
      logger.error(`${req.method} /mcp failed`, {
        err: (err as Error).message,
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  }

  // POST: regular JSON-RPC traffic (initialize, tools/list, tools/call, ...).
  app.post("/mcp", handleMcp);
  // GET: SSE stream for server->client notifications.
  app.get("/mcp", handleMcp);
  // DELETE: client-initiated session termination.
  app.delete("/mcp", handleMcp);

  // Lightweight health probe
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      ready: readiness.ready,
      state: readiness.message,
      indexedNodes: readiness.indexedNodes,
    });
  });

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.port, () => resolve(server));
    server.once("error", reject);
  });
  logger.info(`Pixso Relay listening on :${config.port}`, {
    port: config.port,
  });

  async function close(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      httpServer.close(() => resolvePromise());
    });
    // Tear down all live sessions (transport + per-session Server).
    for (const [, { transport, server }] of sessions) {
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
    sessions.clear();
    cache.clear();
  }

  return { httpServer, cache, readiness, close };
}
