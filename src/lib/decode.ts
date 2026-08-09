/** Decoding window.__PAGE_MODEL.
 *
 *  Rightmove ships the listing as { data: "<json>", encoding: "on" }. When encoding is on, the
 *  parsed data is a FLAT ARRAY of nodes and every object value is an index into that array
 *  rather than the value itself. Miss this and you silently get integers where you expected
 *  objects. See RESEARCH.md §2.
 */

export interface PageModel {
  data?: unknown;
  encoding?: string;
}

type Nodes = unknown[];

function resolve(nodes: Nodes, idx: unknown, depth = 0): unknown {
  // Rightmove's graph is shallow; a cycle would mean our index assumption is wrong, and looping
  // forever is a worse failure than giving up.
  if (depth > 64) throw new Error('__PAGE_MODEL nesting exceeded 64 levels — encoding changed?');
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= nodes.length) {
    // Not a reference: encoding-off payloads and out-of-range values are literals.
    return idx;
  }
  const node = nodes[idx];
  if (Array.isArray(node)) return node.map((i) => resolve(nodes, i, depth + 1));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, resolve(nodes, v, depth + 1)]),
    );
  }
  return node;
}

/** Turn a raw window.__PAGE_MODEL value into the decoded propertyData object. Throws on any
 *  shape we don't recognise — the caller renders that message in the panel. */
export function decodePageModel(model: unknown): Record<string, unknown> {
  if (!model || typeof model !== 'object') throw new Error('__PAGE_MODEL missing or not an object');
  const { data, encoding } = model as PageModel;

  // encoding "off" (or absent) means data is already a plain object.
  if (encoding !== 'on') {
    const plain = typeof data === 'string' ? JSON.parse(data) : (data ?? model);
    const property = (plain as Record<string, unknown>)?.propertyData;
    if (!property || typeof property !== 'object') {
      throw new Error('unencoded __PAGE_MODEL had no propertyData');
    }
    return property as Record<string, unknown>;
  }

  if (typeof data !== 'string') throw new Error('__PAGE_MODEL.encoding is "on" but data is not a string');
  const nodes = JSON.parse(data) as Nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('__PAGE_MODEL.data is not a node array');

  const root = nodes[0];
  if (!root || typeof root !== 'object') throw new Error('__PAGE_MODEL node 0 is not an object');
  const ref = (root as Record<string, unknown>).propertyData;
  if (ref === undefined) throw new Error('__PAGE_MODEL root has no propertyData reference');

  const property = resolve(nodes, ref);
  if (!property || typeof property !== 'object') throw new Error('propertyData did not resolve to an object');
  return property as Record<string, unknown>;
}
