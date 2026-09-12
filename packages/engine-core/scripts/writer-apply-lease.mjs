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

export const LAPTOP_WRITE_FROZEN_MESSAGE =
  "--apply is Cloud Run Job only (no break-glass, 2026-09-12 ruling: " +
  "_decisions/2026-09-12_loaders_get_cloud_jobs_no_break_glass.md, P-169). " +
  "CLOUD_RUN_JOB is unset — this process is not running inside a Cloud Run Job execution.";

/**
 * P-169 / A-132: a real --apply requires running inside a Cloud Run Job.
 * CLOUD_RUN_JOB is the Cloud Run Jobs platform's own environment marker —
 * set automatically on every job execution, never something a caller's
 * flag can supply — the same class of detection hauska-factory's own
 * FACTORY_CLOUD gate uses (control/runs.mjs executionIdentity). Unlike
 * refuseApplyWithoutRunId (which only requires *a* --run-id string, the
 * gap the 2026-09-07 no-execution-log write exploited per P-171), this
 * checks the process's actual execution environment, not a caller-supplied
 * argument. Exported here so every writer sharing this module CAN adopt
 * it without duplicating the check; P-169 wires it into
 * write-building-footprint-county.mjs only — the other three writers
 * (well-fact, utility-easement, setback) are a different lane's scope.
 */
export function refuseApplyOutsideCloudRunJob(event, apply, env = process.env) {
  if (!apply || env.CLOUD_RUN_JOB) return false;
  console.error(
    JSON.stringify({
      event,
      code: "LAPTOP_WRITE_FROZEN",
      message: LAPTOP_WRITE_FROZEN_MESSAGE,
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
