/**
 * PROPERTY_ATOM_PATH gate — dual-serve prep for atom emit / bake writers.
 *
 * Set `PROPERTY_ATOM_PATH=1` to enable property atom emission in callers
 * (Cortex / bake orchestrators wire this later; engine exports the API now).
 *
 * Gate C note: retrieval-api `GET /property-nodes/:parcelNodeId/atom-chain`
 * is always-on and reads StoragePort; it returns empty slots when no atoms
 * are baked. Do NOT flip cortex live envelope dual-serve from this flag —
 * cortex dual-serve is a separate PR. property-explorer is untouched.
 */
export function isPropertyAtomPathEnabled(): boolean {
  return process.env.PROPERTY_ATOM_PATH === "1";
}

export const PROPERTY_ATOM_PATH_ENV = "PROPERTY_ATOM_PATH";
