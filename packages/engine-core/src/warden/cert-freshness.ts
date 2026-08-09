/**
 * Warden check 4 — certFreshness (files-never-fixes: READ ONLY).
 *
 * Thin wrapper over the same cert-grade-core.ts grading machinery as
 * crossStoreConsistency, but the comparison axis is TIME rather than
 * pass/fail identity: does the row's last cert artifact (when supplied) look
 * stale relative to what a fresh sample grade finds right now? A cert
 * artifact is stale evidence the moment ANY sampled parcel's fresh grade
 * disagrees with the artifact's recorded verdict for that parcel, or the
 * artifact carries no timestamp at all (an un-datable cert cannot support a
 * freshness claim). Absent a cert artifact, this check honestly declines
 * with a named note (files-never-fixes: it does not mint a substitute
 * artifact) rather than fabricating a freshness verdict.
 */
import { gradeOneParcelInQueryMode, gradeUnzonedParcel, type CertGradeContext, type ParcelGradeResult } from "../registry/cert-grade-core.js";
import type { JurisdictionRegistryRow } from "../registry/jurisdiction-registry.js";
import type { WardenFindingEvent } from "./types.js";
import type { PriorCertVerdict } from "./cross-store-consistency.js";

/** PriorCertVerdict plus an optional artifact timestamp, when the cert artifact JSON carries one. */
export interface PriorCertVerdictWithTimestamp extends PriorCertVerdict {
  readonly artifactTs: string | null;
}

export interface CertFreshnessDeps {
  readonly ctx: CertGradeContext;
  readonly sample: readonly string[];
  readonly row: JurisdictionRegistryRow;
  readonly priorVerdict?: PriorCertVerdictWithTimestamp;
  /** Age (ms) beyond which a cert artifact is flagged stale even with no divergence. Default 30 days. */
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function runCertFreshnessCheck(params: {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly deps: CertFreshnessDeps;
  readonly now: () => Date;
}): Promise<WardenFindingEvent[]> {
  const { sweepId, fips, rowId, deps, now } = params;
  const artifactRef = `warden-sweep:${sweepId}:certFreshness`;
  const findings: WardenFindingEvent[] = [];
  const isUnzoned = deps.row.zoningRegime === "unzoned";

  if (!deps.priorVerdict) {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: null,
      checkId: "certFreshness",
      defectClass: "MEASURE-EMPTY-COHORT",
      evidence: { note: "no --cert-artifact supplied; freshness cannot be evaluated without a prior verdict to date" },
      severity: "info",
      artifactRef,
    });
    return findings;
  }

  if (!deps.priorVerdict.artifactTs) {
    findings.push({
      ts: now().toISOString(),
      sweepId,
      rowId,
      fips,
      parcelNodeId: null,
      checkId: "certFreshness",
      defectClass: "MEASURE-EMPTY-COHORT",
      evidence: {
        certArtifact: deps.priorVerdict.artifactPath,
        note: "cert artifact carries no timestamp; an un-datable cert cannot support a freshness claim",
      },
      severity: "flag",
      artifactRef,
    });
  } else {
    const artifactAgeMs = now().getTime() - new Date(deps.priorVerdict.artifactTs).getTime();
    const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (Number.isFinite(artifactAgeMs) && artifactAgeMs > maxAgeMs) {
      findings.push({
        ts: now().toISOString(),
        sweepId,
        rowId,
        fips,
        parcelNodeId: null,
        checkId: "certFreshness",
        defectClass: "MEASURE-EMPTY-COHORT",
        evidence: {
          certArtifact: deps.priorVerdict.artifactPath,
          artifactTs: deps.priorVerdict.artifactTs,
          ageMs: artifactAgeMs,
          maxAgeMs,
          note: "cert artifact is older than the configured freshness window",
        },
        severity: "flag",
        artifactRef,
      });
    }
  }

  for (const parcelNodeId of deps.sample) {
    let result: ParcelGradeResult;
    try {
      result = isUnzoned
        ? await gradeUnzonedParcel(parcelNodeId, {
            sql: deps.ctx.sql,
            txSql: deps.ctx.txSql,
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
        checkId: "certFreshness",
        defectClass: "MEASURE-EMPTY-COHORT",
        evidence: { detail: `grade threw: ${err instanceof Error ? err.message : String(err)}` },
        severity: "flag",
        artifactRef,
      });
      continue;
    }

    const priorPass = deps.priorVerdict.passByParcel[parcelNodeId];
    if (priorPass !== undefined && priorPass !== result.pass) {
      findings.push({
        ts: now().toISOString(),
        sweepId,
        rowId,
        fips,
        parcelNodeId,
        checkId: "certFreshness",
        defectClass: "MEASURE-EMPTY-COHORT",
        evidence: {
          priorVerdict: priorPass,
          currentGrade: result.pass,
          certArtifact: deps.priorVerdict.artifactPath,
          artifactTs: deps.priorVerdict.artifactTs,
          detail: "fresh grade disagrees with the dated cert artifact's recorded verdict — the artifact is stale evidence",
        },
        severity: "flag",
        artifactRef,
      });
    }
  }

  return findings;
}

export type { JurisdictionRegistryRow };
