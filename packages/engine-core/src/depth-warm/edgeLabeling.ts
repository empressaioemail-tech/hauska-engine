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
import { isPedestrianOsmHighwayTag } from "@hauska-engine/atoms";

import { projectRing, type Ring } from "./geometry.js";
import type { WarmEdgeRole, WarmRoadProvenanceKind, WarmRoadSource } from "./types.js";

/** Default max metres from edge midpoint to road centerline. */
export const DEFAULT_ROAD_PROXIMITY_THRESHOLD_M = 25;

/**
 * R33 street-distance sanity guard ratio (2026-08-07, master planner
 * ruling): the chosen front edge's own distance to its matched road must
 * not exceed this multiple of the closest OTHER road-adjacent, front-
 * eligible edge's distance, or the labeling declines rather than serves a
 * suspect front. Calibrated against the verified role-inversion SIGNATURE
 * the independent auditor's street-distance table would have shown had one
 * of the suspected parcels actually been mislabeled (a ~7x ratio, e.g.
 * front at 159ft vs a sibling edge at 22ft) — comfortably above any
 * legitimate same-block variation observed in the real Jones/Higgins
 * dataset (siblings typically within 2x of each other), so this guard
 * only fires on the genuine defect signature, never on ordinary lot-shape
 * variation.
 */
export const FRONT_STREET_DISTANCE_SANITY_RATIO = 3;

/**
 * OSM highway tags that must never win front labeling (pedestrian / non-ROW).
 * Re-export of the atoms package set — ONE taxonomy with isPedestrianWay.
 */
export {
  PEDESTRIAN_OSM_HIGHWAY_TAG_SET as FRONT_INELIGIBLE_OSM_HIGHWAY_TAGS,
  isPedestrianOsmHighwayTag,
} from "@hauska-engine/atoms";

export function isFrontEligibleRoad(road: WarmRoadSource): boolean {
  if (
    road.provenanceKind === "county-roadway-authoritative" ||
    road.provenanceKind === "county-surveyed-2016"
  ) {
    return road.classification !== "alley";
  }
  const tag = road.osmHighwayTag?.trim().toLowerCase() ?? "";
  if (!tag || tag === "county-surveyed" || tag === "county-roadway") return true;
  return !isPedestrianOsmHighwayTag(tag);
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

/** Canonical token expansions for facesAnswer (R33 corollary). */
const STREET_TOKEN_CANONICAL: Record<string, string> = {
  JR: "JUNIOR",
  JUNIOR: "JUNIOR",
  SR: "SENIOR",
  SENIOR: "SENIOR",
};

function canonicalizeStreetTokens(tokens: string[]): string[] {
  return tokens.map((t) => STREET_TOKEN_CANONICAL[t] ?? t);
}

/** Expand abbreviation tokens after suffix/directional stripping (R33). */
export function expandStreetAbbreviationTokens(normalizedCore: string): string {
  if (!normalizedCore.trim()) return "";
  const tokens = normalizedCore.split(" ").filter(Boolean);
  return canonicalizeStreetTokens(tokens).join(" ");
}

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
  const core = tokens.join(" ");
  return expandStreetAbbreviationTokens(core);
}

export type LabelEdgesDeclineReason =
  | "invalid-parcel-ring"
  | "no-roads-available"
  | "no-road-adjacency"
  | "front-orientation-unresolved";

export type LabelEdgesResult =
  | { ok: true; edgeLabels: EdgeLabelDraft[] }
  | { ok: false; decline: LabelEdgesDeclineReason };

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

/** Skip survey-noise / sliver edges when picking rear (80577 edge 0 class). */
const MIN_REAR_CANDIDATE_EDGE_M = 3;

function inwardNormalForEdge(proj: NonNullable<ReturnType<typeof projectRing>>, edgeIndex: number): XY {
  const n = proj.points.length;
  const a = proj.points[edgeIndex]!;
  const b = proj.points[(edgeIndex + 1) % n]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: -dy / len, y: dx / len };
}

function edgeLengthM(proj: NonNullable<ReturnType<typeof projectRing>>, edgeIndex: number): number {
  const n = proj.points.length;
  const a = proj.points[edgeIndex]!;
  const b = proj.points[(edgeIndex + 1) % n]!;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Flag-lot / irregular-lot shape: a short connector edge (< 25% of median length)
 * between two longer edges, or a non-convex vertex turn. Used to promote a
 * same-street body-backing edge from side → rear (Mesquite 80577/80578 class).
 */
export function detectFlagLotShape(proj: NonNullable<ReturnType<typeof projectRing>>): boolean {
  const n = proj.points.length;
  if (n < 5) return false;

  const lengths = Array.from({ length: n }, (_, i) => edgeLengthM(proj, i));
  const nonTiny = lengths.filter((len) => len >= MIN_REAR_CANDIDATE_EDGE_M).sort((a, b) => a - b);
  if (nonTiny.length < 3) return false;
  const median = nonTiny[Math.floor(nonTiny.length / 2)]!;
  const hasNeck = lengths.some(
    (len, i) =>
      len >= MIN_REAR_CANDIDATE_EDGE_M &&
      len <= median * 0.45 &&
      (lengths[(i + n - 1) % n]! >= median * 0.75 || lengths[(i + 1) % n]! >= median * 0.75),
  );
  if (hasNeck) return true;

  // Non-convex vertex — typical flag / L-lot jog.
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = proj.points[i]!;
    const b = proj.points[(i + 1) % n]!;
    const c = proj.points[(i + 2) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return true;
  }
  return false;
}

/**
 * Ordinary lots: rear = farthest road-adjacent edge from the front midpoint.
 * Correct for rectangular / corner lots (34177 Pecan-front class) where rear
 * is road-backed, not the geometric opposite edge.
 */
function selectRearEdgeByFarthestRoadAdjacent(
  proj: NonNullable<ReturnType<typeof projectRing>>,
  frontHit: EdgeRoadHit,
  bestByEdge: ReadonlyMap<number, EdgeRoadHit>,
): EdgeRoadHit | null {
  const n = proj.points.length;
  const frontMid = midpoint(
    proj.points[frontHit.edgeIndex]!,
    proj.points[(frontHit.edgeIndex + 1) % n]!,
  );
  let maxDist = -1;
  let rearHit: EdgeRoadHit | null = null;
  for (const [edgeIndex, hit] of bestByEdge) {
    if (edgeIndex === frontHit.edgeIndex) continue;
    const a = proj.points[edgeIndex]!;
    const b = proj.points[(edgeIndex + 1) % n]!;
    const mid = midpoint(a, b);
    const d = Math.hypot(mid.x - frontMid.x, mid.y - frontMid.y);
    if (d > maxDist) {
      maxDist = d;
      rearHit = hit;
    }
  }
  return rearHit;
}

/**
 * Flag-lot / Mesquite class: rear = the edge whose inward normal best opposes
 * the front edge's inward normal (dot ≈ −1). Fixes elongated rectangles and
 * flag-lot jogs where farthest-road-adjacent mislabels a long side as rear.
 */
function selectRearEdgeByNormalOpposition(
  proj: NonNullable<ReturnType<typeof projectRing>>,
  frontEdgeIndex: number,
): number | null {
  const n = proj.points.length;
  const frontN = inwardNormalForEdge(proj, frontEdgeIndex);
  let bestIndex: number | null = null;
  let bestDot = Infinity;
  for (let i = 0; i < n; i++) {
    if (i === frontEdgeIndex) continue;
    if (edgeLengthM(proj, i) < MIN_REAR_CANDIDATE_EDGE_M) continue;
    const dot = inwardNormalForEdge(proj, i).x * frontN.x + inwardNormalForEdge(proj, i).y * frontN.y;
    if (dot < bestDot) {
      bestDot = dot;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * On flag lots, a body edge that backs the same main road as the front (parallel,
 * same osmWayId, not the front neck) is REAR not SIDE — the backing-yard class
 * Valerie reported on Mesquite St.
 *
 * 2026-08-07 (master planner scoped reopen, 48021:31317 double-frontage
 * corner) — TWO tightenings, both verified against 31317's real ring
 * (a shallow-bend double-segment Jones Street frontage, not a true
 * right-angle corner): the OLD `Math.abs(dot) >= 0.85` parallel test
 * accepted a same-street edge whose inward normal points the SAME
 * direction as front's (dot ~= +0.997, a frontage continuation) as
 * readily as one pointing the OPPOSITE direction (dot ~= -1, a genuine
 * backing edge on the far side) — only the opposite-facing case is
 * geometrically a "rear." And the OLD "farthest wins" depth comparison had
 * no floor: with only ONE same-street candidate at all (31317's edge 1,
 * immediately ADJACENT to front, sharing a vertex — a corner-clip
 * continuation of the same frontage, not a body edge on the far side of
 * the parcel), it trivially "won" the farthest-depth comparison by
 * default and was misclassified rear. Both fixes are additive
 * requirements (a candidate must still pass depth-plausibility once these
 * apply) — the Mesquite St backing-yard case (a genuinely opposing,
 * non-adjacent body edge) is unaffected by either.
 */
function selectFlagLotSameStreetRearEdge(
  hits: ReadonlyArray<EdgeRoadHit>,
  frontHit: EdgeRoadHit,
  proj: NonNullable<ReturnType<typeof projectRing>>,
): number | null {
  if (!detectFlagLotShape(proj)) return null;
  const n = proj.points.length;
  const frontN = inwardNormalForEdge(proj, frontHit.edgeIndex);
  let bestIndex: number | null = null;
  let bestDepth = -1;
  const frontMid = midpoint(
    proj.points[frontHit.edgeIndex]!,
    proj.points[(frontHit.edgeIndex + 1) % proj.points.length]!,
  );
  for (const hit of hits) {
    if (hit.edgeIndex === frontHit.edgeIndex) continue;
    if (hit.road.osmWayId !== frontHit.road.osmWayId) continue;
    if (isAlleyClassification(hit.road.classification)) continue;
    // A genuine backing/rear edge on a flag lot faces AWAY from the front
    // (opposing inward normal); a same-direction normal means this edge is
    // a continuation of the SAME frontage (a shallow-bend jog), never rear.
    const edgeN = inwardNormalForEdge(proj, hit.edgeIndex);
    const dot = edgeN.x * frontN.x + edgeN.y * frontN.y;
    const opposing = dot <= -0.85;
    if (!opposing) continue;
    // A genuine backing edge is NOT immediately adjacent to (does not
    // share a vertex with) the front edge — a shared-vertex same-street
    // neighbor is a corner-clip continuation of the frontage, not a body
    // edge on the far side of the parcel.
    const sharesVertexWithFront =
      hit.edgeIndex === (frontHit.edgeIndex + n - 1) % n ||
      hit.edgeIndex === (frontHit.edgeIndex + 1) % n;
    if (sharesVertexWithFront) continue;
    const a = proj.points[hit.edgeIndex]!;
    const b = proj.points[(hit.edgeIndex + 1) % proj.points.length]!;
    const depth = Math.abs(
      (midpoint(a, b).x - frontMid.x) * frontN.x + (midpoint(a, b).y - frontMid.y) * frontN.y,
    );
    if (depth > bestDepth) {
      bestDepth = depth;
      bestIndex = hit.edgeIndex;
    }
  }
  return bestIndex;
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
    // R30: when situs matches one or more edges, the CLOSEST situs-matching
    // edge wins front (907 Chestnut on a lot hugging Chestnut on two edges).
    // Zero matches → fall through to heuristic or fail-closed below.
    if (situsMatchByEdge.size >= 1) {
      const matches = [...situsMatchByEdge.values()].sort(
        (a, b) => a.distanceM - b.distanceM,
      );
      frontHit = matches[0]!;
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

  // R30 fail-closed: situs was provided but did not match any adjacent road,
  // and the heuristic picked a different street class — decline rather than
  // inset the wrong edge (distant-road / wrong-street frontage).
  if (
    situsKey &&
    !frontHit &&
    frontCandidates.length === 0
  ) {
    return { ok: false, decline: "front-orientation-unresolved" };
  }
  if (situsKey && frontBasis === "adjacency-heuristic" && frontHit) {
    const situsAdjacentEligible = hits.some(
      (h) =>
        !isAlleyClassification(h.road.classification) &&
        isFrontEligibleRoad(h.road) &&
        h.road.name &&
        normalizeStreetNameForMatch(h.road.name) === situsKey,
    );
    if (situsAdjacentEligible) {
      return { ok: false, decline: "front-orientation-unresolved" };
    }
  }

  // R33 street-distance sanity guard (2026-08-07, master planner ruling):
  // cheap insurance modeled on the independent auditor's own street-
  // distance check. A chosen front edge whose OWN distance to its matched
  // road is much larger than another road-adjacent edge's distance to a
  // road of EQUAL OR HIGHER class preference is a labeling error signature
  // (the front candidate that should have won proximity did not, among
  // comparably-or-more-preferred road classes) — fail closed rather than
  // silently promote a wrong-edge front. Scoped to equal-or-higher
  // preference ONLY: the adjacency-heuristic legitimately prefers a
  // farther higher-class-preference road (e.g. a residential street) over
  // a closer LOWER-preference one (e.g. a collector) — verified against
  // 48021:34785's real fixture (front correctly on an unclassified/local
  // edge 3, not the nearer collector) — so a closer LOWER-preference
  // sibling losing to a farther front is the intended, legitimate outcome
  // and must not trip the guard; only a closer-or-equal-distance sibling
  // of EQUAL OR BETTER class standing signals a genuine labeling error.
  // Verified this round
  // that labelEdgesFromRoads' actual front selection was CORRECT on every
  // parcel it was suspected of inverting (coordinate-keyed cross-check
  // against the independent auditor's re-grade), so this guard is not
  // patching a live defect — it is a fail-closed backstop making a future
  // instance of this defect class impossible to silently serve, the same
  // "make the class unrepresentable" principle as the joined-structure
  // clipper-input invariant.
  if (frontHit) {
    const frontPreference = frontStreetPreference(frontHit.road.classification);
    const bestOtherDistanceM = Math.min(
      ...frontCandidates
        .filter(
          (h) =>
            h.edgeIndex !== frontHit!.edgeIndex &&
            frontStreetPreference(h.road.classification) >= frontPreference,
        )
        .map((h) => h.distanceM),
      Infinity,
    );
    if (
      Number.isFinite(bestOtherDistanceM) &&
      bestOtherDistanceM > 0 &&
      frontHit.distanceM > bestOtherDistanceM * FRONT_STREET_DISTANCE_SANITY_RATIO
    ) {
      return { ok: false, decline: "front-orientation-unresolved" };
    }
  }

  let rearHit: EdgeRoadHit | null = null;
  if (alleyHits.length > 0) {
    alleyHits.sort((a, b) => a.distanceM - b.distanceM);
    rearHit =
      alleyHits.find((h) => h.edgeIndex !== frontHit?.edgeIndex) ?? alleyHits[0]!;
  } else if (frontHit && n >= 4) {
    if (detectFlagLotShape(proj)) {
      const flagSameStreetRear = selectFlagLotSameStreetRearEdge(hits, frontHit, proj);
      const rearEdgeIndex =
        flagSameStreetRear ?? selectRearEdgeByNormalOpposition(proj, frontHit.edgeIndex);
      if (rearEdgeIndex != null && rearEdgeIndex !== frontHit.edgeIndex) {
        const roadHit = bestByEdge.get(rearEdgeIndex);
        rearHit = {
          edgeIndex: rearEdgeIndex,
          distanceM: roadHit?.distanceM ?? Infinity,
          road: roadHit?.road ?? frontHit.road,
        };
      }
    } else {
      const nonFrontRoadHits = [...bestByEdge.values()].filter(
        (h) => h.edgeIndex !== frontHit.edgeIndex,
      );
      if (
        nonFrontRoadHits.length === 1 &&
        nonFrontRoadHits[0]!.road.osmWayId !== frontHit.road.osmWayId
      ) {
        // Corner lot: the sole non-front road-adjacent edge faces a
        // DIFFERENT street — rear (34177 class).
        rearHit = nonFrontRoadHits[0]!;
      } else if (
        nonFrontRoadHits.length === 1 &&
        nonFrontRoadHits[0]!.road.osmWayId === frontHit.road.osmWayId
      ) {
        // 2026-08-07 (master planner scoped reopen, 48021:31317) — the sole
        // non-front road-adjacent edge faces the SAME street as front: this
        // is a same-street corner/clipped-corner segment (a parcel boundary
        // jog along one continuous ROW, e.g. 48021:31317's raw edge 1,
        // 16.22ft, 24.09ft from Jones Street — essentially tied with the
        // 23.87ft front edge, and sharing a vertex with it), never a rear.
        // Leaving rearHit unset here lets the side_corner same-street-clip
        // check below (bestEligibleNonAlleyByEdge + shares-vertex-with-front)
        // correctly label it, instead of this heuristic wrongly claiming it
        // as rear first.
      } else if (nonFrontRoadHits.length > 1) {
        const farthestHit = selectRearEdgeByFarthestRoadAdjacent(proj, frontHit, bestByEdge);
        const frontN = inwardNormalForEdge(proj, frontHit.edgeIndex);
        const farthestOpposesFront =
          farthestHit != null &&
          inwardNormalForEdge(proj, farthestHit.edgeIndex).x * frontN.x +
            inwardNormalForEdge(proj, farthestHit.edgeIndex).y * frontN.y <
            -0.5;
        if (farthestHit && farthestOpposesFront) {
          rearHit = farthestHit;
        } else {
          const rearEdgeIndex = selectRearEdgeByNormalOpposition(proj, frontHit.edgeIndex);
          if (rearEdgeIndex != null && rearEdgeIndex !== frontHit.edgeIndex) {
            const roadHit = bestByEdge.get(rearEdgeIndex);
            rearHit = {
              edgeIndex: rearEdgeIndex,
              distanceM: roadHit?.distanceM ?? Infinity,
              road: roadHit?.road ?? frontHit.road,
            };
          } else if (farthestHit) {
            rearHit = farthestHit;
          }
        }
      } else {
        const rearEdgeIndex = selectRearEdgeByNormalOpposition(proj, frontHit.edgeIndex);
        if (rearEdgeIndex != null && rearEdgeIndex !== frontHit.edgeIndex) {
          const roadHit = bestByEdge.get(rearEdgeIndex);
          rearHit = {
            edgeIndex: rearEdgeIndex,
            distanceM: roadHit?.distanceM ?? Infinity,
            road: roadHit?.road ?? frontHit.road,
          };
        }
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
    // 2026-08-07 (master planner scoped reopen, 48021:31317 double-frontage
    // corner) — SAME-STREET corner clip: a genuine corner/clipped-corner
    // lot can have TWO edges both abutting the SAME street (not two
    // different streets), when the parcel boundary jogs along a single
    // continuous ROW (verified ground-truth: 48021:31317's raw edge 1,
    // 16.22ft long, sits 24.09ft from Jones Street — essentially tied with
    // the 23.87ft front edge 2, and shares a vertex with it). The check
    // above only recognizes a corner formed by two DIFFERENT streets
    // (hit.road.osmWayId !== frontHit.road.osmWayId); it never fires here
    // because both edges face the SAME way id, so this edge fell through
    // to a plain "side" (5ft) default — the wrong setback for a genuinely
    // street-facing corner segment, and the root cause of the served
    // envelope's diagonal skew. Scoped narrowly to avoid mislabeling an
    // ordinary long side run that happens to be near the same street at
    // long range: this edge must (a) be front-eligible-road-adjacent to
    // the EXACT SAME way as frontHit (not merely bestByEdge-adjacent to
    // some road), and (b) share a vertex with the front edge (genuinely
    // the front's own immediate neighbor, not a distant edge elsewhere on
    // the parcel).
    // Distance parity with front — the actual discriminator between a
    // genuine corner-clip continuation (this edge's own distance to the
    // shared street is essentially TIED with front's own distance, e.g.
    // 31317: 24.09ft vs front's 23.87ft) and an ordinary adjacent side run
    // that merely falls within the loose 25m proximity threshold at its
    // far end while running much farther from the street on average
    // (verified regression case: 48021:31371/31380's ~85-97ft side runs,
    // whose OWN edge-to-street distance is nowhere near front's ~74-76ft —
    // sharesVertexWithFront alone is true for BOTH of a front edge's two
    // neighbors on every parcel, so it cannot discriminate by itself).
    const eligibleHit = bestEligibleNonAlleyByEdge.get(i);
    const sharesVertexWithFront =
      frontHit != null && (i === (frontHit.edgeIndex + n - 1) % n || i === (frontHit.edgeIndex + 1) % n);
    const CORNER_CLIP_DISTANCE_PARITY_M = 3; // ~10ft — comfortably above GPS/digitization noise, well below the 31371/31380 far-run gap (tens of feet)
    const distanceParityWithFront =
      eligibleHit != null &&
      frontHit != null &&
      Math.abs(eligibleHit.distanceM - frontHit.distanceM) <= CORNER_CLIP_DISTANCE_PARITY_M;
    if (
      eligibleHit &&
      frontHit &&
      eligibleHit.road.osmWayId === frontHit.road.osmWayId &&
      sharesVertexWithFront &&
      distanceParityWithFront
    ) {
      edgeLabels.push({
        index: i,
        label: "side_corner",
        roadClass: eligibleHit.road.classification,
        osmHighwayTag: eligibleHit.road.osmHighwayTag,
        osmSurfaceTag: eligibleHit.road.surface,
        roadProvenanceKind: eligibleHit.road.provenanceKind ?? "osm-fallback",
        osmWayId: eligibleHit.road.osmWayId,
      });
      continue;
    }
    edgeLabels.push({ index: i, label: "side" });
  }

  return { ok: true, edgeLabels };
}
