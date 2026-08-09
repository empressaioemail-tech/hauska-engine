/**
 * Build + verify `cad-parcel-roll` atoms from a county plan.
 */

import {
  CAD_PARCEL_ROLL_SCHEMA,
  buildCadParcelRollAbsenceAtom,
  buildCountyCadRollCoverageAbsenceAtom,
  buildPresentCadParcelRollAtom,
  cadParcelRollClaimContentHash,
  type CadParcelRollAtomInstance,
  type PropertyFactWriteProvenance,
} from "@hauska-engine/atoms";

import type {
  CountyCadParcelRollPlan,
  PlannedCadParcelRoll,
} from "./plan-county-cad-parcel-roll.js";

export type CadCountyRunProvenance = Omit<
  PropertyFactWriteProvenance,
  "contentHash" | "observedAt"
> & { observedAt: string };

export function buildAtomForPlannedCadParcelRoll(
  entry: PlannedCadParcelRoll,
  countyFips: string,
  provenance: CadCountyRunProvenance,
): CadParcelRollAtomInstance {
  const parcelNodeId = `${countyFips}:${entry.parcelKey}`;

  if (entry.outcome === "present") {
    return buildPresentCadParcelRollAtom(
      {
        countyFips,
        parcelKey: entry.parcelKey,
        taxYear: entry.taxYear,
        keyKind: entry.keyKind,
        joinPassedOwnerMatchGate: entry.joinPassedOwnerMatchGate,
        sourceFile: entry.sourceFile,
        ...(entry.ownerName ? { ownerName: entry.ownerName } : {}),
        ...(entry.ownerMailingAddress
          ? { ownerMailingAddress: entry.ownerMailingAddress }
          : {}),
        ...(entry.situsAddress ? { situsAddress: entry.situsAddress } : {}),
        ...(entry.situsCity ? { situsCity: entry.situsCity } : {}),
        ...(entry.situsZip ? { situsZip: entry.situsZip } : {}),
        ...(entry.legalDescription
          ? { legalDescription: entry.legalDescription }
          : {}),
        ...(entry.exemptionCodes
          ? { exemptionCodes: entry.exemptionCodes }
          : {}),
        ...(entry.landValue !== undefined ? { landValue: entry.landValue } : {}),
        ...(entry.improvementValue !== undefined
          ? { improvementValue: entry.improvementValue }
          : {}),
        ...(entry.marketValue !== undefined
          ? { marketValue: entry.marketValue }
          : {}),
        ...(entry.assessedValue !== undefined
          ? { assessedValue: entry.assessedValue }
          : {}),
        ...(entry.yearBuilt !== undefined ? { yearBuilt: entry.yearBuilt } : {}),
        ...(entry.livingAreaSqft !== undefined
          ? { livingAreaSqft: entry.livingAreaSqft }
          : {}),
        ...(entry.landAcres !== undefined ? { landAcres: entry.landAcres } : {}),
        ...(entry.propertyUseCode
          ? { propertyUseCode: entry.propertyUseCode }
          : {}),
      },
      {
        ...provenance,
        sourceVintage: entry.sourceVintage,
        contentHash: cadParcelRollClaimContentHash({
          parcelNodeId,
          taxYear: entry.taxYear,
          sourceTier: "cad-authoritative",
          joinPassedOwnerMatchGate: true,
          sourceFile: entry.sourceFile,
          marketValue: entry.marketValue ?? null,
          propertyUseCode: entry.propertyUseCode ?? null,
          situsAddress: entry.situsAddress ?? null,
        }),
      },
    );
  }

  return buildCadParcelRollAbsenceAtom(
    {
      countyFips,
      parcelKey: entry.parcelKey,
      taxYear: entry.taxYear,
      keyKind: entry.keyKind,
      absenceKind: entry.absenceKind,
      reason: entry.reason,
      ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}),
    },
    {
      ...provenance,
      ...(entry.sourceVintage ? { sourceVintage: entry.sourceVintage } : {}),
      contentHash: cadParcelRollClaimContentHash({
        parcelNodeId,
        taxYear: entry.taxYear,
        sourceTier: "cad-authoritative",
        joinPassedOwnerMatchGate: false,
        sourceFile: entry.sourceFile,
        absenceKind: entry.absenceKind,
        absenceReason: entry.reason,
      }),
    },
  );
}

export function buildAtomsForCadParcelRollPlan(
  plan: CountyCadParcelRollPlan,
  provenance: CadCountyRunProvenance,
): ReadonlyArray<CadParcelRollAtomInstance> {
  return plan.planned.map((entry) =>
    buildAtomForPlannedCadParcelRoll(entry, plan.countyFips, provenance),
  );
}

export function buildCountyCadRollCoverageAtom(
  countyFips: string,
  taxYear: number,
  provenanceScope: ReadonlyArray<string>,
  provenance: CadCountyRunProvenance,
): CadParcelRollAtomInstance {
  return buildCountyCadRollCoverageAbsenceAtom(
    { countyFips, taxYear, provenanceScope },
    {
      ...provenance,
      contentHash: cadParcelRollClaimContentHash({
        parcelNodeId: `${countyFips}:_county_coverage`,
        taxYear,
        sourceTier: "absent",
        joinPassedOwnerMatchGate: false,
        verifiedAbsenceScope: provenanceScope,
      }),
    },
  );
}

export type StoredCadParcelRollVerdict =
  | { ok: true }
  | { ok: false; parcelNodeId: string; taxYear: number; problem: string };

/**
 * Write-then-verify against STORED body bytes. Forbids embedded geometry /
 * rawRow smuggling (Geometry Law: CAD roll is attributes, not a ring store).
 */
export function verifyStoredCadParcelRollAtom(
  stored: unknown,
  expected: {
    parcelNodeId: string;
    taxYear: number;
    outcome: "present" | "absent";
  },
): StoredCadParcelRollVerdict {
  const fail = (problem: string): StoredCadParcelRollVerdict => ({
    ok: false,
    parcelNodeId: expected.parcelNodeId,
    taxYear: expected.taxYear,
    problem,
  });

  if (stored && typeof stored === "object") {
    const obj = stored as Record<string, unknown>;
    if ("geometry" in obj || "rawRow" in obj || "coordinates" in obj) {
      return fail(
        "stored CAD roll body embeds geometry/rawRow/coordinates — attribute atom only",
      );
    }
    const json = JSON.stringify(stored);
    if (
      json.includes('"coordinates"') ||
      json.includes('"rawRow"') ||
      /"type"\s*:\s*"(Polygon|MultiPolygon|Point)"/.test(json)
    ) {
      return fail("stored CAD roll body embeds geometry payload");
    }
  }

  const parsed = CAD_PARCEL_ROLL_SCHEMA.safeParse(stored);
  if (!parsed.success) {
    return fail(
      `stored bytes fail CAD_PARCEL_ROLL_SCHEMA: ${parsed.error.issues
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
