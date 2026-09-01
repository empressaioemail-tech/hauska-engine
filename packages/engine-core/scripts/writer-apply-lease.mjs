/**
 * CAD-shaped --apply lease helpers. Four non-CAD writers share this so the
 * LEASE_REQUIRED message and the (scope_type, entity_type, county_fips) shape
 * cannot drift. entity_type is always THIS rail, never cad-parcel-roll.
 */

export const APPLY_LEASE_MESSAGE =
  "--apply requires --run-id (a Factory runs row). HeldLease is minted from that id. v1 ATOMS_WRITER_LEASE_HOLDER cannot satisfy a write.";

export function consumeRunIdArg(a, argv, i, out) {
  if (a === "--run-id") {
    out.runId = String(argv[++i] || "").trim() || null;
    return i;
  }
  if (a.startsWith("--run-id=")) {
    out.runId = a.slice("--run-id=".length).trim() || null;
    return i;
  }
  return null;
}

export function refuseApplyWithoutRunId(event, apply, runId) {
  if (!apply || runId) return false;
  console.error(
    JSON.stringify({
      event,
      code: "LEASE_REQUIRED",
      message: APPLY_LEASE_MESSAGE,
    }),
  );
  return true;
}

export function railLeaseArgs({ entityType, countyFips, runId, holderFallback }) {
  if (entityType === "cad-parcel-roll") {
    throw new Error(
      "railLeaseArgs refuses cad-parcel-roll: that scope belongs to the CAD writer",
    );
  }
  return {
    scope: {
      scope_type: "write",
      entity_type: entityType,
      county_fips: countyFips,
    },
    holder_label:
      process.env.CLOUD_RUN_EXECUTION?.trim() ||
      process.env.K_REVISION?.trim() ||
      holderFallback,
    run_id: runId,
  };
}

/** Thread a HeldLease into the batch write. Missing lease refuses; never a silent write. */
export async function persistRailAtoms(storage, atoms, lease) {
  if (!lease) {
    throw new Error("writePropertyAtomsBatch requires a HeldLease");
  }
  return storage.writePropertyAtomsBatch(atoms, lease);
}
