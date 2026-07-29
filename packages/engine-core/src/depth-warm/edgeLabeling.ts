/**
 * Automated per-edge road proximity labeling for depth-warm (27c R4).
 *
 * Honest rules:
 * - roadClass + osmHighwayTag only when an edge is within proximity of a road centerline.
 * - At most one primary front. When the parcel's SITUS street name unambiguously
 *   token-matches exactly one adjacent road-facing edge, that edge is front
 *   (frontBasis "situs-street-match"). Otherwise the existing proximity
 *   heuristic picks the front (frontBasis "adjacency-heuristic").
 * - Alley-backed edges may carry alley roadClass on rear only.
 * - Unroaded edges stay side/rear without roadClass — never fabricate setbacks.
 */

import type { RoadClassification } from "@hauska-engine/atoms";

import { projectRing, type Ring } from "./geometry.js";
import type { WarmEdgeRole, WarmRoadProvenanceKind, WarmRoadSource } from "./types.js";

/** Default max metres from edge midpoint to road centerline. */
export const DEFAULT_ROAD_PROXIMITY_THRESHOLD_M = 25;

/** OSM highway tags that must never win front labeling (pedestrian / non-ROW). */
export const FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS = new Set([
  "footway",
  "path",
  "steps",
  "cycleway",
  "pedestrian",
  "bridleway",
  "corridor",
  "platform",
  "bus_guideway",
  "proposed",
  "construction",
]);

export function isFrontEligibleRoad(road: WarmRoadSource): boolean {
  if (
    road.provenanceKind === "county-roadway-authoritative" ||
    road.provenanceKind === "county-surveyed-2016"
  ) {
    return road.classification !== "alley";
  }
  const tag = road.osmHighwayTag?.trim().toLowerCase() ?? "";
  if (!tag || tag === "county-surveyed" || tag === "county-roadway") return true;
  return !FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS.has(tag);
}

function countyProvenanceRank(kind: WarmRoadProvenanceKind | undefined): number {
  if (kind === "county-roadway-authoritative") return 3;
  if (kind === "county-surveyed-2016") return 2;
  return 1;
}

function preferRoadHit(current: EdgeRoadHit | undefined, candidate: EdgeRoadHit): EdgeRoadHit {
  if (!current) return candidate;
  const currentRank = countyProvenanceRank(current.road.provenanceKind);
  const candidateRank = countyProvenanceRank(candidate.road.provenanceKind);
  if (candidateRank > currentRank) return candidate;
  if (currentRank > candidateRank) return current;
  return candidate.distanceM < current.distanceM ? candidate : current;
}

/** How the front edge was chosen — recorded on the atom body so surfaces can cite it. */
export type FrontRoleBasis = "situs-street-match" | "adjacency-heuristic";

export interface EdgeLabelDraft {
  index: number;
  label: WarmEdgeRole;
  roadClass?: RoadClassification;
  osmHighwayTag?: string;
  osmSurfaceTag?: string;
  roadProvenanceKind?: import("./types.js").WarmRoadProvenanceKind;
  /** Present on the front edge only: which rule picked it. */
  frontBasis?: FrontRoleBasis;
  /** Road identity of the hit backing this label (front/rear/side_corner). */
  osmWayId?: number;
}

/** Street-suffix tokens treated as equivalent noise for situs-vs-road matching. */
const STREET_SUFFIX_TOKENS = new Set([
  "ST",
  "STREET",
  "DR",
  "DRIVE",
  "RD",
  "ROAD",
  "AVE",
  "AV",
  "AVENUE",
  "LN",
  "LANE",
  "CT",
  "COURT",
  "BLVD",
  "BOULEVARD",
  "HWY",
  "HIGHWAY",
  "PKWY",
  "PARKWAY",
  "CIR",
  "CIRCLE",
  "PL",
  "PLACE",
  "TRL",
  "TRAIL",
  "WAY",
  "TER",
  "TERRACE",
  "LOOP",
  "CV",
  "COVE",
  "PT",
  "POINT",
  "BND",
  "BEND",
  "XING",
  "CROSSING",
  "SQ",
  "SQUARE",
  "PASS",
  "PATH",
  "RUN",
]);

const DIRECTIONAL_TOKENS = new Set([
  "N",
  "S",
  "E",
  "W",
  "NE",
  "NW",
  "SE",
  "SW",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
]);

/** Unit designators — everything from the designator onward is dropped. */
const UNIT_CUT_RE =
  /\b(APT|APARTMENT|UNIT|STE|SUITE|BLDG|BUILDING|LOT|TRLR|FL|RM|BOX)\b.*$/;

/**
 * Normalize a situs address or road display name to a comparable street-name
 * core: uppercase, punctuation stripped, leading house number + unit dropped,
 * leading/trailing directionals dropped, trailing suffix type dropped
 * (ST == STREET, DR == DRIVE, ...). Never strips a token when doing so would
 * empty the name (a street literally named "West Street" keeps "WEST").
 * Returns "" when no comparable core remains.
 */
/**
 * The street segment of a situs address: everything before the first comma
 * ("901 PECAN ST , BASTROP, TX 78602" → "901 PECAN ST"). A bare street name
 * (no comma) passes through unchanged.
 */
export function situsStreetSegment(raw: string): string {
  const i = raw.indexOf(",");
  return i >= 0 ? raw.slice(0, i) : raw;
}

export function normalizeStreetNameForMatch(raw: string): string {
  let text = raw
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text.replace(UNIT_CUT_RE, "").trim();
  let tokens = text.split(" ").filter(Boolean);
  // Leading house number (901, 901A) — only ever leading, only when more remains.
  if (tokens.length > 1 && /^\d+[A-Z]?$/.test(tokens[0]!)) tokens = tokens.slice(1);
  // Trailing directional, then trailing suffix, then leading directional —
  // this order keeps "West Street" as WEST and turns "N Main St" into MAIN.
  if (tokens.length > 1 && DIRECTIONAL_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length > 1 && STREET_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length > 1 && DIRECTIONAL_TOKENS.has(tokens[0]!)) tokens = tokens.slice(1);
  return tokens.join(" ");
}

export type LabelEdgesResult =
  | { ok: true; edgeLabels: EdgeLabelDraft[] }
  | { ok: false; decline: string };

interface XY {
  x: number;
  y: number;
}

interface EdgeRoadHit {
  edgeIndex: number;
  distanceM: number;
  road: WarmRoadSource;
}

function midpoint(a: XY, b: XY): XY {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distPointToSegment(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

function projectPolylineInFrame(
  polyline: Ring,
  frame: ReturnType<typeof projectRing>,
): XY[] | null {
  if (!frame) return null;
  return polyline.map(([lng, lat]) => ({
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  }));
}

function minDistanceEdgeToPolyline(a: XY, b: XY, poly: XY[]): number {
  const mid = midpoint(a, b);
  let minD = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distPointToSegment(mid, poly[i]!, poly[i + 1]!);
    if (d < minD) minD = d;
  }
  if (poly.length === 1) {
    minD = Math.hypot(mid.x - poly[0]!.x, mid.y - poly[0]!.y);
  }
  return minD;
}

function isAlleyClassification(classification: RoadClassification): boolean {
  return classification === "alley";
}

function frontStreetPreference(classification: RoadClassification): number {
  if (classification === "residential") return 5;
  if (classification === "unclassified") return 4;
  if (classification === "minor_collector") return 3;
  if (classification === "major_collector") return 2;
  if (classification === "highway") return 1;
  return 0;
}

/**
 * Label parcel edges from road proximity. Returns decline when no edge is road-adjacent.
 */
export function labelEdgesFromRoads(input: {
  parcelRing: Ring;
  roads: ReadonlyArray<WarmRoadSource>;
  proximityThresholdM?: number;
  /**
   * Optional parcel situs address (e.g. "901 PECAN ST"). When its street name
   * token-matches exactly one road-adjacent edge's road displayName, that edge
   * is front. Absent / no match / ambiguous → adjacency heuristic, unchanged.
   */
  situsAddress?: string | null;
}): LabelEdgesResult {
  const threshold = input.proximityThresholdM ?? DEFAULT_ROAD_PROXIMITY_THRESHOLD_M;
  const proj = projectRing(input.parcelRing);
  if (!proj || proj.points.length < 3) {
    return { ok: false, decline: "invalid-parcel-ring" };
  }
  if (input.roads.length === 0) {
    return { ok: false, decline: "no-roads-available" };
  }

  const n = proj.points.length;
  const hits: EdgeRoadHit[] = [];

  for (let i = 0; i < n; i++) {
    const a = proj.points[i]!;
    const b = proj.points[(i + 1) % n]!;
    for (const road of input.roads) {
      const poly = projectPolylineInFrame(road.polyline, proj);
      if (!poly || poly.length < 1) continue;
      const distanceM = minDistanceEdgeToPolyline(a, b, poly);
      if (distanceM <= threshold) {
        hits.push({ edgeIndex: i, distanceM, road });
      }
    }
  }

  if (hits.length === 0) {
    return { ok: false, decline: "no-road-adjacency" };
  }

  const bestByEdge = new Map<number, EdgeRoadHit>();
  for (const hit of hits) {
    const prior = bestByEdge.get(hit.edgeIndex);
    bestByEdge.set(hit.edgeIndex, preferRoadHit(prior, hit));
  }

  const bestEligibleNonAlleyByEdge = new Map<number, EdgeRoadHit>();
  for (const hit of hits) {
    if (isAlleyClassification(hit.road.classification)) continue;
    if (!isFrontEligibleRoad(hit.road)) continue;
    const prior = bestEligibleNonAlleyByEdge.get(hit.edgeIndex);
    bestEligibleNonAlleyByEdge.set(hit.edgeIndex, preferRoadHit(prior, hit));
  }

  const frontCandidates = [...bestEligibleNonAlleyByEdge.values()];
  const alleyHits = [...bestByEdge.values()].filter((h) =>
    isAlleyClassification(h.road.classification),
  );

  let frontHit: EdgeRoadHit | null = null;
  let frontBasis: FrontRoleBasis = "adjacency-heuristic";

  // Situs-street preference: when the parcel's address street is among the
  // adjacent roads and matches exactly one edge, that edge is front.
  // The situs is often a FULL address ("901 PECAN ST , BASTROP, TX 78602") —
  // the normalizer's punctuation strip turns the comma into a space, so the
  // city/state/zip tail would survive into the key and never match a road
  // name. Cut at the first comma (the street segment) BEFORE normalizing.
  // (Live-caught 2026-07-29: txgio situs is 100%-populated full addresses;
  // the county-wide restamp silently fell back to the heuristic without this.)
  const situsKey = input.situsAddress
    ? normalizeStreetNameForMatch(situsStreetSegment(input.situsAddress))
    : "";
  if (situsKey) {
    const situsMatchByEdge = new Map<number, EdgeRoadHit>();
    for (const hit of hits) {
      if (isAlleyClassification(hit.road.classification)) continue;
      if (!isFrontEligibleRoad(hit.road)) continue;
      const roadKey = hit.road.name ? normalizeStreetNameForMatch(hit.road.name) : "";
      if (!roadKey || roadKey !== situsKey) continue;
      const prior = situsMatchByEdge.get(hit.edgeIndex);
      situsMatchByEdge.set(hit.edgeIndex, preferRoadHit(prior, hit));
    }
    // Exactly one matching edge → unambiguous. Zero → no match. Two or more
    // (corner lot on a curving street) → ambiguous; fall through unchanged.
    if (situsMatchByEdge.size === 1) {
      frontHit = [...situsMatchByEdge.values()][0]!;
      frontBasis = "situs-street-match";
    }
  }

  if (!frontHit && frontCandidates.length > 0) {
    frontCandidates.sort((a, b) => {
      const pref =
        frontStreetPreference(b.road.classification) -
        frontStreetPreference(a.road.classification);
      if (pref !== 0) return pref;
      return a.distanceM - b.distanceM;
    });
    frontHit = frontCandidates[0]!;
    frontBasis = "adjacency-heuristic";
  }

  let rearHit: EdgeRoadHit | null = null;
  if (alleyHits.length > 0) {
    alleyHits.sort((a, b) => a.distanceM - b.distanceM);
    rearHit =
      alleyHits.find((h) => h.edgeIndex !== frontHit?.edgeIndex) ?? alleyHits[0]!;
  } else if (frontHit && n >= 4) {
    const frontMid = midpoint(
      proj.points[frontHit.edgeIndex]!,
      proj.points[(frontHit.edgeIndex + 1) % n]!,
    );
    let maxDist = -1;
    for (const [edgeIndex] of bestByEdge) {
      if (edgeIndex === frontHit.edgeIndex) continue;
      const a = proj.points[edgeIndex]!;
      const b = proj.points[(edgeIndex + 1) % n]!;
      const mid = midpoint(a, b);
      const d = Math.hypot(mid.x - frontMid.x, mid.y - frontMid.y);
      if (d > maxDist) {
        maxDist = d;
        rearHit = { edgeIndex, distanceM: bestByEdge.get(edgeIndex)!.distanceM, road: bestByEdge.get(edgeIndex)!.road };
      }
    }
  }

  const edgeLabels: EdgeLabelDraft[] = [];
  for (let i = 0; i < n; i++) {
    if (frontHit && i === frontHit.edgeIndex) {
      edgeLabels.push({
        index: i,
        label: "front",
        roadClass: frontHit.road.classification,
        osmHighwayTag: frontHit.road.osmHighwayTag,
        osmSurfaceTag: frontHit.road.surface,
        roadProvenanceKind: frontHit.road.provenanceKind ?? "osm-fallback",
        frontBasis,
        osmWayId: frontHit.road.osmWayId,
      });
      continue;
    }
    if (rearHit && i === rearHit.edgeIndex && isAlleyClassification(rearHit.road.classification)) {
      edgeLabels.push({
        index: i,
        label: "rear",
        roadClass: rearHit.road.classification,
        osmHighwayTag: rearHit.road.osmHighwayTag,
        osmSurfaceTag: rearHit.road.surface,
        roadProvenanceKind: rearHit.road.provenanceKind ?? "osm-fallback",
        osmWayId: rearHit.road.osmWayId,
      });
      continue;
    }
    if (rearHit && i === rearHit.edgeIndex) {
      edgeLabels.push({ index: i, label: "rear" });
      continue;
    }
    const hit = bestByEdge.get(i);
    if (
      hit &&
      frontHit &&
      hit.road.osmWayId !== frontHit.road.osmWayId &&
      !isAlleyClassification(hit.road.classification)
    ) {
      edgeLabels.push({
        index: i,
        label: "side_corner",
        roadClass: hit.road.classification,
        osmHighwayTag: hit.road.osmHighwayTag,
        osmSurfaceTag: hit.road.surface,
        roadProvenanceKind: hit.road.provenanceKind ?? "osm-fallback",
        osmWayId: hit.road.osmWayId,
      });
      continue;
    }
    edgeLabels.push({ index: i, label: "side" });
  }

  return { ok: true, edgeLabels };
}
