import type { PropertyAtomInstance } from "@hauska-engine/atoms";

/**
 * Retire-not-overwrite: flip prior atom status without mutating history row body.
 */
export function flipPropertyAtomRetired<T extends PropertyAtomInstance>(
  atom: T,
  retiredAt = new Date().toISOString(),
): T {
  return {
    ...atom,
    status: "retired",
    retiredAt,
  };
}

/**
 * Emit path returns a new version identity; caller persists both retired prior
 * and the new active row when storage supports history.
 */
export function successorPropertyAtomIdentity(
  prior: PropertyAtomInstance,
): { entityId: string; versionStamp: string; supersedesEntityId: string } {
  const versionMatch = /-v(\d+)$/.exec(prior.entityId);
  const priorVersion = versionMatch ? Number(versionMatch[1]) : 1;
  const nextVersion = priorVersion + 1;
  const base = prior.entityId.replace(/-v\d+$/, "");
  const entityId = `${base}-v${nextVersion}`;
  const versionStamp = `${prior.parcelNodeId}:${prior.entityType}:${nextVersion}:${Date.now()}`;
  return {
    entityId,
    versionStamp,
    supersedesEntityId: prior.entityId,
  };
}
