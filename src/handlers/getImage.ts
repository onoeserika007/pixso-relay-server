/**
 * get_image handler.
 *
 * Writes Pixso's base64 PNG to disk and returns the file path instead of the
 * base64 string, so the upstream agent never has to decode/persist it.
 *
 *  Relay extension args:
 *    - outputDir?: string — custom target directory; must stay inside the
 *      workspace root (path-traversal protection).
 *
 * Cache: for the same (itemId + forwarded args) within image TTL, the already
 * written file is reused.
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { PixsoClient, ToolCallResult } from "../pixsoClient.js";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";

const EXT_KEYS = new Set(["outputDir"]);

export interface GetImageDeps {
  pixso: PixsoClient;
  logger: Logger;
  config: Config;
}

interface CachedImage {
  path: string;
  expiresAt: number;
}

const fileCache = new Map<string, CachedImage>();

export async function handleGetImage(
  args: Record<string, unknown> | undefined,
  deps: GetImageDeps
): Promise<ToolCallResult> {
  const { pixso, logger, config } = deps;
  const started = Date.now();

  const itemId =
    typeof args?.itemId === "string" && args.itemId.length > 0
      ? (args.itemId as string)
      : "<selection>";
  const customDir =
    typeof args?.outputDir === "string" && args.outputDir.length > 0
      ? (args.outputDir as string)
      : null;

  const forwardArgs: Record<string, unknown> = {};
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (!EXT_KEYS.has(k)) forwardArgs[k] = v;
    }
  }

  const log = logger.withFields({ tool: "get_image", itemId });

  // 1) cache check
  const cacheKey = buildCacheKey(itemId, forwardArgs, customDir);
  const now = Date.now();
  const cached = fileCache.get(cacheKey);
  if (cached && cached.expiresAt > now && existsSync(cached.path)) {
    log.info("file cache hit", {
      cacheHit: true,
      path: cached.path,
      durationMs: Date.now() - started,
    });
    return fileResult(cached.path);
  }
  if (cached) fileCache.delete(cacheKey);

  // 2) resolve & validate target directory
  let targetDir: string;
  try {
    targetDir = resolveSafeDir(customDir, config);
  } catch (err) {
    log.warn("outputDir rejected, falling back to default", {
      err: (err as Error).message,
    });
    targetDir = config.imageOutputDir;
  }
  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
  } catch (err) {
    log.error("failed to create output dir", {
      dir: targetDir,
      err: (err as Error).message,
    });
    // No dir to write into — passthrough base64 from Pixso so the upstream
    // caller still gets *something*.
    const downstream = await pixso.callTool("get_image", forwardArgs);
    return appendWarning(
      downstream,
      `relay: failed to create output dir "${targetDir}"; returned original base64`
    );
  }

  // 3) call downstream
  let downstream: ToolCallResult;
  try {
    downstream = await pixso.callTool("get_image", forwardArgs);
  } catch (err) {
    log.error("downstream get_image failed", {
      err: (err as Error).message,
      durationMs: Date.now() - started,
    });
    throw err;
  }

  // 4) extract base64
  const extracted = extractBase64Png(downstream);
  if (!extracted) {
    log.warn("no base64 image in downstream response → passthrough", {
      durationMs: Date.now() - started,
    });
    return appendWarning(
      downstream,
      "relay: could not find base64 image in Pixso response; returned original payload"
    );
  }

  // 5) write to disk
  const fileName = `${safeFileToken(itemId)}_${Date.now()}.png`;
  const filePath = resolve(targetDir, fileName);
  try {
    writeFileSync(filePath, extracted.buffer);
  } catch (err) {
    log.error("failed to write image file, falling back to base64", {
      path: filePath,
      err: (err as Error).message,
    });
    return appendWarning(
      downstream,
      `relay: failed to write "${filePath}"; returned original base64`
    );
  }

  fileCache.set(cacheKey, {
    path: filePath,
    expiresAt: Date.now() + config.imageTtlMs,
  });

  log.info("image written", {
    cacheHit: false,
    path: filePath,
    bytes: extracted.buffer.length,
    durationMs: Date.now() - started,
  });

  return fileResult(filePath);
}

// ---------- helpers ----------

function fileResult(absPath: string): ToolCallResult {
  // Use MCP `resource_link` so we only point at the file on disk without
  // embedding its bytes. `resource_link` requires `name` + `uri`; `resource`
  // would require `text` or `blob` inline, which defeats the purpose.
  const uri = pathToFileURL(absPath).href;
  const name = absPath.split(/[\\/]/).pop() ?? "image.png";
  return {
    content: [
      { type: "text", text: absPath },
      {
        type: "resource_link",
        name,
        uri,
        mimeType: "image/png",
        description: "PNG image written by pixso-relay",
      },
    ],
  };
}

function appendWarning(res: ToolCallResult, warning: string): ToolCallResult {
  const content = Array.isArray(res?.content) ? [...res.content] : [];
  content.push({ type: "text", text: warning });
  return { ...res, content };
}

function buildCacheKey(
  itemId: string,
  args: Record<string, unknown>,
  customDir: string | null
): string {
  const h = createHash("sha1");
  h.update(itemId);
  h.update("|");
  h.update(customDir ?? "");
  h.update("|");
  h.update(JSON.stringify(args, Object.keys(args).sort()));
  return h.digest("hex");
}

function safeFileToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "node";
}

function resolveSafeDir(customDir: string | null, config: Config): string {
  if (!customDir) return config.imageOutputDir;
  const resolved = isAbsolute(customDir)
    ? resolve(customDir)
    : resolve(config.workspaceRoot, customDir);
  const rel = relative(config.workspaceRoot, resolved);
  if (rel.startsWith("..") || (isAbsolute(rel) && rel !== "")) {
    throw new Error(
      `outputDir "${customDir}" escapes workspace root (${config.workspaceRoot})`
    );
  }
  // On Windows, relative() of an absolute path on another drive starts with
  // the drive letter and is not caught by the `..` check — handle explicitly.
  if (rel.includes(`..${sep}`)) {
    throw new Error(
      `outputDir "${customDir}" escapes workspace root (${config.workspaceRoot})`
    );
  }
  return resolved;
}

/**
 * Extract base64 PNG data from the Pixso response. Supports either an
 * `image` content entry (MCP standard) or a `text` entry containing a data
 * URI / raw base64.
 */
function extractBase64Png(
  res: ToolCallResult
): { buffer: Buffer } | null {
  const arr = res?.content;
  if (!Array.isArray(arr)) return null;
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    // MCP image content: { type: "image", data: "<base64>", mimeType: "..." }
    if (e.type === "image" && typeof e.data === "string") {
      const buf = safeBase64Decode(e.data);
      if (buf) return { buffer: buf };
    }

    // Some Pixso flavors embed it as text
    if (e.type === "text" && typeof e.text === "string") {
      const text = e.text.trim();
      const dataUriMatch = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(
        text
      );
      if (dataUriMatch) {
        const buf = safeBase64Decode(dataUriMatch[1]!);
        if (buf) return { buffer: buf };
      } else if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 64) {
        // Heuristic: long pure base64 body
        const buf = safeBase64Decode(text);
        if (buf) return { buffer: buf };
      }
    }
  }
  return null;
}

function safeBase64Decode(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
