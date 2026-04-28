# Pixso Relay Server

A **VSCode HTTP MCP**-compliant relay server that sits in front of the native Pixso desktop MCP service, providing:

1. **Root-node caching & index tree rebuild** — Pixso MCP flakes when querying sub-nodes directly; this relay fetches the root DSL once, parses the JSON string inside `content[0].text`, and builds an in-memory `Map<guid, node>` index so every later sub-node query hits the cache deterministically.
2. **DSL sanitization** — strips `variablesAlias`, `transform` matrices, default `blendMode`, `svgSha`, `inset`, `frameMaskDisabled`, and other low-level fields the upstream AI agent does not need; compresses RGB floats to `#RRGGBB[AA]`.
3. **Image-as-file response** — `get_image` no longer returns base64 strings; the relay writes the decoded PNG to disk and returns an absolute file path (plus a `file://` resource).

> ⚠️ **`get_export_image` is permanently disabled** by this relay because it hangs Pixso. It is filtered out of `tools/list` and rejected at `tools/call` with `-32601`.

---

## Requirements

- Node.js **≥ 18**
- A running Pixso desktop app exposing its native MCP service (default: `http://127.0.0.1:3667/mcp`)

## Install

```bash
npm install
```

## Run

```bash
# dev (hot-reload with tsx)
npm run dev

# production
npm run build
npm start
```

On startup you should see:

```
Pixso Relay listening on :3100
Pixso MCP: connected (http://127.0.0.1:3667/mcp)
```

## Configuration

Priority: **environment variables > `./relay.config.json` > defaults**.

Supported keys:

| Key | Env var | Default | Purpose |
|---|---|---|---|
| `port` | `RELAY_PORT` | `3100` | HTTP port |
| `pixsoMcpUrl` | `PIXSO_MCP_URL` | `http://127.0.0.1:3667/mcp` | Downstream Pixso MCP endpoint |
| `dslTtlMs` | `RELAY_DSL_TTL_MS` | `300000` | Node index TTL (5 min) |
| `imageTtlMs` | `RELAY_IMAGE_TTL_MS` | `60000` | Image file reuse TTL (60 s) |
| `imageOutputDir` | `RELAY_IMAGE_DIR` | `./.pixso-cache/images` | Where `get_image` writes PNGs |
| `logLevel` | `RELAY_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

Example `relay.config.json`:

```json
{
  "port": 3100,
  "pixsoMcpUrl": "http://127.0.0.1:3667/mcp",
  "dslTtlMs": 300000,
  "imageTtlMs": 60000,
  "imageOutputDir": "./.pixso-cache/images",
  "logLevel": "info"
}
```

## VSCode MCP integration

Add this to your VSCode `settings.json`:

```json
{
  "mcp.servers": {
    "pixso-relay": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

## Exposed tools

All Pixso tools are forwarded **except** `get_export_image`. Two of them are specially wrapped:

| Tool | Behavior |
|---|---|
| `get_node_dsl` | Cached, tree-indexed, sanitized. Accepts extra optional flags `refresh:boolean` (force rebuild) and `raw:boolean` (skip sanitization). |
| `get_image` | Decodes base64 → writes PNG to disk → returns `{type:"text", text:<absolutePath>}` + `{type:"resource", resource:{uri:"file://..."}}`. Accepts extra optional flag `outputDir` (must stay inside the workspace). |
| `get_export_image` | **Disabled** — hangs Pixso. Call returns `-32601`. |
| all others | Transparent passthrough. |

## License

Internal / unreleased.
