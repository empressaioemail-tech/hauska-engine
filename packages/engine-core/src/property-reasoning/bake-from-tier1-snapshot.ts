/**
 * Shared Tier-1 snapshot → property atom emit (gold bake + county breadth).
 * Confidence composed via contract emitters — never labeling×district multiply.
 * Honest absence: no-zoning-stamp when district missing (null-zoning rule at scale).
 *
 * Setback-RULE emit (WDLL 3.4 / 3.5): look up the adapter setback table by the
 * parcel's resolved zoning.jurisdictionKey (PIP cityKey). Dims come from the
 * cited table row, not from Tier-1 envelope.setbacks (anti-zombie: Tier-1 keeps
 * atom_path_pending and does not embed product setbacks).
 *
 * Envelope DERIVED (WDLL 3.6): composes from zoning-FACT + setback-RULE refs.
 * When snapshot lacks a geometry area outcome, emit provisional-front-edge
 * (honest) rather than inventing buildable sqft.
 */

import {
  getSetbackTableForZoning,
  requiresPerParcelSetbackRecord,
} from "@hauska-engine/adapters";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

import { emitBuildableEnvelope } from "./emit-buildable-envelope.js";
import { emitSetbackRule, resolveSetbackTableRow } from "./emit-setback-rule.js";
import { emitZoningFact } from "./emit-zoning-fact.js";
import {
  normalizeCityKey,
  setbackTableDescriptorFromAdapter,
} from "./setback-table-from-adapter.js";
import type {
  JurisdictionDescriptor,
  SetbackTableRowProvenance,
} from "./types.js";

export type Tier1ZoningProvenance = {
  sourceUrl?: string | null;
  codeField?: string | null;
  cityKey?: string | null;
  layerName?: string | null;
  stampedAt?: string | null;
};

export type Tier1SnapshotPayload = {
  bakedAt?: string;
  baseFacts?: { situsCity?: string | null };
  zoning?: {
    district?: string | null;
    /** PIP-stamped cityKey (hyphen or underscore form). */
    jurisdictionKey?: string | null;
    /** GIS origin — required when district is present (COMPLETE-BASTROP A1). */
    provenance?: Tier1ZoningProvenance | null;
  };
  provenance?: {
    zoningSource?: string | null;
  } | null;
  envelope?: {
    status?: string | null;
    buildableAreaSqFt?: number | null;
    setbacks?: {
      front_ft?: number;
      side_ft?: number;
      rear_ft?: number;
    } | null;
    jurisdictionKey?: string | null;
  } | null;
};

export type EmitFromSnapshotResult = {
  atoms: PropertyAtomInstance[];
  notes: string[];
  zoningPresent: boolean;
  zoningAbsence: boolean;
  setbackPresent: boolean;
  envelopePresent: boolean;
};

/**
 * FIPS county code -> district-code-section-map.ts jurisdiction key.
 * Lets the breadth-bake path resolve narrative code-section refs
 * (sourceCodeAtomRef / codeSectionRefs) via emitZoningFact's
 * lookupDistrictCodeSectionRefs(descriptor.key, district) call, which keys
 * strictly off JurisdictionDescriptor.key. Absence of an entry is honest —
 * descriptorForCounty falls back to the pre-existing breadth_${fips} key,
 * which never matches the map, so unmapped counties emit byte-identical to
 * today (no refs).
 */
const COUNTY_FIPS_TO_DISTRICT_MAP_KEY: Readonly<Record<string, string>> = {
  "48021": "bastrop_tx",
};

export function descriptorForCounty(
  parcelNodeId: string,
  /** cityKey from tier-1 snapshot (e.g. elgin_tx, bastrop_city_tx) or situsCity fallback */
  cityHint: string | null | undefined,
  countyFips: string,
  setbackTable?: JurisdictionDescriptor["setbackTable"],
): JurisdictionDescriptor {
  const city = (cityHint || "unknown").toLowerCase().replace(/\s+/g, "_");
  const cityNorm = city.replace(/-/g, "_");
  const districtMapKey =
    cityNorm === "elgin_tx"
      ? "elgin_tx"
      : COUNTY_FIPS_TO_DISTRICT_MAP_KEY[countyFips];
  return {
    key: districtMapKey ?? `breadth_${countyFips}`,
    displayName: `Breadth bake ${countyFips}`,
    jurisdictionTenant: `breadth_${countyFips}_${city}`,
    parcelFips: countyFips,
    defaultAccessPolicy: "public-free",
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    sourceUrl: "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
    setbackTable,
  };
}

function findRowForResolved(
  rows: ReadonlyArray<SetbackTableRowProvenance>,
  districtCode: string,
  matchBasis: string,
): SetbackTableRowProvenance | undefined {
  const wanted = districtCode.trim().toLowerCase();
  return (
    rows.find(
      (r) =>
        r.district_code.toLowerCase() === wanted && r.match_basis === matchBasis,
    ) ?? rows.find((r) => r.district_code.toLowerCase() === wanted)
  );
}

/**
 * M0 (COMPLETE-BASTROP A1 / S-01): district FACT without GIS provenance is a
 * hard fail — never emit a zoning-fact that only cites the breadth bake.
 */
export function assertZoningProvenancePresent(
  zoningDistrict: string,
  snap: Tier1SnapshotPayload,
): string {
  const fromZoning = snap.zoning?.provenance?.sourceUrl?.trim() ?? "";
  const fromTop = snap.provenance?.zoningSource?.trim() ?? "";
  const sourceUrl = fromZoning || fromTop;
  if (!sourceUrl) {
    throw new Error(
      `zoning-provenance-required: district=${zoningDistrict} but zoning.provenance.sourceUrl ` +
        `(and provenance.zoningSource) empty — refuse breadth bake that would cite only the intermediate`,
    );
  }
  return sourceUrl;
}

function zoningCitationFromProvenance(
  parcelNodeId: string,
  district: string,
  snap: Tier1SnapshotPayload,
  sourceUrl: string,
): {
  sourceAdapter: string;
  sourceUrl: string;
  sourceCitation: string;
  cityKey: string | null;
} {
  const prov = snap.zoning?.provenance ?? {};
  const cityKey =
    normalizeCityKey(prov.cityKey) ??
    normalizeCityKey(snap.zoning?.jurisdictionKey) ??
    normalizeCityKey(snap.envelope?.jurisdictionKey);
  const codeField =
    typeof prov.codeField === "string" && prov.codeField.trim()
      ? prov.codeField.trim()
      : "zoning-code";
  const layerName =
    typeof prov.layerName === "string" && prov.layerName.trim()
      ? prov.layerName.trim()
      : "zoning-layer";
  const stampedAt =
    typeof prov.stampedAt === "string" && prov.stampedAt.trim()
      ? prov.stampedAt.trim()
      : snap.bakedAt ?? "unknown-vintage";
  const adapterCity = cityKey ?? "unknown-city";
  return {
    sourceAdapter: `txgio-zoning-stamp:${adapterCity}`,
    sourceUrl,
    sourceCitation:
      `GIS ${layerName} field ${codeField}` +
      (cityKey ? ` cityKey=${cityKey}` : "") +
      ` vintage=${stampedAt}` +
      ` district=${district} parcel=${parcelNodeId}` +
      ` (PIP stamp; breadth bake is TRANSFORM only)`,
    cityKey,
  };
}

export function emitFromTier1Snapshot(
  parcelNodeId: string,
  snap: Tier1SnapshotPayload,
  countyFips: string,
): EmitFromSnapshotResult {
  const extractedAt = snap.bakedAt || new Date().toISOString();
  const city = snap.baseFacts?.situsCity ?? null;
  const cityKey =
    normalizeCityKey(snap.zoning?.jurisdictionKey) ??
    normalizeCityKey(snap.envelope?.jurisdictionKey);
  const zoningDistrict =
    typeof snap.zoning?.district === "string" && snap.zoning.district.trim()
      ? snap.zoning.district.trim()
      : null;
  const adapterTable = cityKey
    ? getSetbackTableForZoning(cityKey, zoningDistrict)
    : null;
  const setbackTable = setbackTableDescriptorFromAdapter(adapterTable);
  const descriptor = descriptorForCounty(
    parcelNodeId,
    cityKey ?? city,
    countyFips,
    setbackTable,
  );
  const env = snap.envelope && typeof snap.envelope === "object" ? snap.envelope : null;
  const out: EmitFromSnapshotResult = {
    atoms: [],
    notes: [],
    zoningPresent: false,
    zoningAbsence: false,
    setbackPresent: false,
    envelopePresent: false,
  };

  if (!zoningDistrict) {
    const z = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: null,
      matchBasis: "exact",
      sourceCitation: `Breadth bake honest-absence from cortex tier1 snapshot (${parcelNodeId})`,
      extractedAt,
    });
    out.atoms.push(z);
    out.notes.push("zoning-absence");
    out.zoningAbsence = true;
    return out;
  }

  // M0: district present ⇒ GIS provenance required (fail closed).
  const gisSourceUrl = assertZoningProvenancePresent(zoningDistrict, snap);
  const gisCite = zoningCitationFromProvenance(
    parcelNodeId,
    zoningDistrict,
    snap,
    gisSourceUrl,
  );
  const zoningDescriptor: JurisdictionDescriptor = {
    ...descriptor,
    sourceAdapter: gisCite.sourceAdapter,
    sourceUrl: gisCite.sourceUrl,
  };

  const z = emitZoningFact(zoningDescriptor, {
    parcelNodeId,
    districtCode: zoningDistrict,
    matchBasis: "exact",
    sourceCitation: gisCite.sourceCitation,
    extractedAt,
    // Bake remains a TRANSFORM step — not the source (A1 / S-01).
    reasoningChain: {
      reasoningKind: "observed",
      transformSteps: [
        {
          kind: "TRANSFORM",
          adapter: "cortex-tier1-snapshot-breadth-bake",
          sourceUrl:
            "https://hauska.dev/internal/breadth-atom-bake/cortex-snapshot",
          note: "Breadth bake projected GIS stamp from cortex tier1 snapshot; not the district origin",
        },
      ],
    },
  });
  out.atoms.push(z);
  out.notes.push("zoning");
  out.zoningPresent = true;

  if (!cityKey) {
    out.notes.push("setback-omitted-no-jurisdiction-key");
    return out;
  }

  // R13 — jurisdictions whose setbacks are authored only from a per-parcel
  // record must not get a breadth-baked setback scalar (jurisdiction-agnostic
  // check lives in adapters to keep this module literal-free, WDLL 3.8).
  if (requiresPerParcelSetbackRecord(cityKey)) {
    out.notes.push(
      "setback-omitted-jurisdiction-requires-per-parcel-record",
    );
    return out;
  }

  if (!setbackTable) {
    out.notes.push(`setback-table-missing:${cityKey}`);
    return out;
  }

  const resolved = resolveSetbackTableRow(setbackTable, zoningDistrict);
  if ("kind" in resolved) {
    out.notes.push(`setback-absence:${resolved.code}`);
    return out;
  }

  const row = findRowForResolved(
    setbackTable.rows,
    resolved.districtCode,
    resolved.matchBasis,
  );
  if (!row) {
    out.notes.push("setback-absence:setback-row-lookup-miss");
    return out;
  }

  const setback = emitSetbackRule(
    descriptor,
    zoningDistrict,
    row,
    parcelNodeId,
  );
  if (setback && "kind" in setback && setback.kind === "honest-absence") {
    out.notes.push(`setback-absence:${(setback as { code?: string }).code}`);
    return out;
  }
  out.atoms.push(setback as PropertyAtomInstance);
  out.notes.push("setback");
  out.setbackPresent = true;

  const setbackAtom = setback as PropertyAtomInstance;
  const zAsserted = z.readContract?.axes.assertedConfidence;
  const sAsserted = setbackAtom.readContract?.axes.assertedConfidence;
  if (!zAsserted || !sAsserted) {
    out.notes.push("envelope-omitted-missing-asserted-confidence");
    return out;
  }

  const silentAxes =
    row.front_ft?.not_specified === true ||
    row.side_ft?.not_specified === true ||
    row.rear_ft?.not_specified === true;

  let outcome:
    | { kind: "no-buildable-area"; reason: string }
    | { kind: "buildable"; areaSqFt: number }
    | { kind: "provisional-front-edge"; reason: string };
  if (silentAxes) {
    // not_specified zeros must never become "no-buildable-area" / consume-lot.
    outcome = {
      kind: "provisional-front-edge",
      reason:
        "One or more scalar setbacks are not_specified (build-to-line governs); refuse to derive consume-lot from silent axes",
    };
  } else if (env?.status === "no-buildable-area") {
    outcome = {
      kind: "no-buildable-area",
      reason: "Tier-1 snapshot status no-buildable-area",
    };
  } else if (
    env?.status === "ok" &&
    typeof env.buildableAreaSqFt === "number"
  ) {
    outcome = { kind: "buildable", areaSqFt: env.buildableAreaSqFt };
  } else {
    // Anti-zombie Tier-1 leaves atom_path_pending with no area — still emit
    // DERIVED envelope composed from fact+rule refs (WDLL 3.6).
    outcome = {
      kind: "provisional-front-edge",
      reason:
        "Setback rule cited; parcel-ring buildable area not yet derived from geometry (Tier-1 atom_path_pending)",
    };
  }

  const envelope = emitBuildableEnvelope({
    descriptor,
    parcelNodeId,
    zoningFactAtomDid: z.atomDid,
    setbackRuleAtomDid: setbackAtom.atomDid,
    geometryRefId: `${parcelNodeId}/geometry`,
    frontEdgeRefId: `${parcelNodeId}/front-edge`,
    outcome,
    inputAssertedConfidences: [zAsserted, sAsserted],
    sourceCitation:
      "Breadth bake derived envelope from zoning-FACT + setback-RULE refs — assertedConfidence composed via contract (not labeling×district)",
    extractedAt,
  });
  if (envelope && "kind" in envelope && envelope.kind === "honest-absence") {
    out.notes.push(`envelope-absence:${(envelope as { code?: string }).code}`);
    return out;
  }
  out.atoms.push(envelope as PropertyAtomInstance);
  out.notes.push("envelope");
  out.envelopePresent = true;
  return out;
}
