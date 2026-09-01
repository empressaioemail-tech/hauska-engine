/**
 * City-scoped setback plan. Unincorporated is not-applicable structurally.
 * In-city with no table is unmeasured, then absent-verified after probe.
 * Never not-applicable on an in-city parcel.
 */

import {
  classifySetbackRuleAtom,
  getSetbackTableForZoning,
  PLACEHOLDER_SETBACK_PROVENANCE,
  type SetbackRuleProvenanceInput,
} from "@hauska-engine/adapters";

import {
  resolveSetbackCityBinding,
  SetbackWriterRefuseError,
  type SetbackCityBinding,
} from "./city-binding.js";

export const DISTRICT_UNRESOLVED = "DISTRICT_UNRESOLVED";
export const RULE_SOURCE_UNNAMED = "RULE_SOURCE_UNNAMED";
export const PLACEHOLDER_COLLISION = "PLACEHOLDER_COLLISION";
export const MCLENNAN_ENVELOPE_COLLISION = "MCLENNAN_ENVELOPE_COLLISION";
export const CITY_LAYER_UNRESOLVED = "CITY_LAYER_UNRESOLVED";
export const SETBACK_APPLY_HELD = "SETBACK_APPLY_HELD";
export const PARCEL_SOURCE_REQUIRED = "PARCEL_SOURCE_REQUIRED";

export { SetbackWriterRefuseError };

export type SetbackParcelInput = {
  parcelNodeId: string;
  /** City-layer containment. Required. Not defaulted. */
  inCity: boolean;
  district?: string | null;
  existingSetbackRule?: SetbackRuleProvenanceInput | null;
  /** True when a buildable-envelope is on file with no setback-rule input. */
  envelopeWithoutSetbackRule?: boolean;
};

export type PlannedSetbackOutcome =
  | "not-applicable"
  | "unmeasured"
  | "absent-verified"
  | "present";

export type PlaceholderDisposition =
  | "superseded-by-named-source"
  | "recorded-unknown";

export type PlannedSetbackRow = {
  parcelNodeId: string;
  inCity: boolean;
  outcome: PlannedSetbackOutcome;
  basis: string;
  district?: string;
  source?: { id: string; citation: string };
  /** Set when the existing on-file rule classifies unknown (phase-1a). */
  placeholderDisposition?: PlaceholderDisposition;
};

export type CitySetbackPlan = {
  countyFips: string;
  cityKey: string;
  binding: SetbackCityBinding;
  planned: PlannedSetbackRow[];
  counts: {
    notApplicable: number;
    unmeasured: number;
    absentVerified: number;
    present: number;
  };
};

export type ConformantChunk = {
  index: number;
  items: PlannedSetbackRow[];
  runEvent: {
    kind: "chunk";
    runId: string | null;
    chunkIndex: number;
    countyFips: string;
    cityKey: string;
    rows: number;
  };
  links: Array<{ from: string; to: string; kind: string }>;
  leaseLock: {
    scope_type: "write";
    entity_type: "setback-rule";
    county_fips: string;
    lockInChunkTransaction: true;
  };
};

function leadingDistrictToken(district: string): string {
  return (district.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

function applyDistrictAlias(
  district: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const token = leadingDistrictToken(district);
  return aliases[token] ?? aliases[district.trim()] ?? district;
}

function resolveDistrictRow(
  cityKey: string,
  districtRaw: string,
  aliases: Readonly<Record<string, string>>,
): { districtCode: string; citation: string } | null {
  const aliased = applyDistrictAlias(districtRaw, aliases);
  const table = getSetbackTableForZoning(cityKey, aliased);
  if (!table || !Array.isArray(table.districts) || table.districts.length === 0) {
    return null;
  }
  const wanted = leadingDistrictToken(aliased);
  const hit = table.districts.find((d) => {
    const name = d.district_name.trim().toLowerCase();
    return (
      leadingDistrictToken(d.district_name) === wanted ||
      name === aliased.trim().toLowerCase() ||
      name === districtRaw.trim().toLowerCase()
    );
  });
  if (!hit) return null;
  const citation = hit.citation_url?.trim();
  if (!citation) return null;
  return { districtCode: wanted || leadingDistrictToken(hit.district_name), citation };
}

function existingRuleIsPlaceholder(
  rule: SetbackRuleProvenanceInput | null | undefined,
): boolean {
  if (!rule) return false;
  return classifySetbackRuleAtom(rule).disposition === "unknown";
}

function withPlaceholderDisposition(
  row: PlannedSetbackRow,
  isPlaceholder: boolean,
): PlannedSetbackRow {
  if (!isPlaceholder) return row;
  if (row.outcome === "present" && row.source) {
    return {
      ...row,
      placeholderDisposition: "superseded-by-named-source",
      basis: `${row.basis}; ${PLACEHOLDER_COLLISION} superseded by named source ${row.source.id} (${PLACEHOLDER_SETBACK_PROVENANCE})`,
    };
  }
  return {
    ...row,
    placeholderDisposition: "recorded-unknown",
    basis: `${row.basis}; ${PLACEHOLDER_COLLISION} recorded, placeholder not adopted (${PLACEHOLDER_SETBACK_PROVENANCE})`,
  };
}

/**
 * Quarantines that must be named before a binding is resolved.
 * McLennan envelopes from zero setback rules stay a named refuse until F4.
 * Placeholder rules no longer refuse the city plan: an incoming named
 * source supersedes them per parcel.
 */
export function refuseSetbackQuarantines(input: {
  countyFips?: string | null;
  parcels?: readonly SetbackParcelInput[];
}): void {
  const countyFips = String(input.countyFips ?? "").trim();
  const parcels = input.parcels ?? [];
  if (countyFips === "48309") {
    const envelope = parcels.find((p) => p.envelopeWithoutSetbackRule === true);
    if (envelope) {
      throw new SetbackWriterRefuseError(MCLENNAN_ENVELOPE_COLLISION, {
        parcelNodeId: envelope.parcelNodeId,
        county: "48309",
        reason: "McLennan buildable envelope derived from 0 setback rules",
      });
    }
  }
}

export function planCitySetback(input: {
  countyFips: string | null | undefined;
  cityKey: string | null | undefined;
  parcels: readonly SetbackParcelInput[];
  tableProbed?: boolean;
}): CitySetbackPlan {
  refuseSetbackQuarantines({ countyFips: input.countyFips, parcels: input.parcels });
  const binding = resolveSetbackCityBinding(input.cityKey, input.countyFips);
  const probed = input.tableProbed === true;
  const planned: PlannedSetbackRow[] = [];

  for (const parcel of input.parcels) {
    if (typeof parcel.inCity !== "boolean") {
      throw new SetbackWriterRefuseError(CITY_LAYER_UNRESOLVED, {
        parcelNodeId: parcel.parcelNodeId,
        reason: "inCity is not a resolved city-layer containment",
      });
    }
    const isPlaceholder = existingRuleIsPlaceholder(parcel.existingSetbackRule);
    if (binding.countyFips === "48309" && parcel.envelopeWithoutSetbackRule === true) {
      throw new SetbackWriterRefuseError(MCLENNAN_ENVELOPE_COLLISION, {
        parcelNodeId: parcel.parcelNodeId,
        county: "48309",
        reason: "McLennan buildable envelope derived from 0 setback rules",
      });
    }

    if (!parcel.inCity) {
      planned.push(
        withPlaceholderDisposition(
          {
            parcelNodeId: parcel.parcelNodeId,
            inCity: false,
            outcome: "not-applicable",
            basis: "unincorporated: counties do not zone",
          },
          isPlaceholder,
        ),
      );
      continue;
    }

    if (!binding.tableLanded) {
      planned.push(
        withPlaceholderDisposition(
          {
            parcelNodeId: parcel.parcelNodeId,
            inCity: true,
            outcome: probed ? "absent-verified" : "unmeasured",
            basis: probed
              ? "in-city table probed absent"
              : "in-city no table landed",
          },
          isPlaceholder,
        ),
      );
      continue;
    }

    const districtRaw = typeof parcel.district === "string" ? parcel.district.trim() : "";
    if (!districtRaw) {
      throw new SetbackWriterRefuseError(DISTRICT_UNRESOLVED, {
        parcelNodeId: parcel.parcelNodeId,
        cityKey: binding.cityKey,
        reason: "in-city parcel has no district to resolve",
      });
    }
    const resolved = resolveDistrictRow(
      binding.cityKey,
      districtRaw,
      binding.districtAliases,
    );
    if (!resolved) {
      throw new SetbackWriterRefuseError(DISTRICT_UNRESOLVED, {
        parcelNodeId: parcel.parcelNodeId,
        cityKey: binding.cityKey,
        district: districtRaw,
        reason: "district does not resolve on the landed city table",
      });
    }
    if (!binding.namedSource) {
      throw new SetbackWriterRefuseError(RULE_SOURCE_UNNAMED, {
        parcelNodeId: parcel.parcelNodeId,
        cityKey: binding.cityKey,
        district: resolved.districtCode,
      });
    }

    planned.push(
      withPlaceholderDisposition(
        {
          parcelNodeId: parcel.parcelNodeId,
          inCity: true,
          outcome: "present",
          basis: `named source ${binding.namedSource.id}`,
          district: resolved.districtCode,
          source: binding.namedSource,
        },
        isPlaceholder,
      ),
    );
  }

  const inCityNotApplicable = planned.find(
    (row) => row.inCity && row.outcome === "not-applicable",
  );
  if (inCityNotApplicable) {
    throw new SetbackWriterRefuseError("IN_CITY_NOT_APPLICABLE_FORBIDDEN", {
      parcelNodeId: inCityNotApplicable.parcelNodeId,
    });
  }

  return {
    countyFips: binding.countyFips,
    cityKey: binding.cityKey,
    binding,
    planned,
    counts: {
      notApplicable: planned.filter((r) => r.outcome === "not-applicable").length,
      unmeasured: planned.filter((r) => r.outcome === "unmeasured").length,
      absentVerified: planned.filter((r) => r.outcome === "absent-verified").length,
      present: planned.filter((r) => r.outcome === "present").length,
    },
  };
}

export function planConformantChunks(
  plan: CitySetbackPlan,
  options: { chunkSize?: number; runId?: string | null } = {},
): ConformantChunk[] {
  const chunkSize = Math.max(1, options.chunkSize ?? 500);
  const runId = options.runId?.trim() || null;
  const ordered = [...plan.planned].sort((a, b) =>
    a.parcelNodeId.localeCompare(b.parcelNodeId),
  );
  const chunks: ConformantChunk[] = [];
  for (let offset = 0; offset < ordered.length; offset += chunkSize) {
    const items = ordered.slice(offset, offset + chunkSize);
    const index = chunks.length;
    chunks.push({
      index,
      items,
      runEvent: {
        kind: "chunk",
        runId,
        chunkIndex: index,
        countyFips: plan.countyFips,
        cityKey: plan.cityKey,
        rows: items.length,
      },
      links: items
        .filter((row) => row.outcome === "present" && row.district)
        .map((row) => ({
          from: `setback-rule:${row.parcelNodeId}`,
          to: `zoning-district:${plan.cityKey}:${row.district}`,
          kind: "derived-from",
        })),
      leaseLock: {
        scope_type: "write",
        entity_type: "setback-rule",
        county_fips: plan.countyFips,
        lockInChunkTransaction: true,
      },
    });
  }
  return chunks;
}
