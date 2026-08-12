/**
 * Staged `tx_building_footprint` geometry-true join (OPS-16 A-004 / P-09).
 *
 * Matching path (the ONLY path on the default county writer):
 *   1. Fail-closed readiness: table present, geom populated, GiST live, county
 *      non-empty. Empty county is HALT, not absence atoms.
 *   2. Candidate prefilter: ST_Intersects(fp.geom, ST_MakeEnvelope(...)) via
 *      GiST. Envelope/bbox intersect alone MUST NOT attach.
 *   3. Attach: existing footprintParcelOverlapRatio >= 10% straddle / >= 50%
 *      primary from spatial-join.ts.
 *
 * Silent fallback to loadMlFootprintsForBbox / ML zip is forbidden.
 */

import type { Sql } from "postgres";

import { isUsablePropId, normalizeForJoin } from "@hauska-engine/atoms";

import { geometryOuterRing } from "./geo.js";
import { resolveFootprintRoute } from "./resolve-footprint-route.js";
import {
  classifyOverlapRatio,
  footprintParcelOverlapRatio,
  type JoinFootprintsResult,
} from "./spatial-join.js";
import type {
  BboxWgs84,
  CountyBuildingFootprintPlan,
  FootprintJoinResult,
  MlFootprintFeature,
  ParcelFootprintInput,
  ParcelRecord,
  PlannedBuildingFootprint,
  RingLngLat,
} from "./types.js";

export const STAGED_FOOTPRINT_TABLE = "tx_building_footprint";

export const STAGED_FOOTPRINT_TABLE_MISSING = "STAGED_FOOTPRINT_TABLE_MISSING";
export const STAGED_FOOTPRINT_COUNTY_EMPTY = "STAGED_FOOTPRINT_COUNTY_EMPTY";
export const STAGED_FOOTPRINT_GEOM_UNREADY = "STAGED_FOOTPRINT_GEOM_UNREADY";

export type StagedFootprintErrorCode =
  | typeof STAGED_FOOTPRINT_TABLE_MISSING
  | typeof STAGED_FOOTPRINT_COUNTY_EMPTY
  | typeof STAGED_FOOTPRINT_GEOM_UNREADY;

export class StagedFootprintError extends Error {
  readonly code: StagedFootprintErrorCode;
  readonly countyFips?: string;

  constructor(
    code: StagedFootprintErrorCode,
    message: string,
    extras?: { countyFips?: string },
  ) {
    super(message);
    this.name = "StagedFootprintError";
    this.code = code;
    this.countyFips = extras?.countyFips;
  }

  toJSON(): {
    code: StagedFootprintErrorCode;
    error: string;
    name: string;
    countyFips?: string;
  } {
    return {
      code: this.code,
      error: this.message,
      name: this.name,
      ...(this.countyFips ? { countyFips: this.countyFips } : {}),
    };
  }
}

function assertTableIdent(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`unsafe staged footprint table identifier: ${table}`);
  }
  return table;
}

export interface StagedFootprintHaltInput {
  tablePresent: boolean;
  geomColumnPresent: boolean;
  gistIndexPresent: boolean;
  countyRowCount: number;
  countyGeomPopulated: number;
  countyFips: string;
}

/**
 * Pure fail-closed gate. Empty county HALTS (does not emit absence atoms).
 * Partial geom on the county is indistinguishable from a miss, so it HALTS.
 */
export function haltStagedFootprintOrThrow(input: StagedFootprintHaltInput): void {
  const { countyFips } = input;
  if (!input.tablePresent) {
    throw new StagedFootprintError(
      STAGED_FOOTPRINT_TABLE_MISSING,
      `${STAGED_FOOTPRINT_TABLE_MISSING}: public.${STAGED_FOOTPRINT_TABLE} is not present — refusing ML zip fallback`,
      { countyFips },
    );
  }
  if (!input.geomColumnPresent || !input.gistIndexPresent) {
    throw new StagedFootprintError(
      STAGED_FOOTPRINT_GEOM_UNREADY,
      `${STAGED_FOOTPRINT_GEOM_UNREADY}: geom column or GiST index missing on ${STAGED_FOOTPRINT_TABLE} — envelope prefilter cannot run`,
      { countyFips },
    );
  }
  if (input.countyRowCount <= 0) {
    throw new StagedFootprintError(
      STAGED_FOOTPRINT_COUNTY_EMPTY,
      `${STAGED_FOOTPRINT_COUNTY_EMPTY}: ${STAGED_FOOTPRINT_TABLE} has 0 rows for county ${countyFips} — HALT, do not emit absence atoms`,
      { countyFips },
    );
  }
  if (input.countyGeomPopulated !== input.countyRowCount) {
    throw new StagedFootprintError(
      STAGED_FOOTPRINT_GEOM_UNREADY,
      `${STAGED_FOOTPRINT_GEOM_UNREADY}: geom populated on ${input.countyGeomPopulated}/${input.countyRowCount} rows for county ${countyFips} — a NULL geom is an invisible footprint`,
      { countyFips },
    );
  }
}

export interface StagedFootprintTableProbe {
  tablePresent: boolean;
  geomColumnPresent: boolean;
  gistIndexPresent: boolean;
  gistIndexName: string | null;
}

export async function probeStagedFootprintTable(
  sql: Sql,
  table: string = STAGED_FOOTPRINT_TABLE,
): Promise<StagedFootprintTableProbe> {
  const ident = assertTableIdent(table);
  const [reg] = await sql<Array<{ reg: string | null }>>`
    SELECT to_regclass(${"public." + ident}) AS reg
  `;
  const tablePresent = reg?.reg != null;
  if (!tablePresent) {
    return {
      tablePresent: false,
      geomColumnPresent: false,
      gistIndexPresent: false,
      gistIndexName: null,
    };
  }

  const [geomCol] = await sql<Array<{ udt_name: string }>>`
    SELECT udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${ident}
      AND column_name = 'geom'
  `;

  const [gist] = await sql<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = ${ident}
      AND indexdef ILIKE '%USING gist%'
      AND indexdef ILIKE '%(geom)%'
    ORDER BY indexname
    LIMIT 1
  `;

  return {
    tablePresent: true,
    geomColumnPresent: geomCol != null,
    gistIndexPresent: gist != null,
    gistIndexName: gist?.indexname ?? null,
  };
}

export async function probeStagedFootprintCounty(
  sql: Sql,
  countyFips: string,
  table: string = STAGED_FOOTPRINT_TABLE,
): Promise<{ countyRowCount: number; countyGeomPopulated: number }> {
  const ident = assertTableIdent(table);
  const [counts] = await sql<
    Array<{ rows_total: number; geom_populated: number }>
  >`
    SELECT count(*)::int AS rows_total, count(geom)::int AS geom_populated
    FROM ${sql(ident)}
    WHERE county_fips = ${countyFips}
  `;
  return {
    countyRowCount: counts?.rows_total ?? 0,
    countyGeomPopulated: counts?.geom_populated ?? 0,
  };
}

export async function assertStagedFootprintCountyReady(
  sql: Sql,
  countyFips: string,
  table: string = STAGED_FOOTPRINT_TABLE,
): Promise<{
  countyRowCount: number;
  gistIndexName: string | null;
}> {
  const tableProbe = await probeStagedFootprintTable(sql, table);
  const county = tableProbe.tablePresent
    ? await probeStagedFootprintCounty(sql, countyFips, table)
    : { countyRowCount: 0, countyGeomPopulated: 0 };
  haltStagedFootprintOrThrow({
    tablePresent: tableProbe.tablePresent,
    geomColumnPresent: tableProbe.geomColumnPresent,
    gistIndexPresent: tableProbe.gistIndexPresent,
    countyRowCount: county.countyRowCount,
    countyGeomPopulated: county.countyGeomPopulated,
    countyFips,
  });
  return {
    countyRowCount: county.countyRowCount,
    gistIndexName: tableProbe.gistIndexName,
  };
}

/**
 * Candidate prefilter SQL. ST_Intersects against the parcel envelope is NOT
 * an attach. Attach is footprintParcelOverlapRatio in JS.
 */
export function stagedEnvelopeCandidatesSql(
  table: string = STAGED_FOOTPRINT_TABLE,
): string {
  const ident = assertTableIdent(table);
  return `
  SELECT p.ord::int AS ord,
         fp.footprint_id,
         fp.geometry
  FROM unnest($1::int[], $2::float8[], $3::float8[], $4::float8[], $5::float8[])
    AS p(ord, west, south, east, north)
  JOIN ${ident} fp
    ON fp.county_fips = $6
   AND fp.geom IS NOT NULL
   AND ST_Intersects(
         fp.geom,
         ST_MakeEnvelope(p.west, p.south, p.east, p.north, 4326)
       )
`;
}

export interface StagedEnvelopeCandidateRow {
  ord: number;
  footprintId: string;
  geometry: unknown;
}

export async function loadStagedEnvelopeCandidates(
  sql: Sql,
  opts: {
    countyFips: string;
    envelopes: ReadonlyArray<BboxWgs84>;
    table?: string;
    batchSize?: number;
  },
): Promise<StagedEnvelopeCandidateRow[]> {
  const table = assertTableIdent(opts.table ?? STAGED_FOOTPRINT_TABLE);
  const sqlText = stagedEnvelopeCandidatesSql(table);
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const out: StagedEnvelopeCandidateRow[] = [];

  for (let i = 0; i < opts.envelopes.length; i += batchSize) {
    const slice = opts.envelopes.slice(i, i + batchSize);
    const ords = slice.map((_, j) => i + j);
    const wests = slice.map((e) => e.westLng);
    const souths = slice.map((e) => e.southLat);
    const easts = slice.map((e) => e.eastLng);
    const norths = slice.map((e) => e.northLat);
    const rows = await sql.unsafe<
      Array<{ ord: number; footprint_id: string; geometry: unknown }>
    >(sqlText, [ords, wests, souths, easts, norths, opts.countyFips]);
    for (const row of rows) {
      out.push({
        ord: row.ord,
        footprintId: String(row.footprint_id),
        geometry: row.geometry,
      });
    }
  }
  return out;
}

export function envelopeOfRing(ring: RingLngLat): BboxWgs84 {
  let westLng = Infinity;
  let southLat = Infinity;
  let eastLng = -Infinity;
  let northLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < westLng) westLng = lng;
    if (lng > eastLng) eastLng = lng;
    if (lat < southLat) southLat = lat;
    if (lat > northLat) northLat = lat;
  }
  return { westLng, southLat, eastLng, northLat };
}

export function geometryTrueAttach(
  footprintRing: RingLngLat,
  parcelRing: RingLngLat,
): {
  attach: boolean;
  overlapRatio: number;
  structureRole: FootprintJoinResult["structureRole"];
  flag?: "straddle-review";
} {
  const overlapRatio = footprintParcelOverlapRatio(footprintRing, parcelRing);
  const cls = classifyOverlapRatio(overlapRatio);
  return { overlapRatio, ...cls };
}

export interface StagedCandidatePair {
  parcel: ParcelRecord;
  footprint: MlFootprintFeature;
}

/**
 * Attach from envelope-prefiltered pairs. A pair existing (bbox/envelope hit)
 * is not sufficient — overlap ratio must clear the 10% floor.
 */
export function joinStagedCandidatePairs(
  pairs: ReadonlyArray<StagedCandidatePair>,
  rosterParcels: ReadonlyArray<ParcelRecord>,
): JoinFootprintsResult {
  const byFootprint = new Map<
    string,
    { fp: MlFootprintFeature; parcels: ParcelRecord[] }
  >();

  for (const pair of pairs) {
    const existing = byFootprint.get(pair.footprint.footprintId);
    if (existing) {
      if (
        !existing.parcels.some(
          (p) => p.parcelNodeId === pair.parcel.parcelNodeId,
        )
      ) {
        existing.parcels.push(pair.parcel);
      }
    } else {
      byFootprint.set(pair.footprint.footprintId, {
        fp: pair.footprint,
        parcels: [pair.parcel],
      });
    }
  }

  const byParcel = new Map<string, FootprintJoinResult[]>();
  let footprintsJoined = 0;
  let orphanRejected = 0;

  for (const { fp, parcels } of byFootprint.values()) {
    let bestParcel: string | null = null;
    let bestRatio = 0;
    let bestClass: ReturnType<typeof classifyOverlapRatio> | null = null;

    for (const parcel of parcels) {
      const verdict = geometryTrueAttach(fp.ring, parcel.ring);
      if (verdict.attach && verdict.overlapRatio > bestRatio) {
        bestRatio = verdict.overlapRatio;
        bestParcel = parcel.parcelNodeId;
        bestClass = {
          attach: verdict.attach,
          structureRole: verdict.structureRole,
          ...(verdict.flag ? { flag: verdict.flag } : {}),
        };
      }
    }

    if (bestParcel && bestClass) {
      const existing = byParcel.get(bestParcel) ?? [];
      const footprintId =
        existing.length === 0 ? "primary" : `accessory-${existing.length}`;
      const entry: FootprintJoinResult = {
        footprintId,
        mlFeatureId: fp.footprintId,
        overlapRatio: Math.round(bestRatio * 10000) / 10000,
        structureRole:
          existing.length === 0 ? "primary" : bestClass.structureRole,
        ring: fp.ring,
        ...(bestClass.flag ? { flag: bestClass.flag } : {}),
      };
      existing.push(entry);
      byParcel.set(bestParcel, existing);
      footprintsJoined += 1;
    } else {
      orphanRejected += 1;
    }
  }

  const parcelsWithFootprint = byParcel.size;
  const parcelsAbsentSentinel = rosterParcels.length - parcelsWithFootprint;

  return {
    byParcel,
    footprintsJoined,
    orphanRejected,
    parcelsWithFootprint,
    parcelsAbsentSentinel,
  };
}

export function candidatePairsFromEnvelopeRows(
  parcels: ReadonlyArray<ParcelRecord>,
  rows: ReadonlyArray<StagedEnvelopeCandidateRow>,
): StagedCandidatePair[] {
  const pairs: StagedCandidatePair[] = [];
  for (const row of rows) {
    const parcel = parcels[row.ord];
    if (!parcel) continue;
    const ring = geometryOuterRing(row.geometry);
    if (!ring) continue;
    pairs.push({
      parcel,
      footprint: { footprintId: row.footprintId, ring },
    });
  }
  return pairs;
}

export function selectStagedJoinRoster(
  parcels: ReadonlyArray<ParcelFootprintInput & { envelope?: BboxWgs84 | null }>,
  countyFips: string,
): {
  joinParcels: ParcelRecord[];
  envelopes: BboxWgs84[];
  skippedUnusableKey: number;
  skippedNoRing: number;
} {
  const joinParcels: ParcelRecord[] = [];
  const envelopes: BboxWgs84[] = [];
  let skippedUnusableKey = 0;
  let skippedNoRing = 0;
  const seenKeys = new Set<string>();

  for (const parcel of parcels) {
    if (!isUsablePropId(parcel.parcelKey)) {
      skippedUnusableKey += 1;
      continue;
    }
    const parcelKey = normalizeForJoin(parcel.parcelKey);
    if (seenKeys.has(parcelKey)) continue;
    seenKeys.add(parcelKey);
    if (!parcel.ring || parcel.ring.length < 4) {
      skippedNoRing += 1;
      continue;
    }
    const envelope = parcel.envelope ?? envelopeOfRing(parcel.ring);
    joinParcels.push({
      parcelNodeId: `${countyFips}:${parcelKey}`,
      propId: parcelKey,
      fips: countyFips,
      ring: parcel.ring,
    });
    envelopes.push(envelope);
  }
  return { joinParcels, envelopes, skippedUnusableKey, skippedNoRing };
}

export async function planCountyStagedFootprints(
  sql: Sql,
  parcels: ReadonlyArray<ParcelFootprintInput & { envelope?: BboxWgs84 | null }>,
  opts: { countyFips: string; table?: string; batchSize?: number },
): Promise<{
  plan: CountyBuildingFootprintPlan;
  envelopeCandidates: number;
  uniqueCandidateFootprints: number;
}> {
  const roster = selectStagedJoinRoster(parcels, opts.countyFips);
  const candidateRows = await loadStagedEnvelopeCandidates(sql, {
    countyFips: opts.countyFips,
    envelopes: roster.envelopes,
    table: opts.table,
    batchSize: opts.batchSize,
  });
  const pairs = candidatePairsFromEnvelopeRows(roster.joinParcels, candidateRows);
  const join = joinStagedCandidatePairs(pairs, roster.joinParcels);
  const uniqueCandidateFootprints = new Set(
    pairs.map((pair) => pair.footprint.footprintId),
  ).size;
  const plan = planCountyFromStagedGeometryTrueJoin(parcels, join, {
    countyFips: opts.countyFips,
    featuresRead: uniqueCandidateFootprints,
  });
  return {
    plan,
    envelopeCandidates: candidateRows.length,
    uniqueCandidateFootprints,
  };
}

/**
 * County plan from a geometry-true staged join. Never emits
 * county-coverage-absent: an empty staged county already halted.
 */
export function planCountyFromStagedGeometryTrueJoin(
  parcels: ReadonlyArray<ParcelFootprintInput>,
  join: JoinFootprintsResult,
  opts: {
    countyFips: string;
    featuresRead: number;
  },
): CountyBuildingFootprintPlan {
  const route = resolveFootprintRoute();
  const planned: PlannedBuildingFootprint[] = [];
  let skippedUnusableKey = 0;
  let skippedNoRing = 0;
  const joinParcels: ParcelRecord[] = [];
  const seenKeys = new Set<string>();

  for (const parcel of parcels) {
    if (!isUsablePropId(parcel.parcelKey)) {
      skippedUnusableKey += 1;
      continue;
    }
    const parcelKey = normalizeForJoin(parcel.parcelKey);
    if (seenKeys.has(parcelKey)) continue;
    seenKeys.add(parcelKey);

    if (!parcel.ring || parcel.ring.length < 4) {
      skippedNoRing += 1;
      planned.push({
        outcome: "absent-per-parcel",
        parcelKey,
        absenceKind: "no-footprint-feature",
        reason: `no usable parcel ring for ${opts.countyFips}:${parcelKey}`,
      });
      continue;
    }

    joinParcels.push({
      parcelNodeId: `${opts.countyFips}:${parcelKey}`,
      propId: parcelKey,
      fips: opts.countyFips,
      ring: parcel.ring,
    });
  }

  for (const record of joinParcels) {
    const joined = join.byParcel.get(record.parcelNodeId);
    if (joined && joined.length > 0) {
      for (const j of joined) {
        planned.push({
          outcome: "present",
          parcelKey: record.propId,
          footprintId: j.footprintId,
          mlFeatureId: j.mlFeatureId,
          ring: j.ring,
          structureRole: j.structureRole,
          overlapRatio: j.overlapRatio,
          ...(j.flag ? { flag: j.flag } : {}),
        });
      }
    } else {
      planned.push({
        outcome: "absent-per-parcel",
        parcelKey: record.propId,
        absenceKind: "no-footprint-feature",
        reason:
          "staged-geometry-true-join-below-10pct-overlap-threshold — no qualifying staged footprint for parcel",
      });
    }
  }

  const present = planned.filter((p) => p.outcome === "present").length;
  const absentPerParcel = planned.filter(
    (p) => p.outcome === "absent-per-parcel",
  ).length;
  const countyCoverageAbsent = planned.filter(
    (p) => p.outcome === "county-coverage-absent",
  ).length;

  return {
    countyFips: opts.countyFips,
    route,
    parcelsRead: parcels.length,
    featuresRead: opts.featuresRead,
    mlEmptyBbox: false,
    planned,
    joinStats: join,
    counts: {
      present,
      absentPerParcel,
      countyCoverageAbsent,
      skippedUnusableKey,
      skippedNoRing,
    },
  };
}
