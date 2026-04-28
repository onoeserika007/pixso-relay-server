/**
 * In-memory index of a Pixso DSL tree keyed by node `guid`.
 *
 * The tree is described by the JSON inside `result.content[0].text` returned by
 * Pixso's `get_node_dsl`. Root nodes live in the `pixTreeNodes` array and every
 * node has a recursive `childNode` array.
 */

/** A Pixso DSL node (shape kept loose because upstream schema evolves). */
export interface PixsoNode {
  guid: string;
  name?: string;
  type?: string;
  childNode?: PixsoNode[];
  [extra: string]: unknown;
}

/** Parsed root DSL payload. */
export interface RootDsl {
  pixTreeNodes: PixsoNode[];
  [extra: string]: unknown;
}

export class DslIndex {
  private readonly map = new Map<string, PixsoNode>();
  /** Kept for raw=true debug mode. */
  readonly roots: PixsoNode[];

  constructor(roots: PixsoNode[]) {
    this.roots = roots;
    for (const root of roots) {
      this.walk(root);
    }
  }

  private walk(node: PixsoNode): void {
    if (node && typeof node.guid === "string") {
      this.map.set(node.guid, node);
    }
    const children = node?.childNode;
    if (Array.isArray(children)) {
      for (const c of children) this.walk(c);
    }
  }

  /** Returns the sub-tree rooted at `guid`, or undefined if not present. */
  get(guid: string): PixsoNode | undefined {
    return this.map.get(guid);
  }

  /** Check whether the index contains this guid. */
  has(guid: string): boolean {
    return this.map.has(guid);
  }

  /** Total indexed nodes — useful for logging. */
  size(): number {
    return this.map.size;
  }
}

/**
 * Parse the content[0].text string from Pixso's response into a RootDsl.
 * Returns null if the payload does not match the expected shape.
 */
export function parseRootDsl(text: string): RootDsl | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { pixTreeNodes?: unknown }).pixTreeNodes)
  ) {
    return parsed as RootDsl;
  }
  return null;
}
