/**
 * Build + verify `owner-fact` atoms from a county plan.
 *
 * The exemption-code reduction happens HERE, at the boundary between the plan
 * (which carries raw CAD codes) and the atom (which must never see them).
 * `deriveExemptionFlags` is the only path across that boundary.
 */

import {
  OWNER_FACT_SCHEMA,
  buildCountyOwnerCoverageAbsenceAtom,
  buildOwnerFactAbsenceAtom,
  buildPresentOwnerFactAtom,
  deriveExemptionFlags,
  ownerFactClaimContentHash,
  type OwnerFactAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyOwnerFactPlan,
  PlannedOwnerFact,
} from "./plan-county-owner-facts.js";

export type OwnerCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedOwnerFact(
  entry: PlannedOwnerFact,
  countyFips: string,
  provenance: OwnerCountyRunProvenance,
): OwnerFactAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    const exemptionFlags = deriveExemptionFlags(entry.exemptionCodes);
    return buildPresentOwnerFactAtom(
      {
        parcelNodeId,
        taxYear: entry.taxYear,
        ownerName: entry.ownerName,
        ...(entry.ownerMailingAddress
          ? { ownerMailingAddress: entry.ownerMailingAddress }
          : {}),
        ...(exemptionFlags ? { exemptionFlags } : {}),
      },
      {
        ...provenance,
        ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
        contentHash: ownerFactClaimContentHash({
          parcelNodeId,
          taxYear: entry.taxYear,
          sourceTier: "cad-authoritative",
          ownerName: entry.ownerName,
          ownerMailingAddress: entry.ownerMailingAddress ?? null,
          exemptionFlags: exemptionFlags ?? null,
        }),
      },
    );
  }

  return buildOwnerFactAbsenceAtom(
    {
      parcelNodeId,
      taxYear: entry.taxYear,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
    },
    {
      ...provenance,
      ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
      contentHash: ownerFactClaimContentHash({
        parcelNodeId,
        taxYear: entry.taxYear,
        sourceTier: "cad-authoritative",
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForOwnerFactPlan(
  plan: CountyOwnerFactPlan,
  provenance: OwnerCountyRunProvenance,
): ReadonlyArray<OwnerFactAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedOwnerFact(entry, plan.countyFips, provenance),
  );
}

export function buildCountyOwnerCoverageAtom(
  countyFips: string,
  taxYear: number,
  provenanceScope: ReadonlyArray<string>,
  provenance: OwnerCountyRunProvenance,
): OwnerFactAtomInstance {
  return buildCountyOwnerCoverageAbsenceAtom(
    { countyFips, taxYear, provenanceScope },
    {
      ...provenance,
      contentHash: ownerFactClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        taxYear,
        sourceTier: "absent",
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredOwnerFactVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; taxYear: number; problem: string };

export function verifyStoredOwnerFactAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    taxYear: number;
    outcome: "present" | "absent";
  },
): StoredOwnerFactVerdict {
  const fail = (problem: string): StoredOwnerFactVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    taxYear: expected.taxYear,
    problem,
  });

  const parsed = OWNER_FACT_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail OWNER_FACT_SCHEMA: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const atom = parsed.data;
  if (atom.parcelNodeId !== expected.parcelNodeId) {
    return fail(
      `stored parcelNodeId ${atom.parcelNodeId} != expected ${expected.parcelNodeId}`,
    );
  }
  if (atom.taxYear !== expected.taxYear) {
    return fail(
      `stored taxYear ${atom.taxYear} != expected ${expected.taxYear}`,
    );
  }

  // The paid-tier guard, re-checked against the STORED bytes. The schema
  // already rejects a wrong policy at build time; this catches a row that was
  // written before the pin existed or mutated in place afterwards.
  if (atom.accessPolicy !== "public-paid") {
    return fail(
      `stored accessPolicy ${atom.accessPolicy} != public-paid — owner identity must never rest on the free tier`,
    );
  }

  const storedOutcome =
    atom.absence || atom.sourceTier === "absent" || atom.verifiedAbsence
      ? "absent"
      : "present";
  if (storedOutcome !== expected.outcome) {
    return fail(
      `stored outcome ${storedOutcome} != planned ${expected.outcome}`,
    );
  }
  return { ok: true };
}
