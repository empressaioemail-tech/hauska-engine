/** Layer-23 per-parcel record is the sole current scalar author for Bastrop city. */
const BASTROP_AUTHORITATIVE_SETBACK_ADAPTER =
  "bastrop-per-parcel-record-layer-23";

function isAuthoritativeBastropCitySetbackSource(
  sourceAdapter: string | null | undefined,
): boolean {
  return sourceAdapter === BASTROP_AUTHORITATIVE_SETBACK_ADAPTER;
}

/** Minimal atom fields needed to choose between competing setback-rule rows. */
export interface SetbackRulePickCandidate {
  entityId?: string;
  sourceAdapter?: string | null;
}

/**
 * When multiple active setback-rule rows exist for one parcel, prefer:
 * 1. canonical entityId (= parcelNodeId) over suffixed siblings
 * 2. authoritative Bastrop layer-23 source over depth-warm / breadth-bake
 * 3. incoming row (caller should iterate newest-first)
 */
export function pickPreferredSetbackRule<T extends SetbackRulePickCandidate>(
  prior: T | undefined,
  incoming: T,
  parcelNodeId: string,
): T {
  if (!prior) return incoming;

  const incomingCanonical = incoming.entityId === parcelNodeId;
  const priorCanonical = prior.entityId === parcelNodeId;
  if (incomingCanonical && !priorCanonical) return incoming;
  if (priorCanonical && !incomingCanonical) return prior;

  const incomingAuth = isAuthoritativeBastropCitySetbackSource(
    typeof incoming.sourceAdapter === "string" ? incoming.sourceAdapter : null,
  );
  const priorAuth = isAuthoritativeBastropCitySetbackSource(
    typeof prior.sourceAdapter === "string" ? prior.sourceAdapter : null,
  );
  if (incomingAuth && !priorAuth) return incoming;
  if (priorAuth && !incomingAuth) return prior;

  return incoming;
}
