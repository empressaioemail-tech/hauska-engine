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
 * declaration is never trusted on its own — the divergence test is. It fired
 * on its first run against 20 real leftovers, which is the CTRL-1 pattern.
 *
 * DEV_PROCESS 2.4: when one rule has two implementations, the divergence test
 * IS the control. Adding a store means editing this file, never two code paths.
 *
 * THE MEMBERSHIP RULE, stated once so it can be argued with. A store counts as
 * a second home for a subject when it is keyed on the SAME ENTITY. A raw geo
 * table whose rows are zone polygons, well bores or building footprints is an
 * UPSTREAM of a parcel-keyed fact, not a duplicate of it — which is exactly why
 * `tx_fema_nfhl_flood_zone` is this programme's ground truth rather than one of
 * its cases. `txgio_parcel` by contrast IS parcel-keyed, so its columns are
 * genuine second homes.
 */

import type { SubjectDeclaration } from "./types.js";

/**
 * Store keys that exist in the live stores but hold no subject we reconcile.
 *
 * An instrument's exclusion set is part of its contract (DEV_PROCESS 2.1) and
 * "unmentioned" is a failure state (DEV_PROCESS 3.3). Every reason below is a
 * MEASUREMENT, not a judgement: emptiness counts come from
 * `count(*) FILTER (WHERE payload_json = '{}'::jsonb)` over the whole adapter,
 * because an empty result is not an absence and only a positive determination
 * writes one.
 */
export const OUT_OF_SCOPE_STORES: ReadonlyArray<{ storeKey: string; why: string }> = [
  // --- single-store atom families.
  { storeKey: "atoms:code-section", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-edition", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-amendment", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:code-cross-reference", why: "code corpus; single store, no duplicate" },
  { storeKey: "atoms:jurisdiction-corpus", why: "corpus manifest; single store" },
  { storeKey: "atoms:road-node", why: "OSM road graph; single store" },
  { storeKey: "atoms:property-boundary-edge", why: "derived edge geometry; single store" },
  {
    storeKey: "atoms:parcel-terrain-model",
    why:
      "single store. usgs:ned-elevation (58 rows) holds an elevation for a PLACE, not a terrain model " +
      "for a parcel — a different subject with no second store",
  },
  {
    storeKey: "atoms:building-footprint",
    why:
      "upstream tx_building_footprint (10,601,695 rows) is keyed on a FOOTPRINT, not a parcel, so by the " +
      "membership rule it is a derivation and not a duplicate",
  },
  {
    storeKey: "atoms:well-fact",
    why: "upstream tx_rrc_well (1,367,691 rows) is keyed on a WELL; one derived store",
  },
  {
    storeKey: "atoms:rrc-pipeline-fact",
    why: "upstream tx_rrc_pipeline (488,324 rows) is keyed on a PIPELINE; one derived store",
  },
  {
    storeKey: "atoms:rail-corridor-fact",
    why: "single derived store; the upstream is keyed on a corridor",
  },
  {
    storeKey: "atoms:special-district-fact",
    why:
      "upstream tx_special_district (2,782 rows) is keyed on a DISTRICT. Named rather than merely omitted " +
      "because it is this programme's own precedent: OPS-16 A-002 ruled that mud is a special-district TYPE " +
      "rather than its own rail, and the store confirms it — district_type MUD holds 1,888 of the 2,782 rows, " +
      "beside WCID 250, MMD 197, FWSD 84 and eleven more. That duplicate was a DECLARATION built twice, not a " +
      "store built twice, and it takes a different remedy: a declaration refresh, never a retirement.",
  },
  {
    storeKey: "atoms:setback-rule",
    why:
      "single store keyed on the parcel. Named rather than omitted because the CONFLICT here is INSIDE the " +
      "record: 48021:36521 carries displayMeta.secondSource saying the city's layer 83 specifies corner side 10 " +
      "for district GC while the atom's own layer-23 reading says 5, with the note 'the two city schedules " +
      "conflict'. A duplicate subject inside ONE record is outside this detector's shape and belongs on the " +
      "backlog, not in a store pair.",
  },

  // --- MEASURED-EMPTY caches. Not duplicate stores of anything: they hold no
  // value at all, so comparing against them would compare against nothing.
  {
    storeKey: "pls:cotality:zoning",
    why: "65 rows, 65 of them the empty object. Holds NO zoning value and is therefore not a store of zoning-district",
  },
  { storeKey: "pls:cotality:parcels", why: "54 rows, 54 empty" },
  { storeKey: "pls:cotality:rent-avm", why: "12 rows, 12 empty" },
  { storeKey: "pls:cotality:propensity", why: "12 rows, 12 empty" },
  { storeKey: "pls:regrid:parcels", why: "2 rows, 2 empty; Regrid is EXTINGUISHED" },
  { storeKey: "pls:regrid:zoning", why: "2 rows, 2 empty; Regrid is EXTINGUISHED" },

  // --- EXTINGUISHED-source caches that DO hold values. Not a reconciliation
  // problem: nothing refreshes them and nothing should. They need a delete
  // ruling, which is an operator call and not a lane's (DEV_PROCESS 5.4).
  {
    storeKey: "pls:cotality:property",
    why: "12 rows, 8 non-empty, AVM payload; Cotality is EXTINGUISHED — retire, never reconcile",
  },
  { storeKey: "pls:cotality:owner-occupancy", why: "12 rows, 8 non-empty; Cotality is EXTINGUISHED" },
  { storeKey: "pls:cotality:liens-mortgage-tax", why: "12 rows, 8 non-empty; Cotality is EXTINGUISHED" },
  { storeKey: "pls:cotality:permits", why: "12 rows, 2 non-empty; Cotality is EXTINGUISHED" },
  { storeKey: "pls:cotality:hoa", why: "2 rows, 1 non-empty; Cotality is EXTINGUISHED" },
  { storeKey: "pls:cotality:comparables", why: "2 rows, 1 non-empty; Cotality is EXTINGUISHED" },

  // --- holds a DIFFERENT subject than its key suggests.
  {
    storeKey: "pls:cad:owner-occupancy",
    why:
      "145 rows, 42 non-empty, and the payload is an OCCUPANCY SIGNAL (kind cad-owner-occupancy, signal " +
      "likely-absentee or unknown, basis mailing-differs-from-situs) — never an owner NAME. Registering it " +
      "under owner-name would have compared two different subjects and called the result a disagreement.",
  },
  {
    storeKey: "pls:permits:record",
    why:
      "142 rows, 136 of them empty. The 6 non-empty match on a NORMALISED STREET LINE and say so in their own " +
      "caveat ('Not a parcel-id join'), so they are not keyed on the same entity as anything else. The durable " +
      "permit store is permit_record at 2,849,138 rows keyed on permit_number. A retirement candidate, not a " +
      "reconciliation case.",
  },
  { storeKey: "pls:epa:ejscreen", why: "58 rows, 56 non-empty; no atom counterpart, no second store" },
  { storeKey: "pls:national:opportunity-zone", why: "170 rows, all non-empty; no atom counterpart" },
  { storeKey: "pls:usgs:ned-elevation", why: "58 rows, all non-empty; see atoms:parcel-terrain-model" },
];

/**
 * Every canonical subject held by two or more stores.
 *
 * ORDERING IS BY EVIDENCE, NOT BY IMPORTANCE. `flood-zone` is first because it
 * is the case the operator ruling was written from, not because it is the worst.
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
          "parcel centroid point-in-polygon against tx_fema_nfhl_flood_zone, bbox-filtered to the county, " +
          "SFHA winning any tie (packages/engine-core/scripts/write-flood-hazard-fact-county.mjs)",
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
        samplingContract: "per-engagement live adapter cache, 176 rows, all non-empty; vestigial",
      },
    ],
  },
  {
    subject: "zoning-district",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: "the stamping city GIS feature service named in the atom sourceUrl",
    notes:
      "THREE stores that hold a value. CORRECTION to this lane's own CP1 finding F7, which said four: " +
      "cotality:zoning was counted as a fourth on the strength of its adapter key, and all 65 of its rows are " +
      "the empty object. It holds no zoning value and is excluded above with that measurement. " +
      "The Bastrop zoning-fact atoms split by origin: 9,560 are real point-in-polygon stamps off city GIS " +
      "(bastrop-city-tx 5,798 and elgin-tx 3,762) and 52,700 carry sourceAdapter " +
      "cortex-tier1-snapshot-breadth-bake, meaning they are a TRANSFORM of tier1 rather than an independent " +
      "reading — their own citation ends 'breadth bake is TRANSFORM only'. txgio_parcel.zoning_district is a " +
      "third home on the raw parcel fabric, and it IS parcel-keyed, so it counts.",
    stores: [
      {
        storeKey: "atoms:zoning-fact",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='zoning-fact'",
        valuePath: "body->>'district'",
        editionPath: "body->>'versionStamp'",
        samplingContract:
          "point-in-polygon stamp against a city GIS layer, or a transform of the tier1 snapshot",
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
    ],
  },
  {
    subject: "land-use-code",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: "the county appraisal roll export named in sourceVintage",
    notes:
      "The land-use-fact atom and tier1 baseFacts.landUse.code both derive from the CAD roll. " +
      "cad-parcel-roll.propertyUseCode is a third home for the same code on a different entity key " +
      "(county:propId:taxYear), which is itself worth a ruling: a subject keyed two ways in one database " +
      "cannot be joined without knowing the tax year.",
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
    groundTruth:
      "county appraisal roll (cad-parcel-roll), the only store carrying a street segment for the gap parcels",
    notes:
      "tier1 baseFacts.situsAddress is copied from txgio_parcel.situs_address; the CAD roll is an independent " +
      "reading. SS-W5 measured 1,036 Bastrop parcels where the CAD roll carries a street and the served path " +
      "does not — that count is RELAYED here, not re-derived by this lane.",
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
      "owner-fact and cad-parcel-roll.ownerName both come off the roll; txgio_parcel.owner_name is the TxGIO " +
      "attribute and is a genuinely independent reading. cad:property is a 145-row per-engagement cache " +
      "(42 non-empty) that also carries an owner name. Note what is NOT here: cad:owner-occupancy sounds like a " +
      "fourth store and holds an occupancy signal rather than a name.",
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
        storeKey: "pls:cad:property",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='cad:property'",
        valuePath: "payload_json->>'ownerName'",
        editionPath: "payload_json->>'sourceVintage'",
        samplingContract:
          "145-row per-engagement CAD cache, 42 of them non-empty; vestigial, but it does carry an owner name",
      },
    ],
  },
  {
    subject: "assessed-value",
    entityKind: "parcel",
    duplicationClass: "vestigial-cache",
    groundTruth: "county appraisal roll for the stated tax year",
    notes:
      "Found by the detector, not named by the brief. cad:tax and cad:property are 145-row per-engagement " +
      "caches (42 non-empty each) carrying assessedValue and landValue for parcels the appraisal-roll atom " +
      "also covers at roughly 5 M scale. Nothing refreshes them. Naming it matters because a stale cache " +
      "carrying a DOLLAR FIGURE is the one a customer is most likely to quote back at us.",
    stores: [
      {
        storeKey: "atoms:cad-parcel-roll",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='cad-parcel-roll'",
        valuePath: "body->>'assessedValue'",
        editionPath: "body->>'sourceVintage'",
        samplingContract: "verbatim appraisal-roll record, keyed county:propId:taxYear",
      },
      {
        storeKey: "pls:cad:tax",
        db: "cortex",
        table: "place_layer_snapshots",
        discriminator: "adapter_key='cad:tax'",
        valuePath: "payload_json->>'assessedValue'",
        editionPath: "payload_json->>'sourceVintage'",
        samplingContract: "145-row per-engagement cache, 42 non-empty; valueBasis county-assessed",
      },
    ],
  },
  {
    subject: "buildable-envelope-status",
    entityKind: "parcel",
    duplicationClass: "copy-transform",
    groundTruth: null,
    notes:
      "THREE stores, two of which sit in the same table under different adapter keys. tier1.envelope was " +
      "retired IN PLACE (declineReason atom_path_pending, disclosure 'Tier-1 bake no longer authors product " +
      "envelope confidence') while tier2.envelope still answers for the same parcel with its own decline " +
      "reason, and the atom carries a derived area. A retired store that still answers is the worst of the " +
      "three shapes, because nothing about it reads as retired to a consumer.",
    stores: [
      {
        storeKey: "atoms:buildable-envelope",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='buildable-envelope'",
        valuePath: "body->'outcome'->>'kind'",
        editionPath: "body->>'versionStamp'",
        samplingContract:
          "setbacks applied to parcel geometry, or a transform of the tier1 snapshot",
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
      "The parcel-node atom carries a retirement lifecycle (status retired, retiredReason naming the vintage " +
      "that dropped the account). The tier1 snapshot has no lifecycle at all: a retired parcel keeps its baked " +
      "row and keeps serving. 48021:36521 is exactly this — parcel-node retired 2026-08-11, tier1 row still " +
      "live, and the tier1 row is what the sheet renders.",
    stores: [
      {
        storeKey: "atoms:parcel-node",
        db: "atoms",
        table: "atoms",
        discriminator: "entity_type='parcel-node'",
        valuePath: "body->>'status'",
        editionPath: "body->>'sourceVintage'",
        samplingContract:
          "presence in the county's current StratMap plan; a positive absence writes a retirement",
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
