/**
 * THE SIX FROZEN MEASUREMENT SPECS. Lane SS-W14, OPS-16 amendment A-020 (P-47).
 *
 * Every figure below was measured by this lane against the live production
 * stores on 2026-08-19, read-only, or read at source in this repo on this
 * branch. Figures relayed from another lane say so and name it.
 *
 * The rails are ordered by how hard the unit question was to answer, which is
 * also the order in which a scorer is most likely to get them wrong.
 */

import type { RailScoringSpec, UnscoredRailKey } from "./types.js";

/**
 * The parcel-roster denominator, established by five independent exact matches
 * and used by four of the six rails. Written once so the rails cannot drift.
 */
const PARCEL_ROSTER_DENOMINATOR_RULE =
  "every parcel-node atom in the county, counted by the entity_id prefix " +
  "'<fips>:', with the geometryLoaded=false subcount published beside the " +
  "ratio as a measured exclusion class and NEVER subtracted from it";

const PARCEL_ROSTER_DERIVATION =
  "atoms store: SELECT count(*) FROM atoms WHERE entity_type='parcel-node' " +
  "AND entity_id >= '<fips>:' AND entity_id < '<fips>;' " +
  "(the half-open range is an index-only scan on atoms_entity_composite_unique; " +
  "a LIKE '<fips>:%' predicate measures the same set but is not index-only)";

const PARCEL_ROSTER_SECOND_MEASURE =
  "writer-reach denominator: cortex txgio_parcel, count(DISTINCT " +
  "normalizeForJoin(prop_id)) for the county over rows whose prop_id is " +
  "non-null, non-blank, not all-zero and matches ^[A-Za-z0-9._-]+$ after " +
  "leading-zero strip. That is isUsablePropId + normalizeForJoin from " +
  "packages/atoms/src/fact-writer-ids.ts expressed in SQL, and it is the set " +
  "the depth writers actually iterate. Where it disagrees with the parcel-node " +
  "roster, publish both; the gap is CAD-roll-union nodes the depth writers " +
  "never see";

const PARCEL_ROSTER_EVIDENCE =
  "VERIFIED 2026-08-19 by lane SS-W14 on five counties, exact to the parcel: " +
  "Harris 48201 usable prop_ids 1,523,640 = parcel-node 1,523,640 = " +
  "rrc-pipeline-fact 1,523,640 = rail-corridor-fact 1,523,640; Anderson 48001 " +
  "31,676 = 31,676 = 31,676; Wise 48497 48,428 = 48,428 = 48,428; Crane 48103 " +
  "usable 5,567 = rrc-pipeline-fact 5,567 = well-fact parcels touched 5,567 " +
  "against parcel-node 5,805; Bastrop 48021 usable 62,256 = rrc-pipeline-fact " +
  "62,256 = rail-corridor-fact 62,256 against parcel-node 62,398. " +
  "REJECTED alternative: county_manifest.parcel_count_est, which diverges from " +
  "the parcel-node count by more than 20% in 19 of 253 counties and by 184% on " +
  "Harris (536,512 estimated against 1,523,640 atoms) while the statewide sums " +
  "agree to 2.7%, which is exactly how a bad per-county denominator hides";

const PARCEL_ROSTER_EXCLUSION =
  "parcel-node atoms with geometryLoaded=false, which no geometry-dependent " +
  "rail can ever determine. MEASURED, not estimated: Crane 48103 has 252 of " +
  "5,805 (4.3%) and Bastrop 48021 has 552 of 62,398 (0.9%). Their keys are " +
  "synthetic '_feature-stratmap25-landparcels-<fips>-<name>-<vintage>-<n>' " +
  "tokens minted for txgio features carrying no usable prop_id. Scoring " +
  "against geometry-true nodes ONLY reproduces the mud 209/186 defect at " +
  "parcel scale: Crane has 5,567 pipeline determinations against 5,553 " +
  "geometry-true nodes, which is 100.25%";

export const ROADS_SPEC: RailScoringSpec = {
  railKey: "roads",
  atomEntityTypes: ["road-node"],
  entityIdShape: "<fips>:road:<osmWayId>",
  thresholdPct: 95,
  railKind: "spine",

  unit: "source-feature",
  discriminator: "unobservable-family-empty",

  coveredDefinition:
    "there is no per-parcel roads determination to be covered. A road-node " +
    "atom is one road centerline, keyed on the OSM way id, and " +
    "PARCEL_KEYED_PROPERTY_ENTITY_TYPES explicitly EXCLUDES road-node " +
    "(packages/atoms/src/property-instances.ts line 213). The only per-parcel " +
    "expression of roads in the store is the property-boundary-edge family " +
    "(facingRoad refs), which is not one of the fourteen rails and exists in " +
    "exactly ONE county: 26,846 edges over 3,732 parcels, all in Bastrop 48021",

  establishedAbsenceDefinition:
    "none exists. The writer emits no county-coverage absence atom for roads. " +
    "A county with no queryable roads is indistinguishable in the store from a " +
    "county the writer never visited",

  notYetDefinition:
    "zero road-node atoms with the county's entity_id prefix. That is the " +
    "state of 153 of 254 counties (RELAYED from SS-W9's WRITTEN layer, " +
    "measured 2026-08-19T15:07:57Z; my own statewide re-count exceeded a " +
    "300-second statement timeout twice and was abandoned rather than widened)",

  falseAbsenceShapes: [
    "the writer exits with code 1 and the message 'county has no row in " +
      "tx_county_boundary — NOT-YET for roads rail' when the boundary is " +
      "missing. It writes nothing, which is correct, but nothing in the store " +
      "distinguishes that county from one never attempted",
  ],

  denominator: {
    rule:
      "the count of OSM ways the pinned Geofabrik Texas PBF yields inside the " +
      "county boundary after the taxonomy filter. THIS NUMBER IS NOT PERSISTED " +
      "ANYWHERE",
    derivation:
      "only reproducible by re-running write-road-node-county.mjs, which " +
      "computes waysRead into an optional --out summary JSON that is written " +
      "to a path of the operator's choosing and never to a table. cortex " +
      "pg_tables carries no road table of any kind (VERIFIED 2026-08-19: a " +
      "LIKE '%road%' scan over pg_tables returns only county_rail, " +
      "rail_state_history and rail_verification, none of which is a road census)",
    exclusionClass:
      "ways rejected by the taxonomy filter, and duplicate osmWayId within a " +
      "county, both counted by the planner and both discarded with the run",
    secondMeasure: null,
    evidence:
      "VERIFIED 2026-08-19: Bastrop 48021 holds 36,802 road-node atoms drawn " +
      "from FIVE different adapters, not one. road-intake-osm-geofabrik-pbf " +
      "16,895, road-intake-bastrop-county-roadway 11,351, " +
      "road-intake-osm-overpass 4,893, road-intake-elgin-osm 2,356, " +
      "road-intake-county-streets-surveyed-2016 1,307. Travis 48453 and Harris " +
      "48201 hold ZERO. The family is also heterogeneous in body vintage: " +
      "9,530 Bastrop atoms classified 'residential' carry a NULL " +
      "isPedestrianWay because they predate the field",
  },

  ceiling: {
    acquisitionCeilingRule:
      "counties intersecting the pinned Geofabrik Texas extract, which is the " +
      "whole state, INTERSECTED with counties holding a row in cortex " +
      "tx_county_boundary, because the writer reads the clip polygon from " +
      "there and refuses without it",
    determinationCeilingRule:
      "identical to the acquisition ceiling. Roads emits no absence, so there " +
      "is no wider determination set",
    ledgerPublishesToday:
      "maxCountiesReachable null, reachPct null, sourceBasis 'no capability " +
      "probe defined for this rail' (read live from GET /api/county-ledger, " +
      "servedAt 2026-08-19T16:26:04.373Z)",
    reDerivedVerdict:
      "254. VERIFIED 2026-08-19: SELECT count(*) FROM tx_county_boundary " +
      "returns 254. The null the ledger publishes is honest about having no " +
      "probe and must not be read as a zero",
  },

  scorableToday: false,
  blockingGap:
    "roads has no persisted denominator and no absence shape. It can be scored " +
    "TODAY only as a binary presence rail (the county holds at least one " +
    "road-node atom), which is not a coverage percentage and must never be " +
    "published as one. To score it as a percentage, the writer must persist a " +
    "per-county extraction census carrying at minimum (county_fips, pbf_md5, " +
    "ways_extracted, extracted_at), and a county-coverage absence atom must " +
    "exist so 'no queryable roads' is distinguishable from 'never run'. Both " +
    "are engine work and neither is in this lane's scope",

  writerSource:
    "packages/engine-core/scripts/write-road-node-county.mjs plus " +
    "packages/engine-core/src/road-node/plan-county-road-nodes.ts. The atom " +
    "shape is packages/atoms/src/road-instances.ts, ROAD_NODE_ID_PATTERN " +
    "/^\\d{5}:road:-?\\d+$/",

  measuredEvidence: [
    "VERIFIED 2026-08-19: road-node in Bastrop 48021 = 36,802; Travis 48453 = " +
      "0; Harris 48201 = 0. Prefix-range counts, index-only.",
    "VERIFIED 2026-08-19: property-boundary-edge, the only per-parcel road " +
      "relation in the store, holds 26,846 rows across exactly 1 county " +
      "(48021), covering 3,732 parcels.",
    "VERIFIED 2026-08-19: tx_county_boundary holds 254 rows.",
    "RELAYED from SS-W9 (measured 2026-08-19T15:07:57Z): road-node written in " +
      "101 of 254 counties, 1,746,716 atoms.",
  ],
};

export const FOOTPRINT_SPEC: RailScoringSpec = {
  railKey: "footprint",
  atomEntityTypes: ["building-footprint"],
  entityIdShape: "<fips>:<propId>:footprint:<footprintId>",
  thresholdPct: 90,
  railKind: "derived",

  unit: "parcel",
  discriminator: "body-field",

  coveredDefinition:
    "the parcel holds at least one building-footprint atom whose body carries " +
    "no 'absence' key. footprintId is 'primary' for the first joined footprint " +
    "and 'accessory-<n>' for each subsequent one, so a covered parcel " +
    "contributes one to the numerator regardless of how many buildings it has",

  establishedAbsenceDefinition:
    "the parcel holds a building-footprint atom whose body carries " +
    "absence.kind='no-footprint-feature' with a reason naming the join " +
    "threshold. That is a positive determination: the staged geometry-true " +
    "join ran against a real parcel ring and no candidate cleared the overlap " +
    "threshold",

  notYetDefinition:
    "the parcel is on the roster and holds no building-footprint atom of " +
    "either shape. At county scale this is the whole state's metros: 80 of 254 " +
    "counties hold no footprint atom at all, and not one metro is among the " +
    "174 that do",

  falseAbsenceShapes: [
    "absence.kind is 'no-footprint-feature' for BOTH 'the join ran and found " +
      "nothing' and 'the parcel had no usable ring to join with' " +
      "(planCountyFromStagedGeometryTrueJoin, the skippedNoRing branch). Only " +
      "the free-text reason distinguishes them: a real determination reads " +
      "'staged-geometry-true-join-below-10pct-overlap...' and an input failure " +
      "reads 'no usable parcel ring for <fips>:<propId>'. A scorer must " +
      "discriminate on the reason prefix, and the kind should be split. " +
      "MEASURED: all 24,629 Wise 48497 absences are the real determination; " +
      "the input-failure variant did not fire there",
  ],

  denominator: {
    rule: PARCEL_ROSTER_DENOMINATOR_RULE,
    derivation: PARCEL_ROSTER_DERIVATION,
    exclusionClass: PARCEL_ROSTER_EXCLUSION,
    secondMeasure:
      PARCEL_ROSTER_SECOND_MEASURE +
      ". Footprint additionally supports a THIRD, source-side measure that no " +
      "other rail in this set does: staged features joined over staged " +
      "features available for the county, from cortex tx_building_footprint. " +
      "It answers a different question (did the join consume the source) and " +
      "must be labelled as such",
    evidence: PARCEL_ROSTER_EVIDENCE,
  },

  ceiling: {
    acquisitionCeilingRule:
      "cortex: SELECT DISTINCT county_fips FROM tx_building_footprint. That is " +
      "the ONLY source the county writer may read; a silent fallback to the " +
      "Microsoft ML zip is forbidden and CI greps for it",
    determinationCeilingRule:
      "identical to the acquisition ceiling. A staged-empty county HALTS " +
      "(STAGED_FOOTPRINT_COUNTY_EMPTY) rather than writing absence atoms, so a " +
      "county outside the staged set can produce neither a present nor an " +
      "absent determination",
    ledgerPublishesToday:
      "maxCountiesReachable 254, reachPct 1, sourceBasis 'ML footprint sources " +
      "theoretically statewide', limitation 'O(fp x parcels) compute limits " +
      "metro-scale apply; capability is theoretical max'. It is a HARDCODE in " +
      "STATIC_RAIL_CAPABILITIES, not a probe",
    reDerivedVerdict:
      "254, and the hardcode is CORRECT but for the wrong reason. VERIFIED " +
      "2026-08-19: cortex tx_building_footprint holds 10,674,975 footprints " +
      "across count(DISTINCT county_fips) = 254, including Harris 48201 " +
      "895,154, Dallas 48113 656,706, Travis 48453 73,394 and Bastrop 48021 " +
      "65,974. The metros are STAGED and hold zero footprint ATOMS, so the " +
      "gap is the O(fp x parcels) join, exactly as the limitation string says. " +
      "Replace the hardcode with the same DISTINCT county_fips probe the mud " +
      "rail already uses so the number can move when staging does",
  },

  scorableToday: true,
  blockingGap: "",

  writerSource:
    "packages/engine-core/scripts/write-building-footprint-county.mjs via " +
    "planCountyStagedFootprints and planCountyFromStagedGeometryTrueJoin in " +
    "packages/engine-core/src/building-footprint/staged-footprint-join.ts. " +
    "Atom construction is packages/atoms/src/building-footprint-writer.ts, " +
    "entityId = `${parcelNodeId}:footprint:${footprintId}`",

  measuredEvidence: [
    "VERIFIED 2026-08-19, Wise 48497: entity_id suffix ':footprint:primary' " +
      "splits 24,629 rows WITH an absence body against 23,799 WITHOUT, plus " +
      "accessory-1 through at least accessory-24. Present and absent share one " +
      "suffix, so an index-only prefix scorer would count all 48,428 as " +
      "covered. Wise scores 48,428 of 48,428 (100.00%) on the writer-reach " +
      "denominator, of which 23,799 covered and 24,629 established-absent.",
    "VERIFIED 2026-08-19: ZERO building-footprint atoms carry a " +
      "'_county_coverage' entity_id anywhere in the store, confirming the " +
      "staged path never emits the county-coverage absence shape that the " +
      "legacy ML planner still contains.",
    "VERIFIED 2026-08-19: cortex tx_building_footprint holds 10,674,975 rows " +
      "over 254 distinct county_fips.",
    "RELAYED from SS-W9 (2026-08-19T15:07:57Z): building-footprint written in " +
      "174 of 254 counties, 3,495,678 atom rows, 2,829,513 of them the " +
      "footprint:primary slot. Bastrop, Travis, Harris, Dallas, Williamson and " +
      "Bexar all hold zero.",
  ],
};

export const EASEMENT_SPEC: RailScoringSpec = {
  railKey: "easement",
  atomEntityTypes: ["utility-easement"],
  entityIdShape:
    "<fips>:<propId>:<easementId> for present and per-parcel absence; " +
    "<fips>:_county_coverage:<easementId> for the county-coverage absence",
  thresholdPct: 90,
  railKind: "derived",

  unit: "hybrid-parcel-or-county",
  discriminator: "unobservable-family-empty",

  coveredDefinition:
    "in a PRESENT-DATA county, the parcel holds a utility-easement atom with " +
    "geometry and no absence. Only two present-data routes exist in the entire " +
    "routing table: McLennan 48309 at county scope via cad-easement-rest " +
    "(layers 9 and 10 of the McLennanCADWebService FeatureServer) and Bastrop " +
    "48021 at city-limits scope via municipal-easement-rest. Every other " +
    "county in Texas routes to honest-absence",

  establishedAbsenceDefinition:
    "TWO different shapes at two different granularities, and this is the " +
    "whole point of the rail. In an honest-absence county it is ONE atom for " +
    "the WHOLE COUNTY, carrying verifiedAbsence.provenanceScope naming the " +
    "sources probed. The planner's own comment is explicit that this is " +
    "deliberate: 'Unincorporated parcels rely on this at serve time, not " +
    "millions of per-parcel sentinels.' In a present-data county it is a " +
    "per-parcel absence for parcels the easement join did not hit",

  notYetDefinition:
    "the county holds neither a county-coverage absence atom nor any " +
    "per-parcel easement atom. That is the state of ALL 254 counties today",

  falseAbsenceShapes: [
    "planCountyEasementHonestAbsence THROWS if called for a county whose route " +
      "is not honest-absence, so the county-coverage absence cannot be minted " +
      "for a present-data county by accident. That guard is real and this " +
      "field records that it was checked, not that a defect was found",
  ],

  denominator: {
    rule:
      "TWO denominators, never merged. County regime: 1 county-coverage " +
      "determination per county, over the 254 counties, giving a county-unit " +
      "ratio. Parcel regime: the parcel-roster denominator, over the counties " +
      "the routing table sends to a present-data adapter. Reporting a single " +
      "blended percentage for this rail is a category error",
    derivation:
      "county regime: count of counties holding a utility-easement atom whose " +
      "entity_id matches '<fips>:_county_coverage:%', over 254. Parcel regime: " +
      PARCEL_ROSTER_DERIVATION +
      ", restricted to the counties resolveCountyEasementRoute returns a " +
      "non-honest-absence route for",
    exclusionClass:
      "none in the county regime, because an honest-absence determination is " +
      "always makeable. In the parcel regime, the same geometryLoaded=false " +
      "exclusion the other parcel rails carry",
    secondMeasure: null,
    evidence:
      "VERIFIED 2026-08-19: SELECT count(*) FROM atoms WHERE " +
      "entity_type='utility-easement' returns zero rows, in 0.49 seconds. The " +
      "family is genuinely empty, and easement is therefore the ONE rail of " +
      "the six whose 254 not-yet cells are entirely honest. The routing table " +
      "is packages/engine-core/src/utility-easement/constants.ts, read at " +
      "source on this branch",
  },

  ceiling: {
    acquisitionCeilingRule:
      "the counties resolveCountyEasementRoute returns a non-honest-absence " +
      "route for. TODAY that is a set of exactly TWO: {48309 at county scope, " +
      "48021 at city-limits scope}. It is a hardcoded table in the engine, not " +
      "a database probe, so it must be re-read from source and never cached",
    determinationCeilingRule:
      "ALL 254 counties. This is the rail that proves why the two ceilings " +
      "must be separate: an honest absence is determinable everywhere, and " +
      "bounding easement absences by its acquisition reach of 2 would be the " +
      "mud 209/186 defect with the sign flipped",
    ledgerPublishesToday:
      "maxCountiesReachable null, reachPct null, sourceBasis 'no capability " +
      "probe defined for this rail' (read live 2026-08-19T16:26:04.373Z)",
    reDerivedVerdict:
      "acquisition 2, determination 254. Neither is knowable from a database " +
      "probe, because the easement route lives in engine source. The " +
      "capability probe must be taught to read a checked-in table for this " +
      "rail or it will keep publishing null",
  },

  scorableToday: false,
  blockingGap:
    "there is nothing to score. The family holds zero atoms and " +
    "write-utility-easement-county.mjs has never been run in any county. " +
    "Unlike roads, the spec is complete and the scorer is buildable now; it " +
    "will simply return 254 not-yet cells until the writer runs. Running the " +
    "honest-absence path across 254 counties writes 254 atoms and would make " +
    "the entire rail satisfied-absent at county granularity, which is a real " +
    "and cheap coverage gain and is a writer decision, not a scorer one",

  writerSource:
    "packages/engine-core/scripts/write-utility-easement-county.mjs plus " +
    "packages/engine-core/src/utility-easement/{constants,county-absence," +
    "plan-county-utility-easement}.ts",

  measuredEvidence: [
    "VERIFIED 2026-08-19: zero utility-easement atoms in the store.",
    "VERIFIED at source 2026-08-19: resolveCountyEasementRoute returns " +
      "honest-absence for every county except 48309 (county scope) and 48021 " +
      "(city-limits scope).",
    "VERIFIED at source 2026-08-19: legacy-design-tools " +
      "lib/db/src/schema/railEngineBinding.ts declares easement with NO " +
      "engineWriterScript and noWriterReason 'No bulk writer or LDT scorer " +
      "bound', while hauska-engine ships write-utility-easement-county.mjs. " +
      "The live cortex county_rail row meanwhile says has_writer = true with " +
      "writer_ref 'hauska-engine write-utility-easement-county.mjs' and a " +
      "notes field reading 'No writer yet.' Three declarations, two of them " +
      "wrong, on one rail.",
  ],
};

export const RRC_WELLS_SPEC: RailScoringSpec = {
  railKey: "rrc-wells",
  atomEntityTypes: ["well-fact"],
  entityIdShape:
    "<fips>:<propId>:<apiNumber14> for present, <fips>:<propId>:none for the " +
    "per-parcel absence, <fips>:_county_coverage:_county_coverage for the " +
    "county-coverage absence",
  thresholdPct: 90,
  railKind: "derived",

  unit: "parcel",
  discriminator: "entity-id-suffix",

  coveredDefinition:
    "the parcel holds at least one well-fact atom whose entity_id does NOT end " +
    "in ':none'. One atom is one (parcel, well) association, so atom rows are " +
    "NOT wells and are NOT parcels: a single well within the 152 m proximity " +
    "radius of eight parcels produces eight atoms. Quoting the row count as a " +
    "well count is the easiest error this rail offers",

  establishedAbsenceDefinition:
    "the parcel holds a well-fact atom with entity_id ending ':none', body " +
    "absence.kind 'no-well-on-or-near' and reason 'no Texas RRC surface well " +
    "on or within 152 m of parcel geometry'. That is a positive determination " +
    "made against the statewide staged well index",

  notYetDefinition:
    "the parcel is on the roster and holds no well-fact atom of either shape. " +
    "At county scale, 80 of 254 counties, INCLUDING Harris 48201 which is the " +
    "one county the published ceiling names",

  falseAbsenceShapes: [
    "none in the current planner. The absence is emitted only after the bbox " +
      "prefilter and the point-in-polygon plus distance test have both run " +
      "against real parcel geometry, so it is a finding rather than a failure " +
      "mode. Parcels with an unusable key are SKIPPED (counted as " +
      "skippedUnusableKey) rather than absence-written, which is correct",
  ],

  denominator: {
    rule: PARCEL_ROSTER_DENOMINATOR_RULE,
    derivation: PARCEL_ROSTER_DERIVATION,
    exclusionClass: PARCEL_ROSTER_EXCLUSION,
    secondMeasure: PARCEL_ROSTER_SECOND_MEASURE,
    evidence: PARCEL_ROSTER_EVIDENCE,
  },

  ceiling: {
    acquisitionCeilingRule:
      "cortex: SELECT DISTINCT county_fips FROM tx_rrc_well, plus every county " +
      "whose bbox catches one of the rows with a NULL county_fips, because the " +
      "writer selects on lng/lat bbox and not on county_fips",
    determinationCeilingRule:
      "every county with a loaded parcel roster. A parcel with geometry can " +
      "always be determined to have no well near it, whether or not that " +
      "county contains wells",
    ledgerPublishesToday:
      "maxCountiesReachable 1, reachPct 0.003937, sourceBasis 'RRC public GIS " +
      "Harris County mirror carries statewide well coverage " +
      "(lib/adapters/src/federal/texas-rrc.ts)', limitation 'Point layer " +
      "mirrored from Harris endpoint; not per-county ingest'. Read live " +
      "2026-08-19T16:26:04.373Z",
    reDerivedVerdict:
      "254, NOT 1, and the published record contradicts itself inside one row. " +
      "The '1' is a HARDCODE in STATIC_RAIL_CAPABILITIES in " +
      "legacy-design-tools lib/db/src/railCoverageCapability.ts, citing an " +
      "adapter the live writer REFUSES to use: " +
      "write-well-fact-county.mjs aborts with 'REFUSING TO RUN: well-fact " +
      "source still points at Harris mirror (gis.hctx.net)'. The live source " +
      "is staged tx_rrc_well, whose own module header reads 'NEVER use the " +
      "Harris County ArcGIS mirror for apply, it holds ~0.92% of TX'. " +
      "VERIFIED 2026-08-19: tx_rrc_well holds 1,396,049 wells over 254 " +
      "distinct county_fips plus 1,556 NULL-county rows, and Harris 48201 " +
      "holds 12,850 of them, which IS 0.92%. The standing memory that this " +
      "source is Harris-only with 12,796 features measured the mirror, and the " +
      "mirror is not the source. Applying the published ceiling would " +
      "manufacture 173 false out-of-reach cells against counties that are " +
      "already written",
  },

  scorableToday: true,
  blockingGap: "",

  writerSource:
    "packages/engine-core/scripts/write-well-fact-county.mjs via " +
    "packages/engine-core/src/well-fact/{fetch-wells-staged," +
    "plan-county-well-facts,well-fact-atoms}.ts. Absence wellKey is the " +
    "literal string 'none'; WELL_FACT_PROXIMITY_RADIUS_METERS is 152",

  measuredEvidence: [
    "VERIFIED 2026-08-19, Crane 48103: 60,396 well-fact rows, of which 1,839 " +
      "end ':none', across 5,567 distinct parcels. That reproduces SS-W9's " +
      "1,839 absence plus 58,557 present exactly, from an independent query. " +
      "5,567 is ALSO the county's usable-prop_id count exactly, so the writer " +
      "reached 100.00% of the addressable universe; against the 5,805-atom " +
      "parcel-node roster the same county scores 95.90%, and the 238-parcel " +
      "gap is entirely geometryLoaded=false nodes.",
    "VERIFIED 2026-08-19: Harris 48201 holds ZERO well-fact atoms while " +
      "cortex tx_rrc_well holds 12,850 Harris wells. The one county the " +
      "ceiling names is the one county with staged wells and no atoms.",
    "VERIFIED 2026-08-19: Bastrop 48021 holds ZERO well-fact atoms against " +
      "2,548 staged Harris-independent wells in tx_rrc_well.",
    "RELAYED from SS-W9 (2026-08-19T15:07:57Z): well-fact written in 174 of " +
      "254 counties, 4,338,295 atom rows, of which 2,297,099 are ':none' " +
      "absences and 2,041,196 name a real API number.",
  ],
};

export const RRC_PIPELINES_SPEC: RailScoringSpec = {
  railKey: "rrc-pipelines",
  atomEntityTypes: ["rrc-pipeline-fact"],
  entityIdShape: "<fips>:<propId>, bare parcelNodeId, one atom per parcel",
  thresholdPct: 90,
  railKind: "derived",

  unit: "parcel",
  discriminator: "present-with-negative-flag",

  coveredDefinition:
    "the parcel holds an rrc-pipeline-fact atom. THAT IS THE WHOLE TEST, and " +
    "it is not the test the other rails use. This rail has no absence atom in " +
    "its normal path: a parcel with no pipeline inside the buffer gets a " +
    "PRESENT atom with nearPipeline=false, by explicit design " +
    "('Outside buffer -> PRESENT nearPipeline=false. Empty pipeline index " +
    "after successful read -> same (no pipes in county)'). Both values of " +
    "nearPipeline are determinations and both count as covered",

  establishedAbsenceDefinition:
    "nearPipeline=false on a present atom. It is semantically an absence and " +
    "structurally a presence, and a scorer that keys on the body's 'absence' " +
    "field will find none and conclude the rail is unscored",

  notYetDefinition:
    "the parcel is on the roster and holds no rrc-pipeline-fact atom at all. " +
    "At county scale, 4 of 254 counties",

  falseAbsenceShapes: [
    "the ONE typed absence this rail emits, absence.kind " +
      "'no-pipeline-coverage', fires ONLY when sourceReadFailed is true. Its " +
      "name says the county has no pipeline coverage; its meaning is that the " +
      "tx_rrc_pipeline read FAILED. A scorer that counts it as an established " +
      "absence converts an instrument failure into a finding about the world, " +
      "for every parcel in the county at once. MEASURED across eight counties " +
      "(48001, 48021, 48103, 48141, 48201, 48261, 48303, 48497): zero typed " +
      "absences of any kind, so it has not fired in the sample. The kind " +
      "should be renamed to say what it means",
    "absence.kind 'no-parcel-geometry' is likewise an input failure, not a " +
      "determination about pipelines",
  ],

  denominator: {
    rule: PARCEL_ROSTER_DENOMINATOR_RULE,
    derivation: PARCEL_ROSTER_DERIVATION,
    exclusionClass: PARCEL_ROSTER_EXCLUSION,
    secondMeasure: PARCEL_ROSTER_SECOND_MEASURE,
    evidence: PARCEL_ROSTER_EVIDENCE,
  },

  ceiling: {
    acquisitionCeilingRule:
      "cortex: SELECT DISTINCT county_fips FROM tx_rrc_pipeline",
    determinationCeilingRule:
      "every county with a loaded parcel roster. A successful read of an empty " +
      "pipeline index still determines every parcel in the county",
    ledgerPublishesToday:
      "maxCountiesReachable null, reachPct null, sourceBasis 'no capability " +
      "probe defined for this rail' (read live 2026-08-19T16:26:04.373Z)",
    reDerivedVerdict:
      "254 on acquisition and 253 on determination. VERIFIED 2026-08-19: " +
      "tx_rrc_pipeline holds 491,178 segments over 254 distinct county_fips " +
      "with zero NULLs; the determination ceiling is bounded by the parcel " +
      "roster, which the live capability probe measures as 253 counties in " +
      "txgio_parcel",
  },

  scorableToday: true,
  blockingGap: "",

  writerSource:
    "packages/engine-core/scripts/write-rrc-pipeline-fact-county.mjs via " +
    "packages/engine-core/src/rrc-pipeline-fact/plan-county-rrc-pipeline.ts. " +
    "Dedupe key is t4permit|p5_num and never the operator name",

  measuredEvidence: [
    "VERIFIED 2026-08-19, Bastrop 48021: 62,256 atoms over 62,256 distinct " +
      "parcels, 0 typed absences, 5,879 nearPipeline=true, 56,377 " +
      "nearPipeline=false, and 0 determinations with no matching parcel-node " +
      "atom. 62,256 is exactly the county's usable-prop_id count.",
    "VERIFIED 2026-08-19, Harris 48201: 1,523,640 atoms over 1,523,640 " +
      "distinct parcels, 278,787 nearPipeline=true, 0 typed absences. That " +
      "equals the parcel-node roster and the usable-prop_id count exactly, so " +
      "Harris pipelines score 100.00% on both denominators.",
    "VERIFIED 2026-08-19: zero typed absences in all eight sampled counties.",
    "VERIFIED at source 2026-08-19: legacy-design-tools RAIL_ENGINE_BINDINGS " +
      "gives rrc-pipelines atomEntityTypes [] with noWriterReason 'Atom family " +
      "not registered in engine PROPERTY_ENTITY_TYPES', while " +
      "packages/atoms/src/property-instances.ts line 204 lists " +
      "'rrc-pipeline-fact' in PROPERTY_ENTITY_TYPES. Any derivation reading " +
      "that binding concludes 12.5 million atoms cannot exist.",
    "RELAYED from SS-W9 (2026-08-19T15:07:57Z): rrc-pipeline-fact written in " +
      "250 of 254 counties, 12,519,688 atom rows.",
  ],
};

export const RAIL_CORRIDOR_SPEC: RailScoringSpec = {
  railKey: "rail-corridor",
  atomEntityTypes: ["rail-corridor-fact"],
  entityIdShape: "<fips>:<propId>, bare parcelNodeId, one atom per parcel",
  thresholdPct: 90,
  railKind: "derived",

  unit: "parcel",
  discriminator: "present-with-negative-flag",

  coveredDefinition:
    "the parcel holds a rail-corridor-fact atom. Identical shape to " +
    "rrc-pipelines: outside the buffer is a PRESENT atom with " +
    "nearRailCorridor=false, and an empty corridor index after a successful " +
    "fetch is the same, not mass absence. Both flag values count as covered",

  establishedAbsenceDefinition:
    "nearRailCorridor=false on a present atom",

  notYetDefinition:
    "the parcel is on the roster and holds no rail-corridor-fact atom. At " +
    "county scale, 2 of 254 counties",

  falseAbsenceShapes: [
    "absence.kind 'no-rail-coverage' fires on a failed NTAD source read, and " +
      "'no-parcel-geometry' on a missing ring. Both are input failures wearing " +
      "absence names, exactly as in rrc-pipelines",
  ],

  denominator: {
    rule: PARCEL_ROSTER_DENOMINATOR_RULE,
    derivation: PARCEL_ROSTER_DERIVATION,
    exclusionClass: PARCEL_ROSTER_EXCLUSION,
    secondMeasure: PARCEL_ROSTER_SECOND_MEASURE,
    evidence: PARCEL_ROSTER_EVIDENCE,
  },

  ceiling: {
    acquisitionCeilingRule:
      "the NTAD North American Rail Network line layer is national, so every " +
      "Texas county is inside it. There is no staged tx_narn_rail table in " +
      "cortex (VERIFIED 2026-08-19: to_regclass returns NULL), so unlike wells " +
      "and pipelines this ceiling cannot be probed from the database and must " +
      "be declared from the source's own extent",
    determinationCeilingRule:
      "every county with a loaded parcel roster",
    ledgerPublishesToday:
      "maxCountiesReachable 253, reachPct 0.99606, sourceBasis 'txgio_parcel " +
      "DISTINCT county_fips, corridor overlay needs parcel geometry context' " +
      "(read live 2026-08-19T16:26:04.373Z). Unlike wells and footprint this " +
      "one IS a live probe, and it probes the PARCEL side, which is the " +
      "determination ceiling and not the acquisition ceiling",
    reDerivedVerdict:
      "253 is the right NUMBER for the determination ceiling and the wrong " +
      "SHAPE. rail-corridor is written in 252 counties against a ceiling of " +
      "253, and because the probe returns a COUNT and not a SET, SS-W9's " +
      "classifier had to call 2 cells out-of-reach when at most 1 can be. A " +
      "ceiling that cannot name its members cannot classify a cell, and this " +
      "rail is where that shows up first",
  },

  scorableToday: true,
  blockingGap: "",

  writerSource:
    "packages/engine-core/scripts/write-rail-corridor-fact-county.mjs via " +
    "packages/engine-core/src/rail-corridor-fact/{ntad-source,staged-narn," +
    "plan-county-rail-corridor}.ts. NTAD_NARN_SOURCE_VINTAGE is 2026-07-21",

  measuredEvidence: [
    "VERIFIED 2026-08-19, Bastrop 48021: 62,256 atoms over 62,256 distinct " +
      "parcels, 0 typed absences, 3,637 nearRailCorridor=true, 58,619 false. " +
      "Exactly the usable-prop_id count.",
    "VERIFIED 2026-08-19, Harris 48201: 1,523,640 atoms over 1,523,640 " +
      "distinct parcels, 58,933 nearRailCorridor=true, 0 typed absences.",
    "VERIFIED 2026-08-19: cortex holds no tx_narn_rail table, so the corridor " +
      "source is not staged and its acquisition ceiling is not probeable.",
    "RELAYED from SS-W9 (2026-08-19T15:07:57Z): rail-corridor-fact written in " +
      "252 of 254 counties, 13,059,613 atom rows.",
  ],
};

export const RAIL_SCORING_SPECS: ReadonlyArray<RailScoringSpec> = [
  ROADS_SPEC,
  FOOTPRINT_SPEC,
  EASEMENT_SPEC,
  RRC_WELLS_SPEC,
  RRC_PIPELINES_SPEC,
  RAIL_CORRIDOR_SPEC,
];

export const RAIL_SCORING_SPEC_BY_KEY: Readonly<
  Record<UnscoredRailKey, RailScoringSpec>
> = Object.fromEntries(
  RAIL_SCORING_SPECS.map((spec) => [spec.railKey, spec]),
) as Record<UnscoredRailKey, RailScoringSpec>;
