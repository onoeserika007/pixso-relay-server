/**
 * Downstream client wrapper around the Pixso native MCP service.
 *
 * Responsibilities:
 * - Lazy connect + reconnect on demand.
 * - Retry with exponential backoff (max 2 retries).
 * - Hard-block any attempt to call `get_export_image` (known to hang Pixso).
 * - Expose simple `callTool` / `listTools` helpers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "./logger.js";

export const DISABLED_TOOL = "get_export_image";

export class ToolDisabledError extends Error {
  constructor(tool: string) {
    super(
      `Tool "${tool}" is disabled by the relay server (it hangs Pixso).`
    );
    this.name = "ToolDisabledError";
  }
}

export interface PixsoClientOptions {
  url: string;
  logger: Logger;
  /** Max retries on transient failures (total attempts = retries + 1). Default 2. */
  retries?: number;
  /** Base backoff ms. Default 250. */
  backoffBaseMs?: number;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** MCP `tools/call` result shape we care about. */
export interface ToolCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: unknown;
  [extra: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class PixsoClient {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly retries: number;
  private readonly backoffBaseMs: number;

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<void> | null = null;

  constructor(opts: PixsoClientOptions) {
    this.url = opts.url;
    this.logger = opts.logger.withFields({ mod: "pixso-client" });
    this.retries = opts.retries ?? 2;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
  }

  /** Ensure the client is connected; safe to call concurrently. */
  async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.url));
      const client = new Client(
        { name: "pixso-relay-client", version: "0.1.0" },
        { capabilities: {} }
      );
      try {
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        this.logger.info("connected to pixso mcp", { url: this.url });
      } catch (err) {
        this.logger.error("failed to connect to pixso mcp", {
          url: this.url,
          err: (err as Error).message,
        });
        // swallow transport references so next call retries from scratch
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /** Drop the current session so the next call will reconnect. */
  private async invalidateConnection(): Promise<void> {
    const t = this.transport;
    this.client = null;
    this.transport = null;
    if (t) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
  }

  async listTools(): Promise<ToolInfo[]> {
    return this.withRetry(async () => {
      await this.ensureConnected();
      // No local timeout: Pixso decides when to give up and reports it as
      // an McpError (RequestTimeout, code -32001), which we fast-fail in
      // withRetry. Adding our own AbortSignal on top just fights with that.
      const res = await this.client!.listTools();
      return (res.tools ?? []) as unknown as ToolInfo[];
    }, "listTools");
  }

  async callTool(
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<ToolCallResult> {
    if (name === DISABLED_TOOL) {
      throw new ToolDisabledError(name);
    }
    return this.withRetry(async () => {
      await this.ensureConnected();
      // No local timeout: see listTools() above.
      const res = await this.client!.callTool({
        name,
        arguments: args ?? {},
      });
      return res as unknown as ToolCallResult;
    }, `callTool:${name}`);
  }

  async close(): Promise<void> {
    await this.invalidateConnection();
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.retries) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);

        // Upstream-reported JSON-RPC errors (McpError, code === -32001 for
        // RequestTimeout, and any other well-formed -320xx code). These come
        // from the Pixso MCP server's own error response, which means the
        // transport is fine and the session is fine — retrying the exact same
        // request will just make Pixso time itself out again. Fail fast.
        if (err instanceof McpError) {
          this.logger.warn(`${label} failed`, {
            attempt,
            err: errMsg,
            name: errName || undefined,
            mcpCode: err.code,
            upstreamTimeout: err.code === ErrorCode.RequestTimeout,
            transient: false,
            policy: "no-retry-upstream-mcp-error",
          });
          throw err;
        }

        // Local transport / abort issues: worth retrying. These include our
        // own AbortSignal.timeout firing (local fetch-level timeout), fetch
        // network errors, socket hang up, etc.
        const isTransient =
          /AbortError|TimeoutError/i.test(errName) ||
          /fetch failed|ECONN|socket hang up|network|timeout|closed|aborted/i.test(
            errMsg
          );
        this.logger.warn(`${label} failed`, {
          attempt,
          err: errMsg,
          name: errName || undefined,
          transient: isTransient,
        });
        // drop connection only on transport-ish errors; keep session otherwise
        if (isTransient) {
          await this.invalidateConnection();
        }
        if (attempt === this.retries) break;
        const backoff = this.backoffBaseMs * 2 ** attempt;
        await sleep(backoff);
        attempt += 1;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`${label} failed: ${String(lastErr)}`);
  }
}
