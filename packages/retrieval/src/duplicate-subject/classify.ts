/**
 * DIVERGENCE CLASSIFICATION — lane SS-W11, PLAN-ROW P-45. Pure.
 *
 * The dispatch's fork was: vintages DIFFER means staleness, vintages MATCH
 * means sampling-method or a genuinely split parcel. That fork assumes both
 * stores name a vintage. The tier2 flood record does not — its
 * `provenance.vintage` is the bake's own timestamp, not an NFHL edition — so
 * applying the fork mechanically would classify every Bastrop case as
 * "vintage differs" on the strength of two unlike strings that are not the
 * same KIND of string.
 *
 * So `vintage-undecidable` is a first-class outcome here, and the order of the
 * tests matters: a divergence that is fully explained by the two stores having
 * sampled different POINTS is not evidence of staleness at all, whatever the
 * edition strings say.
 */

import type {
  DivergenceClass,
  EntityVerdict,
  GroundTruthReading,
  PairTally,
  StoreReading,
} from "./types.js";
import { DIVERGENCE_CLASSES, isDisagreement, isComparable } from "./types.js";

/**
 * Value normalisation. Case and surrounding whitespace only.
 *
 * It deliberately does NOT canonicalise FEMA zone families (AE and A are not
 * folded together, X and X500 are not folded together). Folding them would
 * shrink the disagreement count by deciding, inside the instrument, that some
 * disagreements do not matter — which is the instrument answering the question
 * it was built to ask.
 */
export function normalizeValue(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim().toUpperCase();
  return t === "" ? null : t;
}

/**
 * Metres between two lat/lng points. Equirectangular approximation, which is
 * accurate to well under a metre at the sub-kilometre distances this is used
 * for and avoids pulling a geodesy dependency into a pure module.
 */
export function approxDistanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const meanLat = ((a.lat + b.lat) / 2) * toRad;
  const x = dLng * Math.cos(meanLat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/**
 * The FEMA tile the Tier-2 bake would have queried for a given parcel centroid.
 *
 * Mirrors `tileKey`/`tileCenter` in
 * `legacy-design-tools/artifacts/api-server/src/nodeFacetBakeTier2Cli.ts`
 * (FEMA_TILE_DEG = 0.005). This is a RECONSTRUCTION of another repo's rule and
 * is labelled as such: it is used to EXPLAIN a divergence, never to write one,
 * and `sample-point-reconstruction.test.ts` pins it against the values that
 * file actually rounds to.
 */
export const FEMA_TILE_DEG = 0.005;

export function femaTileCentre(centroid: { lat: number; lng: number }): {
  lat: number;
  lng: number;
} {
  const q = (v: number) => Math.round(v / FEMA_TILE_DEG) * FEMA_TILE_DEG;
  // toFixed(5) mirrors the bake's own string round-trip through the tile key,
  // which is what actually decides which parcels share a tile.
  return {
    lat: Number(q(centroid.lat).toFixed(5)),
    lng: Number(q(centroid.lng).toFixed(5)),
  };
}

/**
 * Classify one entity.
 *
 * `groundTruth` is optional: without it the classifier can still separate
 * agreement, one-sidedness and disagreement, but it CANNOT tell a
 * sampling-point artifact from staleness, and it says so by returning
 * `vintage-undecidable` or `genuine-conflict` rather than guessing. An
 * instrument that guesses here is the whole reason this programme exists.
 */
export function classifyEntity(
  entityId: string,
  a: StoreReading,
  b: StoreReading,
  groundTruth: GroundTruthReading | null,
): EntityVerdict {
  const va = normalizeValue(a.value);
  const vb = normalizeValue(b.value);

  if (va == null && vb == null) {
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "absent-both",
      basis: "neither store names a value",
    };
  }
  if (va != null && vb == null) {
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "one-sided-a",
      basis: `only store A names a value (${va}); B status=${b.status ?? "no row"}`,
    };
  }
  if (va == null && vb != null) {
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "one-sided-b",
      basis: `only store B names a value (${vb}); A status=${a.status ?? "no row"}`,
    };
  }
  if (va === vb) {
    return { entityId, a, b, groundTruth, divergence: "agree", basis: `both name ${va}` };
  }

  // ---- disagreement. Now the cause.

  if (groundTruth == null) {
    // No ground truth re-run. The most we can honestly say is whether the
    // record even permits a staleness test.
    if (a.edition == null || b.edition == null) {
      return {
        entityId,
        a,
        b,
        groundTruth,
        divergence: "vintage-undecidable",
        basis:
          `A=${va} B=${vb}; ` +
          `${a.edition == null ? "store A" : "store B"} records no source edition, ` +
          "so staleness cannot be tested from the record",
      };
    }
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "genuine-conflict",
      basis: `A=${va} (${a.edition}) B=${vb} (${b.edition}); no ground-truth re-run performed`,
    };
  }

  const gtA = normalizeValue(groundTruth.atSamplePointA);
  const gtB = normalizeValue(groundTruth.atSamplePointB);
  const zoneSet = groundTruth.entityZoneSet.map(normalizeValue).filter((z): z is string => z != null);

  // 1. Each store is CORRECT for the point it sampled, and the points differ.
  //    This is not a disagreement about the world; it is two answers to two
  //    different questions. Tested FIRST because a sampling artifact that also
  //    happens to straddle a boundary is still a sampling artifact.
  if (
    gtA != null &&
    gtB != null &&
    gtA === va &&
    gtB === vb &&
    (groundTruth.samplePointDistanceM ?? 0) > 0
  ) {
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "explained-by-sampling-point",
      basis:
        `ground truth at A's point = ${gtA} = A; at B's point = ${gtB} = B; ` +
        `points are ${(groundTruth.samplePointDistanceM ?? 0).toFixed(0)} m apart`,
    };
  }

  // 2. The entity genuinely holds both values.
  if (zoneSet.includes(va) && zoneSet.includes(vb)) {
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "split-subject",
      basis: `parcel geometry intersects both ${va} and ${vb} (zone set: ${zoneSet.join("|")})`,
    };
  }

  // 3. Same sample point, and the current edition matches exactly one side.
  const sameSamplePoint = (groundTruth.samplePointDistanceM ?? 0) === 0;
  const truthAtEntity = gtA ?? gtB;
  if (truthAtEntity != null && (truthAtEntity === va) !== (truthAtEntity === vb)) {
    if (a.edition == null || b.edition == null) {
      return {
        entityId,
        a,
        b,
        groundTruth,
        divergence: "vintage-undecidable",
        basis:
          `current edition ${groundTruth.edition} says ${truthAtEntity}, matching ` +
          `${truthAtEntity === va ? "A" : "B"}; but ` +
          `${a.edition == null ? "A" : "B"} records no source edition, so the other side's ` +
          "value cannot be attributed to a known prior edition",
      };
    }
    return {
      entityId,
      a,
      b,
      groundTruth,
      divergence: "edition-differs",
      basis:
        `${sameSamplePoint ? "same sample point; " : ""}current edition ${groundTruth.edition} ` +
        `says ${truthAtEntity}, matching ${truthAtEntity === va ? `A (${a.edition})` : `B (${b.edition})`}; ` +
        `the other side is stale`,
    };
  }

  return {
    entityId,
    a,
    b,
    groundTruth,
    divergence: "genuine-conflict",
    basis:
      `A=${va} B=${vb}; ground truth at A's point=${gtA ?? "none"}, at B's point=${gtB ?? "none"}, ` +
      `entity zone set=${zoneSet.join("|") || "empty"} — matches neither store`,
  };
}

/* ------------------------------------------------------------------ */
/* Tally                                                               */
/* ------------------------------------------------------------------ */

export function emptyClassCounts(): Record<DivergenceClass, number> {
  const o = {} as Record<DivergenceClass, number>;
  for (const c of DIVERGENCE_CLASSES) o[c] = 0;
  return o;
}

export function tallyPair(args: {
  subject: string;
  storeA: string;
  storeB: string;
  countyFips: string;
  rosterUnion: number;
  rowsA: number;
  rowsB: number;
  verdicts: Iterable<EntityVerdict>;
}): PairTally {
  const byClass = emptyClassCounts();
  const editionsA: Record<string, number> = {};
  const editionsB: Record<string, number> = {};
  const statusesB: Record<string, number> = {};
  let comparable = 0;
  let disagreements = 0;

  for (const v of args.verdicts) {
    byClass[v.divergence] += 1;
    if (isComparable(v.divergence)) comparable += 1;
    if (isDisagreement(v.divergence)) disagreements += 1;
    const ea = v.a.edition ?? "(none recorded)";
    const eb = v.b.edition ?? "(none recorded)";
    editionsA[ea] = (editionsA[ea] ?? 0) + 1;
    editionsB[eb] = (editionsB[eb] ?? 0) + 1;
    const sb = v.b.status ?? "(no status)";
    statusesB[sb] = (statusesB[sb] ?? 0) + 1;
  }

  const pct = (n: number, d: number) => (d === 0 ? 0 : Number(((n / d) * 100).toFixed(4)));

  return {
    subject: args.subject,
    storeA: args.storeA,
    storeB: args.storeB,
    countyFips: args.countyFips,
    rosterUnion: args.rosterUnion,
    rowsA: args.rowsA,
    rowsB: args.rowsB,
    comparable,
    byClass,
    disagreementRate: {
      numerator: disagreements,
      denominator: comparable,
      pct: pct(disagreements, comparable),
      countingRule:
        "entities where BOTH stores NAME a value and the values differ, over entities where " +
        "both stores NAME a value. One entity contributes at most one count. This is the only " +
        "population in which a disagreement is arithmetically possible.",
    },
    disagreementRateOverRoster: {
      numerator: disagreements,
      denominator: args.rosterUnion,
      pct: pct(disagreements, args.rosterUnion),
      countingRule:
        "the SAME numerator over every entity either store holds a row for. Printed only so the " +
        "denominator gap is visible; it understates the rate by the share of the roster where no " +
        "comparison is possible and must never be quoted alone.",
    },
    editionsA,
    editionsB,
    statusesB,
  };
}
