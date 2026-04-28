/**
 * DSL sanitizer — produces a *wireframe* ("白模") projection of a Pixso tree.
 *
 * Philosophy: whitelist, not blacklist.
 *   We aggressively drop anything that isn't needed to describe the structural
 *   skeleton of a design: shape, size, position, hierarchy, text content,
 *   and coarse layout intent. Fills, strokes, effects, gradients, images,
 *   component/publish metadata, variable bindings, font styling details —
 *   all gone. What's left is enough for an AI agent to reason about layout
 *   and generate wireframe-level code, and nothing more.
 *
 * Positional model:
 *   Pixso nodes carry `top` / `left` / `width` / `height` in the parent's
 *   coordinate system. That is how a child's position relative to its parent
 *   is expressed — there is no node-level `transform` matrix to preserve.
 */

import type { PixsoNode } from "./dslIndex.js";

/**
 * Node-level fields copied verbatim (when present). We deliberately do NOT
 * drop "default-looking" values here (e.g. `rotation: 0`, `visible: true`):
 * for a node field, "field absent" vs "field present but zero/true" should
 * not be conflated — it's confusing for downstream agents. So it's simple:
 * if the source node has the key, we keep the value; if not, it's absent.
 *
 * Note: `guid` in particular is always preserved — downstream tools such as
 * `get_image` address nodes by guid.
 */
const NODE_KEEP: string[] = [
  "guid",
  "name",
  "type",
  "width",
  "height",
  "top",
  "left",
  "rotation",
  "visible",
  "nodeText",
  "fontSize",
  "textAutoResize",
];

/** autoLayout sub-keys we keep (again, whitelist). */
const AUTOLAYOUT_KEEP: Array<{ key: string; dropIfEq?: unknown }> = [
  { key: "stackMode", dropIfEq: "NONE" },
  { key: "autoLayoutDirection" },
  { key: "autoLayoutPaddingTop", dropIfEq: 0 },
  { key: "autoLayoutPaddingBottom", dropIfEq: 0 },
  { key: "autoLayoutPaddingLeft", dropIfEq: 0 },
  { key: "autoLayoutPaddingRight", dropIfEq: 0 },
  { key: "autoLayoutItemSpacing", dropIfEq: 0 },
  { key: "autoLayoutCounterItemSpacing", dropIfEq: 0 },
];

function copyNodeFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (!(key in source)) continue;
    const v = source[key];
    if (v === undefined || v === null) continue;
    target[key] = v;
  }
}

function copyAutoLayoutFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  rules: ReadonlyArray<{ key: string; dropIfEq?: unknown }>
): void {
  for (const { key, dropIfEq } of rules) {
    if (!(key in source)) continue;
    const v = source[key];
    if (v === undefined || v === null) continue;
    if (dropIfEq !== undefined && v === dropIfEq) continue;
    target[key] = v;
  }
}

function simplifyAutoLayout(al: unknown): Record<string, unknown> | undefined {
  if (!al || typeof al !== "object") return undefined;
  const out: Record<string, unknown> = {};
  copyAutoLayoutFields(al as Record<string, unknown>, out, AUTOLAYOUT_KEEP);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Recursively reduce a Pixso DSL node to its wireframe essentials.
 * Returns a brand-new object — the source is not mutated.
 */
export function sanitizeNode(node: PixsoNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  copyNodeFields(node as Record<string, unknown>, out, NODE_KEEP);

  // autoLayout — structural intent for frames.
  const al = simplifyAutoLayout((node as Record<string, unknown>).autoLayout);
  if (al) out.autoLayout = al;

  // childNode — recurse. Skip if empty.
  const children = (node as Record<string, unknown>).childNode;
  if (Array.isArray(children) && children.length > 0) {
    out.childNode = (children as PixsoNode[]).map((c) => sanitizeNode(c));
  }

  return out;
}

/**
 * Sanitize an entire root DSL (`{ pixTreeNodes: [...] }`).
 * The top-level variable / style maps are all dropped as well.
 */
export function sanitizeRoot(root: {
  pixTreeNodes: PixsoNode[];
  [k: string]: unknown;
}): Record<string, unknown> {
  return {
    pixTreeNodes: root.pixTreeNodes.map((n) => sanitizeNode(n)),
  };
}
