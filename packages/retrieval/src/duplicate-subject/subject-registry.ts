/**
 * THE SUBJECT REGISTRY — lane SS-W11, PLAN-ROW P-45.
 *
 * The one data file that names which canonical SUBJECT each store field is a
 * claim about. It is deliberately data, not code, and it is deliberately the
 * ONLY hand-authored part of the detector.
 *
 * Everything else is DERIVED from the live stores by
 * `scripts/duplicate-subject-detector.mjs --inventory`, and
 * `--inventory --check-registry` exits 1 when the derivation and this file
 * disagree. That is the control: a hand-declared manifest drifts both ways
 * against the engine (the has_writer / atomFamilyState precedent), so the
 * declaration is never trusted on its own — the divergence test is.
 *
 * DEV_PROCESS 2.4: when one rule has two implementations, the divergence test
 * IS the control. Adding a store means editing this file, never two code paths.
 */

import type { SubjectDeclaration } from "./types.js";

/**
 * Store keys that exist in the live stores but hold no subject we reconcile,
 * stated here because an instrument's exclusion set is part of its contract
 * (DEV_PROCESS 2.1) and "unmentioned" is a failure state (DEV_PROCESS 3.3).
 */
export const OUT_OF_SCOPE_STORES: ReadonlyArray<{ storeKey: string; why: string }> = [
  { storeKey: "atoms:code-section", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-edition", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-amendment", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-cross-reference", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:jurisdiction-corpus", why: "corpus manifest; single store" },
  { storeKey: "atoms:road-node", why: "OSM road graph; single store" },
  { storeKey: "atoms:property-boundary-edge", why: "derived edge geometry; single store" },
  { storeKey: "atoms:parcel-terrain-model", why: "single store; usgs:ned-elevation cache is 58 rows and holds elevation for a place, not a parcel terrain model" },
  { storeKey: "pls:epa:ejscreen", why: "58-row cache; no atom counterpart, no subject in the spine" },
  { storeKey: "pls:national:opportunity-zone", why: "170-row cache; no atom counterpart" },
  { storeKey: "pls:usgs:ned-elevation", why: "58-row cache; see parcel-terrain-model" },
];

/**
 * Every canonical subject held by two or more stores.
 *
 * ORDERING IS BY EVIDENCE, NOT BY IMPORTANCE. `flood-zone` is first because it
 * is the case the operator ruling was written from, not because it is the
 * worst.
 */
export const SUBJECT_REGISTRY: readonly SubjectDeclaration[] = [
  {
    subject: "flood-zone",
    entityKind: "parcel",
    duplicationClass: "independent-double-derivation",
    groundTruth: "tx_fema_nfhl_flood_zone (FEMA NFHL, edition NFHL_48_20260101)",
    notes:
      "Case one. Both stores claim FEMA NFHL and neither is a copy of the other. " +
      "The atom evaluates the PARCEL CENTROID against the local bulk table. The tier2 " +
      "bake quantises the centroid to a 0.005-degree tile, issues ONE live FEMA ArcGIS " +
      "point query at the TILE CENTRE, and reuses that answer for every parcel in the " +
      "tile — so a parcel's tier2 zone can be decided by a point up to ~366 m away. " +
      "That is the sampling difference; it is not staleness and it is not a split parcel.",
    stores: [
      {
        storeKey: "atoms:flood-hazard-fact",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='flood-hazard-fact'",
        valuePath: "body->>'floodZone'",
        editionPath: "body->>'sourceVintage'",
        samplingContract:
          "parcel centroid point-in-polygon against tx_fema_nfhl_flood_zone, bbox-filtered to the county " +
          "(packages/engine-core/scripts/write-flood-hazard-fact-county.mjs)",
      },
      {
        storeKey: "pls:node-facets:tier2",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier2'",
        valuePath: "payload_json->'flood'->>'floodZone'",
        editionPath: null,
        samplingContract:
          "one live FEMA ArcGIS MapServer/28 point query per 0.005-degree tile CENTRE, reused across " +
          "every parcel whose centroid rounds into the tile " +
          "(legacy-design-tools artifacts/api-server/src/nodeFacetBakeTier2Cli.ts, FEMA_TILE_DEG=0.005)",
      },
      {
        storeKey: "pls:fema:nfhl-flood-zone",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='fema:nfhl-flood-zone'",
        valuePath: "payload_json->>'floodZone'",
        editionPath: null,
        samplingContract: "per-engagement live adapter cache, 176 rows; vestigial",
      },
    ],
  },
  {
    subject: "zoning-district",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: "the stamping city GIS feature service named in the atom sourceUrl",
    notes:
      "FOUR stores, which is the case the dispatch could not name. The Bastrop " +
      "zoning-fact atoms split by origin: 9,560 are real PIP stamps off city GIS and " +
      "52,700 carry sourceAdapter cortex-tier1-snapshot-breadth-bake, i.e. they are a " +
      "TRANSFORM of tier1 rather than an independent reading. txgio_parcel.zoning_district " +
      "is a fourth home on the raw parcel fabric.",
    stores: [
      {
        storeKey: "atoms:zoning-fact",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='zoning-fact'",
        valuePath: "body->>'district'",
        editionPath: "body->>'versionStamp'",
        samplingContract: "point-in-polygon stamp against a city GIS layer, or a transform of the tier1 snapshot",
      },
      {
        storeKey: "pls:node-facets:tier1",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier1'",
        valuePath: "payload_json->'zoning'->>'district'",
        editionPath: "payload_json->'zoning'->'provenance'->>'stampedAt'",
        samplingContract: "point-in-polygon stamp against a city GIS layer at bake time",
      },
      {
        storeKey: "txgio_parcel.zoning_district",
        db: "cortex",
        table: "txgio_parcel",
        discriminator: null,
        valuePath: "zoning_district",
        editionPath: "source_vintage",
        samplingContract: "column stamped onto the raw parcel fabric by the zoning stamp CLI",
      },
      {
        storeKey: "pls:cotality:zoning",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='cotality:zoning'",
        valuePath: "payload_json->>'zoning'",
        editionPath: null,
        samplingContract: "65-row cache of an EXTINGUISHED source",
      },
    ],
  },
  {
    subject: "land-use-code",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: "the county appraisal roll export named in sourceVintage",
    notes:
      "The land-use-fact atom and the tier1 baseFacts.landUse.code both derive from the " +
      "CAD roll. cad-parcel-roll.propertyUseCode is a third home for the same code on a " +
      "different entity key (it carries a :taxYear suffix).",
    stores: [
      {
        storeKey: "atoms:land-use-fact",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='land-use-fact'",
        valuePath: "body->>'landUseCode'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "CAD roll join on prop_id",
      },
      {
        storeKey: "pls:node-facets:tier1",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier1'",
        valuePath: "payload_json->'baseFacts'->'landUse'->>'code'",
        editionPath: "payload_json->'baseFacts'->'landUse'->>'vintage'",
        samplingContract: "CAD roll join at bake time",
      },
      {
        storeKey: "atoms:cad-parcel-roll",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='cad-parcel-roll'",
        valuePath: "body->>'propertyUseCode'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "verbatim appraisal-roll record, keyed county:propId:taxYear",
      },
    ],
  },
  {
    subject: "situs-address",
    entityKind: "parcel",
    duplicationClass: "independent-double-derivation",
    groundTruth: "county appraisal roll (cad-parcel-roll), which is the only store with a street segment for the gap parcels",
    notes:
      "tier1 baseFacts.situsAddress is copied from txgio_parcel.situs_address; the CAD roll " +
      "is an independent reading. SS-W5 measured 1,036 Bastrop parcels where the CAD roll " +
      "carries a street and the served path does not.",
    stores: [
      {
        storeKey: "pls:node-facets:tier1",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier1'",
        valuePath: "payload_json->'baseFacts'->>'situsAddress'",
        editionPath: "payload_json->'provenance'->>'parcelVintage'",
        samplingContract: "copied from txgio_parcel.situs_address at bake time",
      },
      {
        storeKey: "atoms:cad-parcel-roll",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='cad-parcel-roll'",
        valuePath: "body->>'situsAddress'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "verbatim appraisal-roll record",
      },
      {
        storeKey: "txgio_parcel.situs_address",
        db: "cortex",
        table: "txgio_parcel",
        discriminator: null,
        valuePath: "situs_address",
        editionPath: "source_vintage",
        samplingContract: "TxGIO StratMap land-parcel attribute, verbatim",
      },
    ],
  },
  {
    subject: "owner-name",
    entityKind: "parcel",
    duplicationClass: "independent-double-derivation",
    groundTruth: "county appraisal roll",
    notes:
      "owner-fact and cad-parcel-roll.ownerName both come off the roll; " +
      "txgio_parcel.owner_name is the TxGIO attribute and is a genuinely different reading.",
    stores: [
      {
        storeKey: "atoms:owner-fact",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='owner-fact'",
        valuePath: "body->>'ownerName'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "CAD roll join on prop_id",
      },
      {
        storeKey: "atoms:cad-parcel-roll",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='cad-parcel-roll'",
        valuePath: "body->>'ownerName'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "verbatim appraisal-roll record",
      },
      {
        storeKey: "txgio_parcel.owner_name",
        db: "cortex",
        table: "txgio_parcel",
        discriminator: null,
        valuePath: "owner_name",
        editionPath: "source_vintage",
        samplingContract: "TxGIO StratMap land-parcel attribute, verbatim",
      },
      {
        storeKey: "pls:cad:owner-occupancy",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='cad:owner-occupancy'",
        valuePath: "payload_json->>'ownerName'",
        editionPath: null,
        samplingContract: "145-row per-engagement cache; vestigial",
      },
    ],
  },
  {
    subject: "buildable-envelope-status",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: null,
    notes:
      "THREE stores, two of which sit in the same table under different adapter keys. " +
      "tier1.envelope was retired in place (declineReason atom_path_pending, disclosure " +
      "'Tier-1 bake no longer authors product envelope confidence') while tier2.envelope " +
      "still carries its own decline reason for the same parcel, and the atom carries a " +
      "derived area. A retired store that still answers is the worst of the three shapes.",
    stores: [
      {
        storeKey: "atoms:buildable-envelope",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='buildable-envelope'",
        valuePath: "body->'outcome'->>'kind'",
        editionPath: "body->>'versionStamp'",
        samplingContract: "setbacks applied to parcel geometry, or a transform of the tier1 snapshot",
      },
      {
        storeKey: "pls:node-facets:tier1#envelope",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier1'",
        valuePath: "payload_json->'envelope'->>'status'",
        editionPath: "payload_json->>'bakedAt'",
        samplingContract: "retired in place; always declines with atom_path_pending",
      },
      {
        storeKey: "pls:node-facets:tier2#envelope",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier2'",
        valuePath: "payload_json->'envelope'->>'status'",
        editionPath: "payload_json->>'bakedAt'",
        samplingContract: "OSM road-edge upgrade, gated OFF by default; declines with no-jurisdiction-key",
      },
    ],
  },
  {
    subject: "parcel-existence",
    entityKind: "parcel",
    duplicationClass: "independent-double-derivation",
    groundTruth: "txgio_parcel under the current StratMap vintage",
    notes:
      "The parcel-node atom carries a retirement lifecycle (status retired, retiredReason " +
      "naming the vintage that dropped the account). The tier1 snapshot has no lifecycle at " +
      "all: a retired parcel keeps its baked row and keeps serving. 48021:36521 is exactly " +
      "this — parcel-node retired 2026-08-11, tier1 row still live.",
    stores: [
      {
        storeKey: "atoms:parcel-node",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='parcel-node'",
        valuePath: "body->>'status'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "presence in the county's current StratMap plan; absence writes a retirement",
      },
      {
        storeKey: "pls:node-facets:tier1#existence",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='node-facets:tier1'",
        valuePath: "'present'",
        editionPath: "payload_json->'provenance'->>'parcelVintage'",
        samplingContract: "row presence only; no retirement path exists",
      },
    ],
  },
];

/** Every store key the registry claims, deduplicated. */
export function declaredStoreKeys(): string[] {
  const s = new Set<string>();
  for (const d of SUBJECT_REGISTRY) for (const st of d.stores) s.add(st.storeKey);
  return [...s].sort();
}

/** Subjects held by two or more stores. Every registry row should qualify. */
export function duplicatedSubjects(): readonly SubjectDeclaration[] {
  return SUBJECT_REGISTRY.filter((d) => d.stores.length >= 2);
}
