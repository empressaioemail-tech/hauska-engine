/**
 * PROPERTY_ATOM_PATH gate — dual-serve prep for atom emit path.
 *
 * Set `PROPERTY_ATOM_PATH=1` to enable property atom emission in callers
 * (Cortex / bake orchestrators wire this later; engine exports the API now).
 */
export function isPropertyAtomPathEnabled(): boolean {
  return process.env.PROPERTY_ATOM_PATH === "1";
}

export const PROPERTY_ATOM_PATH_ENV = "PROPERTY_ATOM_PATH";
