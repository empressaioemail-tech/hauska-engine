/**
 * Warden check 3 — crossStoreConsistency (files-never-fixes: READ ONLY).
 *
 * Thin wrapper over cert-grade-core.ts's gradeOneParcelInQueryMode /
 * gradeUnzonedParcel — the SAME grading machinery block13-cert-grade.mjs and
 * OPS-8 check 5 (geometry parity) reuse, imported read-only. Runs a
 * deterministic sample (default 10 parcels/row; unzoned rows route to
 * gradeUnzonedParcel) and diffs the grade result against the row's last cert
 * verdict shape when one is supplied (--cert-artifact). When no cert
 * artifact is passed in, this check still runs the grade (a fresh
 * cross-store read is useful on its own) but the diff-against-prior-verdict
 * portion is skipped with a named note rather than silently omitted.
 */
import { gradeOneParcelInQueryMode, gradeUnzonedParcel, type CertGradeContext, type ParcelGradeResult } from "../registry/cert-grade-core.js";
import type { JurisdictionRegistryRow } from "../registry/jurisdiction-registry.js";
import {
  defectClassForFailedGrade,
  isCrossStoreGradeConsistent,
} from "./cascade-state-consistency.js";
import type { WardenFindingEvent } from "./types.js";

/** Minimal shape read from a prior cert artifact JSON — tolerant of the block13-cert-grade.mjs output shape. */
export interface PriorCertVerdict {
  /** parcelNodeId -> whether the prior cert run passed that parcel. */
  readonly passByParcel: Readonly<Record<string, boolean>>;
  readonly artifactPath: string;
}

export interface CrossStoreConsistencyDeps {
  readonly ctx: CertGradeContext;
  readonly sample: readonly string[];
  readonly row: JurisdictionRegistryRow;
  /** Optional — when absent, the diff-against-prior-verdict portion is skipped with a named note. */
  readonly priorVerdict?: PriorCertVerdict;
  /** Reads the latest envelope warmVerifyDeclineCode for decline-aware consistency (Warden v1.1). */
  readonly loadEnvelopeDeclineCode?: (parcelNodeId: string) => Promise<string | null>;
}

export async function runCrossStoreConsistencyCheck(params: {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly deps: CrossStoreConsistencyDeps;
  readonly now: () => Date;
}): Promise<WardenFindingEvent[]> {
  const { sweepId, fips, rowId, deps, now } = params;
  const artifactRef = `warden-sweep:${sweepId}:crossStoreConsistency`;
  const findings: WardenFindingEvent[] = [];
  const isUnzoned = deps.row.zoningRegime === "unzoned";

  if (!deps.priorVerdict) {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: null,
      checkId: "crossStoreConsistency",
      defectClass: "MEASURE-EMPTY-COHORT",
      evidence: { note: "no --cert-artifact supplied; diff-against-prior-verdict skipped, grade-only run performed" },
      severity: "info",
      artifactRef,
    });
  }

  for (const parcelNodeId of deps.sample) {
    let result: ParcelGradeResult;
    try {
      result = isUnzoned
        ? await gradeUnzonedParcel(parcelNodeId, {
            sql: deps.ctx.sql,
            cadastralQueryUrl: deps.row.railC.cadastralQueryUrl,
          })
        : await gradeOneParcelInQueryMode(parcelNodeId, {
            ...deps.ctx,
            districtPrefix: null,
            cadastralQueryUrl: deps.ctx.cadastralQueryUrl ?? deps.row.railC.cadastralQueryUrl,
          });
    } catch (err) {
      findings.push({
        ts: now().toISOString(),
        sweepId,
        rowId,
        fips,
        parcelNodeId,
        checkId: "crossStoreConsistency",
        defectClass: "MEASURE-EMPTY-COHORT",
        evidence: { detail: `grade threw: ${err instanceof Error ? err.message : String(err)}` },
        severity: "flag",
        artifactRef,
      });
      continue;
    }

    if (!result.pass) {
      const observedDeclineCode = deps.loadEnvelopeDeclineCode
        ? await deps.loadEnvelopeDeclineCode(parcelNodeId)
        : null;
      if (isCrossStoreGradeConsistent(result, observedDeclineCode)) {
        continue;
      }
      findings.push({
        ts: now().toISOString(),
        sweepId,
        rowId,
        fips,
        parcelNodeId,
        checkId: "crossStoreConsistency",
        defectClass: defectClassForFailedGrade(result),
        evidence: { grade: result, observedDeclineCode },
        severity: "flag",
        artifactRef,
      });
      continue;
    }

    if (deps.priorVerdict) {
      const priorPass = deps.priorVerdict.passByParcel[parcelNodeId];
      if (priorPass !== undefined && priorPass !== result.pass) {
        findings.push({
          ts: now().toISOString(),
          sweepId,
          rowId,
          fips,
          parcelNodeId,
          checkId: "crossStoreConsistency",
          defectClass: "GEOMETRY-DIVERGE",
          evidence: {
            priorVerdict: priorPass,
            currentGrade: result.pass,
            certArtifact: deps.priorVerdict.artifactPath,
            detail: "current grade diverges from the prior cert verdict for this parcel",
          },
          severity: "flag",
          artifactRef,
        });
      }
    }
  }

  return findings;
}
