/**
 * evt_ node ID resolver — TCE step 3 (partial).
 *
 * IDs are generated ONLY via `resolveEvtId(source, external_id)`.
 * Hand-constructed evt_ IDs are rejected by `assertValidEvtId`.
 */

import { createHash } from "node:crypto";

const EVT_PREFIX = "evt_";

function hashEvtSuffix(source: string, externalId: string): string {
  return createHash("sha256")
    .update(`${source}|${externalId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Deterministic evt_ ID: evt_ + hash(source + "|" + external_id). */
export function resolveEvtId(source: string, externalId: string): string {
  if (!source.trim() || !externalId.trim()) {
    throw new Error("resolveEvtId: source and external_id are required");
  }
  return `${EVT_PREFIX}${hashEvtSuffix(source, externalId)}`;
}

/**
 * Returns true when `id` matches the resolver output for some
 * (source, external_id). Rejects hand-constructed IDs that merely
 * carry the evt_ prefix without the cryptographic binding.
 */
export function isValidEvtId(
  id: string,
  source: string,
  externalId: string,
): boolean {
  if (!id.startsWith(EVT_PREFIX)) return false;
  return id === resolveEvtId(source, externalId);
}

/** Throws when `id` is not resolver-generated for (source, external_id). */
export function assertValidEvtId(
  id: string,
  source: string,
  externalId: string,
): void {
  if (!isValidEvtId(id, source, externalId)) {
    throw new Error(
      `Invalid evt_ id "${id}": must be resolver-generated from (source, external_id)`,
    );
  }
}

/** Reject any evt_ id that cannot be validated without source binding. */
export function rejectHandConstructedEvtId(id: string): void {
  if (!id.startsWith(EVT_PREFIX)) {
    throw new Error(`Expected evt_ prefix on node id "${id}"`);
  }
  const suffix = id.slice(EVT_PREFIX.length);
  if (!/^[a-f0-9]{32}$/.test(suffix)) {
    throw new Error(
      `evt_ id "${id}" has invalid suffix — hand-constructed ids are rejected`,
    );
  }
}
