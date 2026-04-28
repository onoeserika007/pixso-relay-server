/**
 * Entry point: load config → build logger → build Pixso client → start relay
 * server → connect to Pixso → run bootstrap (wait for a valid root DSL) →
 * handle graceful shutdown.
 */

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PixsoClient } from "./pixsoClient.js";
import { startRelayServer } from "./relayServer.js";
import { runBootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const config = loadConfig(process.cwd());
  const logger = createLogger(config.logLevel);

  logger.info("starting pixso relay", {
    port: config.port,
    pixsoMcpUrl: config.pixsoMcpUrl,
    dslTtlMs: config.dslTtlMs,
    imageTtlMs: config.imageTtlMs,
    imageOutputDir: config.imageOutputDir,
    bootstrapRetryDelayMs: config.bootstrapRetryDelayMs,
  });

  const pixso = new PixsoClient({
    url: config.pixsoMcpUrl,
    logger,
  });

  const handles = await startRelayServer({ config, logger, pixso });

  // ---- bootstrap: block tool calls until Pixso has a valid root selected ----
  // We do NOT await this eagerly at the top of main() because we want the
  // HTTP server (and /healthz) up first; readiness is gated inside the MCP
  // request handler itself.
  let bootstrapping = true;
  runBootstrap({
    config,
    logger,
    pixso,
    cache: handles.cache,
    readiness: handles.readiness,
  })
    .catch((err) => {
      // runBootstrap only throws on truly fatal errors; we still want the
      // process to stay up so the user can see what's going on.
      logger.error("bootstrap aborted with a fatal error", {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
    })
    .finally(() => {
      bootstrapping = false;
    });

  // ---- graceful shutdown ----
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`, { bootstrapping });
    try {
      await handles.close();
    } catch (err) {
      logger.error("error while closing http/mcp server", {
        err: (err as Error).message,
      });
    }
    try {
      await pixso.close();
    } catch (err) {
      logger.error("error while closing pixso client", {
        err: (err as Error).message,
      });
    }
    // tiny delay so the last log flushes
    setTimeout(() => process.exit(0), 50);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", { err: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: String(reason) });
  });
}

main().catch((err) => {
  // Fall back to raw console because logger may not be ready.
  // eslint-disable-next-line no-console
  console.error("[pixso-relay] fatal startup error:", err);
  process.exit(1);
});
