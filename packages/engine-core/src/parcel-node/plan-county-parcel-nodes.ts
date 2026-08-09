/**
 * Rail 1 `parcel-node` PLANNER — the pure half of the statewide/jurisdiction
 * factory seam.
 *
 * The writer seam at `@hauska-engine/atoms` `parcel-node-writer.ts` turns ONE
 * resolved observation into a contract-valid atom. This module is the layer
 * above it: it turns a county's raw `txgio_parcel` rows into the ORDERED SET of
 * observations that should be written, and it does so with no database access
 * at all so the reconciliation rules below are unit-testable against fixtures
 * rather than against a live store.
 *
 * The rules it encodes, each of which has drawn blood in this program before:
 *
 * 1. **One parcel is one atom, not one atom per tile row.** `txgio_parcel`
 *    writes a feature once per 0.02-degree grid cell its bbox intersects
 *    (see the `txgioParcel` schema: PK is `(county_fips, tile_key,
 *    feature_index)`). Measured duplication is ~1.07 rows/feature on the metro
 *    blend but 4.46 on rural Kenedy. `feature_index` is the shapefile sequence
 *    number and is THE dedupe key across cells — this is the same
 *    `DISTINCT ON (feature_index)` reconciliation the PMTiles bake and the
 *    store readers already use. Deduping on anything else re-inflates the
 *    count.
 *
 * 2. **Account identity is NOT geometry identity.** A geometry-keyed dedup
 *    (ring hash / bbox) silently discards ACCOUNTS: Tarrant `A 36-1` is 133
 *    leasehold accounts sharing ONE polygon, so a geometry hash collapses 133
 *    distinct parcels into one. This planner therefore dedupes on
 *    `feature_index` (a SOURCE-FEATURE identity, one per shapefile record) and
 *    keys the resulting atom on `prop_id` (the ACCOUNT identity). The two are
 *    kept separate on purpose. When several distinct `feature_index` values
 *    share one `prop_id` — the multi-feature account case — they collapse to
 *    ONE atom (the atom is about the account) and the extra features are
 *    counted, never silently dropped. When one `feature_index` carries no
 *    usable `prop_id`, it becomes a typed absence rather than an atom under a
 *    fabricated key.
 *
 * 3. **Absence is a finding.** Three per-parcel kinds plus the county anchor,
 *    all first-class on the contract. See {@link planCountyParcelNodes} for
 *    which row shape produces which.
 *
 * 4. **The plan IS the dry-run.** {@link planCountyParcelNodes} returns the
 *    same object whether or not the caller intends to persist. A dry run that
 *    reports a count without producing the very observations an apply would
 *    write cannot predict the apply, and this repo has ruled that such a dry
 *    run does not count.
 */

import type { ParcelKeyKind, ParcelNodeAbsenceKind } from "@hauska-engine/atoms";

/**
 * One row as read from `txgio_parcel`. Deliberately the raw shape — the
 * planner does the reconciliation, so a caller cannot pre-dedupe (and get it
 * wrong) on the way in.
 */
export interface TxgioParcelRowInput {
  /** Shapefile feature sequence number — the dedupe key across grid cells. */
  featureIndex: number;
  /** Snapped grid cell key; only used to pick a stable representative row. */
  tileKey: string;
  /** CAD property id as shipped. May be null, blank, or the `0` placeholder. */
  propId: string | null;
  /** CAD geographic id; the crosswalk key when `propId` is unusable. */
  geoId: string | null;
  /** GeoJSON geometry (Polygon | MultiPolygon). Only its SHAPE is inspected. */
  geometry: unknown;
  sourceVintage: string;
}

/** How a county's second `parcelNodeId` token is established. */
export interface CountyKeyPolicy {
  countyFips: string;
  /**
   * `prop_id` — the TxGIO prop_id corresponds to the county's CAD roll.
   * `geo_id_crosswalk` — it does not, and the geo_id is the join key.
   * `unresolved` — neither is established for this county. Every parcel becomes
   * a `parcel-key-unresolved` absence rather than a guessed join. Williamson
   * (48491) and Hays (48209) are the known real instances: their TxGIO prop_ids
   * do NOT correspond to their CAD roll, and a prior R-strip fabricated another
   * property's land use onto ~97k and ~78k parcels respectively.
   */
  keyKind: ParcelKeyKind | "unresolved";
  /** Which source published the ring. Never `absent` for a loaded county. */
  geometrySourceTier: "txgio-stratmap" | "county-arcgis-override";
}

export interface PlannedResolvedParcel {
  outcome: "resolved";
  featureIndex: number;
  parcelKey: string;
  keyKind: ParcelKeyKind;
  /**
   * Extra `feature_index` values that carried the SAME `prop_id`. Non-empty
   * means one account spans several source features (the multi-feature account
   * case). Reported, never silently dropped.
   */
  additionalFeatureIndexes: ReadonlyArray<number>;
  sourceVintage: string;
}

export interface PlannedAbsentParcel {
  outcome: "absent";
  featureIndex: number;
  parcelKey: string;
  keyKind: ParcelKeyKind;
  absenceKind: ParcelNodeAbsenceKind;
  reason: string;
  sourceVintage: string;
}

export type PlannedParcelNode = PlannedResolvedParcel | PlannedAbsentParcel;

export interface CountyParcelNodePlan {
  countyFips: string;
  /** Raw `txgio_parcel` rows seen for this county — the tile-inflated number. */
  rowsRead: number;
  /** Distinct `feature_index` values — the real parcel-feature count. */
  distinctFeatures: number;
  /**
   * `rowsRead / distinctFeatures`. ~1.07 metro, ~4.46 rural Kenedy. A value of
   * 1.0 on a county known to be tiled is a signal the caller pre-deduped.
   */
  seamFactor: number | null;
  /** One entry per atom that would be written. This IS the apply prediction. */
  planned: ReadonlyArray<PlannedParcelNode>;
  counts: {
    resolved: number;
    absent: number;
    absentByKind: Record<ParcelNodeAbsenceKind, number>;
    /** Accounts whose rows spanned more than one source feature. */
    multiFeatureAccounts: number;
    /** Extra source features folded into a multi-feature account's one atom. */
    foldedExtraFeatures: number;
  };
}

/**
 * A `prop_id` that is present but carries no identity. StratMap ships `0` (and
 * blanks) for features with no CAD account — Kenedy feature 0 is exactly this:
 * `prop_id = '0'` with an empty owner. Minting `48261:0` would create one
 * bogus atom that every no-account feature in the county collides onto.
 */
function isUsableKeyToken(value: string | null): value is string {
  if (value === null) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // All-zero tokens are the placeholder, not an account.
  if (/^0+$/.test(trimmed)) return false;
  return true;
}

/**
 * Normalize an all-digit key by stripping leading zeros, so a zero-padded
 * source id and a tile node id address the same parcel. Matches the
 * normalization `parcel-geometry-resolver.ts` applies on BOTH sides of its
 * lookup — if this diverged, the pointer this atom carries would not resolve.
 */
export function normalizeParcelKeyToken(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^0+(?=\d)/, "");
}

/**
 * The contract's `PARCEL_NODE_ID_PATTERN` accepts `[A-Za-z0-9._-]+` for the
 * second token. A `geo_id` like `10-0017-2321-00000-3` passes; one carrying a
 * space or slash does not, and a caller must not be able to smuggle it through
 * — the writer seam would throw at persist time, which is correct but late.
 * Catching it here turns a mid-apply crash into a planned, counted absence.
 */
const KEY_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * INVARIANT S1 — A SYNTHETIC KEY MUST NOT ASSERT CONTINUITY IT CANNOT SUPPORT.
 *
 * A feature with no resolvable account key still has to be counted (absence is
 * a finding, never a skipped row), so it is planned under a synthetic key. But
 * the only token available to build that key from is `feature_index`, which is
 * a SHAPEFILE SEQUENCE NUMBER — de-dupe identity WITHIN one vintage and
 * nothing at all across vintages. StratMap reshuffles it on re-acquisition.
 *
 * The store upserts on `atom_did`, and `atom_did` is derived from
 * `parcelNodeId`. So a bare `_feature-7` key means V2's feature 7 — a
 * completely different polygon — upserts onto V1's feature 7 in place and the
 * row silently reads as the same parcel continuing. That is the cross-vintage
 * `feature_index` fallacy the consumption contract forbids in prose, reachable
 * through the very key the planner mints.
 *
 * ENFORCING MECHANISM: the synthetic token embeds the SOURCE VINTAGE, so two
 * vintages CANNOT produce the same `parcelNodeId` for a keyless feature. The
 * collision is not policed at write time, it is unrepresentable — there is no
 * pair of distinct-vintage keyless features whose ids are equal, therefore no
 * upsert can express false continuity for them. The prior vintage's rows then
 * fall out of the new plan and are caught by orphan retirement (invariant S2),
 * which is the honest statement: that land was observed under V1, is no longer
 * observed under V2, and no successor is claimed.
 *
 * SECOND MECHANISM: {@link isSyntheticParcelKey} is the single predicate every
 * consumer uses to recognize these keys. Warm eligibility (invariant S3)
 * refuses them; re-acquisition reconciliation refuses to treat them as
 * same-key continuity. Both call this one function rather than re-deriving a
 * prefix test, so the definition cannot drift between the producer and the
 * consumers.
 */
export const SYNTHETIC_PARCEL_KEY_PREFIX = "_feature-";

/**
 * Vintage tokens come from source data (`source_vintage`), so they can carry
 * characters `PARCEL_NODE_ID_PATTERN` rejects (spaces, slashes in a date, a
 * null). Sanitize to the admitted alphabet so the synthetic key is always
 * contract-legal; the token only has to DISTINGUISH vintages, not be a
 * round-trippable copy of one.
 */
export function sanitizeVintageToken(sourceVintage: string | null | undefined): string {
  const raw = (sourceVintage ?? "").trim();
  if (raw.length === 0) return "unknown";
  const cleaned = raw.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "unknown" : cleaned;
}

/**
 * Build the vintage-scoped synthetic key for a keyless source feature.
 *
 * Shape: `_feature-<vintage>-<featureIndex>`. Both tokens are required for the
 * invariant: `featureIndex` distinguishes features within a vintage, the
 * vintage distinguishes across them. Drop either and the collision returns.
 */
export function syntheticParcelKey(
  featureIndex: number,
  sourceVintage: string | null | undefined,
): string {
  return `${SYNTHETIC_PARCEL_KEY_PREFIX}${sanitizeVintageToken(sourceVintage)}-${featureIndex}`;
}

/**
 * THE predicate for "this key is synthetic, not an account".
 *
 * Accepts either a bare key token (`_feature-2024-01-01-7`) or a full
 * `parcelNodeId` (`48261:_feature-2024-01-01-7`), because callers on both
 * sides of the seam hold one or the other and a consumer that had to remember
 * which form to pass would eventually pass the wrong one.
 *
 * Deliberately also matches the LEGACY bare `_feature-<n>` form. Rows written
 * before this carve-out exist in the store; they must keep being recognized as
 * synthetic (and therefore refused for warm and for continuity) rather than
 * being mistaken for accounts because their shape changed.
 */
export function isSyntheticParcelKey(keyOrParcelNodeId: string): boolean {
  const token = keyOrParcelNodeId.includes(":")
    ? keyOrParcelNodeId.slice(keyOrParcelNodeId.indexOf(":") + 1)
    : keyOrParcelNodeId;
  return token.startsWith(SYNTHETIC_PARCEL_KEY_PREFIX);
}

/**
 * Shape of the stored geometry, inspected WITHOUT reading coordinates.
 *
 * The point is to detect the multi-part case the single-ring serving path
 * cannot represent. `parcel-geometry-resolver.ts` no longer truncates — since
 * `_decisions/2026-08-08_multipolygon_fail_closed_and_the_real_fix.md` it fails
 * closed with `MULTI_PART_GEOMETRY_UNSUPPORTED`. So the honest atom-level
 * statement for these parcels is `geometry-incomplete`: the ring IS in the
 * store, but the serving path declines to reduce it to one ring, so a consumer
 * that follows the pointer gets a decline rather than a ring. Emitting a
 * resolved anchor for these would promise a ring the serve path will refuse.
 *
 * Reducibility mirrors the resolver exactly (same ruling, same boundaries):
 * a Polygon with no holes is reducible; a MultiPolygon with exactly one part
 * that itself has no holes is reducible; anything else is not.
 */
export type GeometryShape =
  | { kind: "reducible" }
  | { kind: "multi-part"; detail: string }
  | { kind: "unusable"; detail: string };

export function classifyGeometryShape(geometry: unknown): GeometryShape {
  const geom = geometry as { type?: string; coordinates?: unknown } | null;
  if (!geom || typeof geom !== "object") {
    return { kind: "unusable", detail: "geometry is not an object" };
  }
  if (geom.type === "Polygon") {
    const rings = geom.coordinates;
    if (!Array.isArray(rings) || rings.length === 0) {
      return { kind: "unusable", detail: "Polygon has no rings" };
    }
    if (rings.length > 1) {
      return {
        kind: "multi-part",
        detail: `Polygon with ${rings.length} rings (${rings.length - 1} interior)`,
      };
    }
    return Array.isArray(rings[0]) && (rings[0] as unknown[]).length >= 3
      ? { kind: "reducible" }
      : { kind: "unusable", detail: "Polygon exterior ring has fewer than 3 positions" };
  }
  if (geom.type === "MultiPolygon") {
    const polygons = geom.coordinates;
    if (!Array.isArray(polygons) || polygons.length === 0) {
      return { kind: "unusable", detail: "MultiPolygon has no parts" };
    }
    if (polygons.length > 1) {
      return {
        kind: "multi-part",
        detail: `MultiPolygon with ${polygons.length} parts`,
      };
    }
    const only = polygons[0];
    if (!Array.isArray(only) || only.length === 0) {
      return { kind: "unusable", detail: "MultiPolygon part has no rings" };
    }
    if (only.length > 1) {
      return {
        kind: "multi-part",
        detail: `MultiPolygon single part with ${only.length} rings (${only.length - 1} interior)`,
      };
    }
    return Array.isArray(only[0]) && (only[0] as unknown[]).length >= 3
      ? { kind: "reducible" }
      : { kind: "unusable", detail: "MultiPolygon exterior ring has fewer than 3 positions" };
  }
  return {
    kind: "unusable",
    detail: `geometry type ${String(geom.type ?? "undefined")} is not a polygon`,
  };
}

/** Pick the stable representative row for a feature: lowest tile_key. */
function representativeOf(
  rows: ReadonlyArray<TxgioParcelRowInput>,
): TxgioParcelRowInput {
  let best = rows[0]!;
  for (const row of rows) {
    if (row.tileKey < best.tileKey) best = row;
  }
  return best;
}

/**
 * Turn a county's raw `txgio_parcel` rows into the exact set of `parcel-node`
 * atoms that should exist for it.
 *
 * Deterministic: the same rows in any order produce the same plan, ordered by
 * `parcelKey` then `featureIndex`. That determinism is what lets a dry run be
 * compared to an apply rather than merely believed.
 */
export function planCountyParcelNodes(
  rows: ReadonlyArray<TxgioParcelRowInput>,
  policy: CountyKeyPolicy,
): CountyParcelNodePlan {
  // ---- Step 1: collapse tile rows to source features on `feature_index`.
  const byFeature = new Map<number, TxgioParcelRowInput[]>();
  for (const row of rows) {
    const bucket = byFeature.get(row.featureIndex);
    if (bucket) bucket.push(row);
    else byFeature.set(row.featureIndex, [row]);
  }

  // ---- Step 2: resolve each feature's ACCOUNT key, independently of geometry.
  interface FeatureView {
    featureIndex: number;
    row: TxgioParcelRowInput;
    /** null when no usable key token exists on this feature. */
    parcelKey: string | null;
    keyKind: ParcelKeyKind;
    keyProblem: string | null;
  }

  const features: FeatureView[] = [];
  for (const [featureIndex, bucket] of byFeature) {
    const row = representativeOf(bucket);

    if (policy.keyKind === "unresolved") {
      features.push({
        featureIndex,
        row,
        parcelKey: null,
        keyKind: "prop_id",
        keyProblem:
          `county ${policy.countyFips} key kind is unestablished; ` +
          "TxGIO prop_id is not known to correspond to the CAD roll and no crosswalk exists",
      });
      continue;
    }

    const rawToken =
      policy.keyKind === "geo_id_crosswalk" ? row.geoId : row.propId;
    if (!isUsableKeyToken(rawToken)) {
      features.push({
        featureIndex,
        row,
        parcelKey: null,
        keyKind: policy.keyKind,
        keyProblem:
          `source row carries no usable ${policy.keyKind} token ` +
          `(value ${JSON.stringify(rawToken)}); a placeholder or blank id is not an account`,
      });
      continue;
    }

    const normalized = normalizeParcelKeyToken(rawToken);
    if (!KEY_TOKEN_PATTERN.test(normalized)) {
      features.push({
        featureIndex,
        row,
        parcelKey: null,
        keyKind: policy.keyKind,
        keyProblem:
          `source ${policy.keyKind} token ${JSON.stringify(rawToken)} contains characters ` +
          "the parcelNodeId contract does not admit",
      });
      continue;
    }

    features.push({
      featureIndex,
      row,
      parcelKey: normalized,
      keyKind: policy.keyKind,
      keyProblem: null,
    });
  }

  // ---- Step 3: fold features that share ONE account into one atom.
  // Geometry identity (feature) and account identity (prop_id) are different
  // things; this is where the two are reconciled explicitly rather than by a
  // hash collision.
  const byAccount = new Map<string, FeatureView[]>();
  const keyless: FeatureView[] = [];
  for (const view of features) {
    if (view.parcelKey === null) {
      keyless.push(view);
      continue;
    }
    const bucket = byAccount.get(view.parcelKey);
    if (bucket) bucket.push(view);
    else byAccount.set(view.parcelKey, [view]);
  }

  const planned: PlannedParcelNode[] = [];
  const absentByKind: Record<ParcelNodeAbsenceKind, number> = {
    "no-parcel-geometry": 0,
    "geometry-incomplete": 0,
    "parcel-key-unresolved": 0,
  };
  let multiFeatureAccounts = 0;
  let foldedExtraFeatures = 0;

  for (const [parcelKey, bucket] of byAccount) {
    bucket.sort((a, b) => a.featureIndex - b.featureIndex);
    const primary = bucket[0]!;
    const extras = bucket.slice(1).map((v) => v.featureIndex);
    if (extras.length > 0) {
      multiFeatureAccounts += 1;
      foldedExtraFeatures += extras.length;
    }

    // An account whose ring the serving path cannot reduce is a
    // `geometry-incomplete` finding, not a resolved anchor. Judged on the
    // PRIMARY feature; a multi-feature account is separately reported via
    // additionalFeatureIndexes.
    const shape = classifyGeometryShape(primary.row.geometry);
    if (shape.kind === "reducible" && extras.length === 0) {
      planned.push({
        outcome: "resolved",
        featureIndex: primary.featureIndex,
        parcelKey,
        keyKind: primary.keyKind,
        additionalFeatureIndexes: [],
        sourceVintage: primary.row.sourceVintage,
      });
      continue;
    }

    if (shape.kind === "reducible") {
      // Reducible ring, but the account spans several source features: the
      // pointer resolves to ONE of them, so the anchor is honest about the
      // rest rather than presenting a part as the whole.
      planned.push({
        outcome: "resolved",
        featureIndex: primary.featureIndex,
        parcelKey,
        keyKind: primary.keyKind,
        additionalFeatureIndexes: extras,
        sourceVintage: primary.row.sourceVintage,
      });
      continue;
    }

    if (shape.kind === "multi-part") {
      absentByKind["geometry-incomplete"] += 1;
      planned.push({
        outcome: "absent",
        featureIndex: primary.featureIndex,
        parcelKey,
        keyKind: primary.keyKind,
        absenceKind: "geometry-incomplete",
        reason:
          `${shape.detail}; the single-ring serving path declines this geometry ` +
          "(MULTI_PART_GEOMETRY_UNSUPPORTED), so no reducible ring is servable for this parcel",
        sourceVintage: primary.row.sourceVintage,
      });
      continue;
    }

    absentByKind["no-parcel-geometry"] += 1;
    planned.push({
      outcome: "absent",
      featureIndex: primary.featureIndex,
      parcelKey,
      keyKind: primary.keyKind,
      absenceKind: "no-parcel-geometry",
      reason: `county ${policy.countyFips} is loaded but this parcel's stored geometry is unusable: ${shape.detail}`,
      sourceVintage: primary.row.sourceVintage,
    });
  }

  // ---- Step 4: keyless features become typed absence under a synthetic,
  // clearly-marked feature key. They are NEVER minted under a fabricated
  // account id, and they are never silently dropped either.
  for (const view of keyless) {
    const absenceKind: ParcelNodeAbsenceKind = "parcel-key-unresolved";
    absentByKind[absenceKind] += 1;
    planned.push({
      outcome: "absent",
      featureIndex: view.featureIndex,
      // Synthetic VINTAGE-SCOPED feature key (invariant S1). Contract-legal,
      // obviously not an account, stable across re-runs of the SAME vintage so
      // the atom is idempotent, and provably distinct across vintages so a
      // shapefile reshuffle cannot upsert one vintage's land onto another's.
      parcelKey: syntheticParcelKey(view.featureIndex, view.row.sourceVintage),
      keyKind: view.keyKind,
      absenceKind,
      reason: view.keyProblem ?? "parcel key could not be established",
      sourceVintage: view.row.sourceVintage,
    });
  }

  planned.sort((a, b) =>
    a.parcelKey === b.parcelKey
      ? a.featureIndex - b.featureIndex
      : a.parcelKey < b.parcelKey
        ? -1
        : 1,
  );

  const distinctFeatures = byFeature.size;
  const resolved = planned.filter((p) => p.outcome === "resolved").length;

  return {
    countyFips: policy.countyFips,
    rowsRead: rows.length,
    distinctFeatures,
    seamFactor:
      distinctFeatures > 0
        ? Number((rows.length / distinctFeatures).toFixed(4))
        : null,
    planned,
    counts: {
      resolved,
      absent: planned.length - resolved,
      absentByKind,
      multiFeatureAccounts,
      foldedExtraFeatures,
    },
  };
}
