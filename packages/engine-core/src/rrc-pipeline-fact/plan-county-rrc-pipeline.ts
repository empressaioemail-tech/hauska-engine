/**
 * `rrc-pipeline-fact` COUNTY PLANNER.
 *
 * Evaluates parcel boundary rings against staged `tx_rrc_pipeline` line
 * segments within bufferMeters. Outside buffer → PRESENT nearPipeline=false.
 * Empty pipeline index after successful read → same (no pipes in county).
 * Missing geometry → typed absence no-parcel-geometry.
 *
 * Dedupe key before nearest-pipeline claim: `t4permit|p5_num` (never operator).
 */

import { RRC_PIPELINE_DEFAULT_BUFFER_METERS } from "@empressaio/atom-contract/property";

import {
  expandBbox,
  lineStringsFromGeoJson,
  minEdgeToLineDistanceMeters,
  ringBbox,
  ringsFromGeoJson,
  type BBox,
  type LngLat,
} from "../rail-corridor-fact/geo.js";

export interface PipelineParcelInput {
  parcelKey: string;
  geometry: unknown | null;
}

/** One staged row from `tx_rrc_pipeline` (possibly county-split). */
export interface PipelineSegmentFeature {
  pipelineRowId: string;
  t4permit: string | null;
  p5Num: string | null;
  operatorName: string | null;
  systemName: string | null;
  commodity: string | null;
  commodityDescription: string | null;
  systemType: string | null;
  status: string | null;
  diameter: number | null;
  interstate: boolean | string | null;
  geometry: unknown;
  westLng: number;
  southLat: number;
  eastLng: number;
  northLat: number;
}

export interface PlannedPresentRrcPipeline {
  outcome: "present";
  parcelKey: string;
  nearPipeline: boolean;
  bufferMeters: number;
  nearestPipelineDistanceMeters?: number;
  t4permit?: string;
  p5Num?: string;
  operatorName?: string;
  systemName?: string;
  commodity?: string;
  commodityDescription?: string;
  systemType?: string;
  status?: string;
  diameter?: number;
  interstate?: boolean | string;
}

export interface PlannedAbsentRrcPipeline {
  outcome: "absent";
  parcelKey: string;
  absenceKind: "no-pipeline-coverage" | "no-parcel-geometry";
  reason: string;
  bufferMeters: number;
}

export type PlannedRrcPipeline =
  | PlannedPresentRrcPipeline
  | PlannedAbsentRrcPipeline;

export interface CountyRrcPipelinePlan {
  countyFips: string;
  bufferMeters: number;
  pipelinesIndexed: number;
  pipelinesDeduped: number;
  sourceReadFailed: boolean;
  parcelsRead: number;
  planned: ReadonlyArray<PlannedRrcPipeline>;
  counts: {
    present: number;
    presentNear: number;
    presentOutside: number;
    absent: number;
    skippedUnusableKey: number;
  };
}

/** CP1 locked: never operator name. One physical pipeline → many county-split rows. */
export function pipelineDedupeKey(seg: {
  t4permit: string | null;
  p5Num: string | null;
}): string {
  return `${seg.t4permit ?? ""}|${seg.p5Num ?? ""}`;
}

function filterSegmentsByBbox(
  segments: ReadonlyArray<PipelineSegmentFeature>,
  bbox: BBox,
): PipelineSegmentFeature[] {
  return segments.filter(
    (s) =>
      s.eastLng >= bbox.westLng &&
      s.westLng <= bbox.eastLng &&
      s.northLat >= bbox.southLat &&
      s.southLat <= bbox.northLat,
  );
}

interface NearestPipelineClaim {
  near: boolean;
  nearestMeters: number;
  t4permit?: string;
  p5Num?: string;
  operatorName?: string;
  systemName?: string;
  commodity?: string;
  commodityDescription?: string;
  systemType?: string;
  status?: string;
  diameter?: number;
  interstate?: boolean | string;
}

/**
 * Dedupe segments on t4permit|p5_num, then take min edge-to-line distance per
 * physical pipeline, then pick the nearest pipeline for the parcel claim.
 */
function evaluateNearPipeline(
  parcelRings: ReadonlyArray<ReadonlyArray<LngLat>>,
  bufferMeters: number,
  segments: ReadonlyArray<PipelineSegmentFeature>,
): NearestPipelineClaim {
  const parcelBbox = parcelRings.map(ringBbox).find(Boolean);
  if (!parcelBbox) {
    return { near: false, nearestMeters: Number.POSITIVE_INFINITY };
  }
  const queryBbox = expandBbox(parcelBbox, bufferMeters);
  const candidates = filterSegmentsByBbox(segments, queryBbox);

  const byKey = new Map<
    string,
    {
      minDist: number;
      sample: PipelineSegmentFeature;
    }
  >();

  for (const seg of candidates) {
    const key = pipelineDedupeKey(seg);
    const lines = lineStringsFromGeoJson(seg.geometry);
    if (lines.length === 0) continue;
    const dist = minEdgeToLineDistanceMeters(parcelRings, lines);
    const prev = byKey.get(key);
    if (!prev || dist < prev.minDist) {
      byKey.set(key, { minDist: dist, sample: seg });
    }
  }

  let nearest = Number.POSITIVE_INFINITY;
  let best: PipelineSegmentFeature | undefined;
  for (const entry of byKey.values()) {
    if (entry.minDist < nearest) {
      nearest = entry.minDist;
      best = entry.sample;
    }
  }

  if (!best || nearest > bufferMeters) {
    return { near: false, nearestMeters: nearest };
  }

  return {
    near: true,
    nearestMeters: nearest,
    ...(best.t4permit ? { t4permit: best.t4permit } : {}),
    ...(best.p5Num ? { p5Num: best.p5Num } : {}),
    ...(best.operatorName ? { operatorName: best.operatorName } : {}),
    ...(best.systemName ? { systemName: best.systemName } : {}),
    ...(best.commodity ? { commodity: best.commodity } : {}),
    ...(best.commodityDescription
      ? { commodityDescription: best.commodityDescription }
      : {}),
    ...(best.systemType ? { systemType: best.systemType } : {}),
    ...(best.status ? { status: best.status } : {}),
    ...(best.diameter != null && Number.isFinite(best.diameter)
      ? { diameter: best.diameter }
      : {}),
    ...(best.interstate !== null && best.interstate !== undefined
      ? { interstate: best.interstate }
      : {}),
  };
}

export function countDedupedPipelines(
  segments: ReadonlyArray<PipelineSegmentFeature>,
): number {
  const keys = new Set<string>();
  for (const seg of segments) keys.add(pipelineDedupeKey(seg));
  return keys.size;
}

export function planCountyRrcPipeline(
  parcels: ReadonlyArray<PipelineParcelInput>,
  segments: ReadonlyArray<PipelineSegmentFeature>,
  opts: {
    countyFips: string;
    bufferMeters?: number;
    sourceReadFailed?: boolean;
  },
): CountyRrcPipelinePlan {
  const bufferMeters = opts.bufferMeters ?? RRC_PIPELINE_DEFAULT_BUFFER_METERS;
  const sourceReadFailed = opts.sourceReadFailed === true;
  const planned: PlannedRrcPipeline[] = [];
  let skippedUnusableKey = 0;
  let presentNear = 0;
  let presentOutside = 0;
  const seen = new Set<string>();

  for (const parcel of parcels) {
    const key = parcel.parcelKey?.trim() ?? "";
    if (!key || /^0+$/.test(key)) {
      skippedUnusableKey += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const rings = parcel.geometry ? ringsFromGeoJson(parcel.geometry) : [];
    if (rings.length === 0) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-parcel-geometry",
        reason: `no usable parcel ring geometry for ${opts.countyFips}:${key}`,
        bufferMeters,
      });
      continue;
    }

    if (sourceReadFailed) {
      planned.push({
        outcome: "absent",
        parcelKey: key,
        absenceKind: "no-pipeline-coverage",
        reason: `tx_rrc_pipeline source read failed for county ${opts.countyFips} — cannot evaluate pipeline proximity`,
        bufferMeters,
      });
      continue;
    }

    // Empty pipeline index after successful read → PRESENT nearPipeline false
    // for all (honest; county has no pipes), NOT mass absence.
    const evalResult = evaluateNearPipeline(rings, bufferMeters, segments);
    if (!evalResult.near) {
      planned.push({
        outcome: "present",
        parcelKey: key,
        nearPipeline: false,
        bufferMeters,
      });
      presentOutside += 1;
      continue;
    }

    planned.push({
      outcome: "present",
      parcelKey: key,
      nearPipeline: true,
      bufferMeters,
      nearestPipelineDistanceMeters:
        Math.round(evalResult.nearestMeters * 10) / 10,
      ...(evalResult.t4permit ? { t4permit: evalResult.t4permit } : {}),
      ...(evalResult.p5Num ? { p5Num: evalResult.p5Num } : {}),
      ...(evalResult.operatorName
        ? { operatorName: evalResult.operatorName }
        : {}),
      ...(evalResult.systemName ? { systemName: evalResult.systemName } : {}),
      ...(evalResult.commodity ? { commodity: evalResult.commodity } : {}),
      ...(evalResult.commodityDescription
        ? { commodityDescription: evalResult.commodityDescription }
        : {}),
      ...(evalResult.systemType ? { systemType: evalResult.systemType } : {}),
      ...(evalResult.status ? { status: evalResult.status } : {}),
      ...(evalResult.diameter !== undefined
        ? { diameter: evalResult.diameter }
        : {}),
      ...(evalResult.interstate !== undefined
        ? { interstate: evalResult.interstate }
        : {}),
    });
    presentNear += 1;
  }

  return {
    countyFips: opts.countyFips,
    bufferMeters,
    pipelinesIndexed: segments.length,
    pipelinesDeduped: countDedupedPipelines(segments),
    sourceReadFailed,
    parcelsRead: parcels.length,
    planned,
    counts: {
      present: planned.filter((p) => p.outcome === "present").length,
      presentNear,
      presentOutside,
      absent: planned.filter((p) => p.outcome === "absent").length,
      skippedUnusableKey,
    },
  };
}
