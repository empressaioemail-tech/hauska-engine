/**
 * Engine node-type prefix registry — shared by evt_ and future wallet/token nodes.
 */

import {
  NODE_TYPE_PREFIXES,
  type NodeTypePrefix,
} from "@hauska-engine/atom-contract-pin/tce";

const REGISTERED = new Set<string>(NODE_TYPE_PREFIXES);

export function registerNodeTypePrefix(prefix: string): void {
  if (!prefix.endsWith("_")) {
    throw new Error(`Node type prefix must end with _: got "${prefix}"`);
  }
  REGISTERED.add(prefix);
}

export function isKnownNodeTypePrefix(prefix: string): prefix is NodeTypePrefix {
  return REGISTERED.has(prefix);
}

export function assertKnownNodePrefix(id: string): void {
  const prefix = NODE_TYPE_PREFIXES.find((p) => id.startsWith(p));
  if (!prefix) {
    throw new Error(
      `Unknown node id prefix on "${id}"; registered: ${[...REGISTERED].join(", ")}`,
    );
  }
}

export function listNodeTypePrefixes(): ReadonlyArray<string> {
  return [...REGISTERED];
}
