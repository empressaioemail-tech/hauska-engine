/**
 * P-275: the live-currency source registry — ONE place that says which county is read from where,
 * by which field, and why that field is the right one.
 *
 * Extracted from `review-retired-parcel-nodes.mjs` so the registry itself is importable: the
 * review CLI, the namespace probe that produces the registration evidence, and the registry's own
 * test all read THIS object rather than three copies that can drift apart.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT MAKES AN ENTRY REGISTRABLE
 * ---------------------------------------------------------------------------------------------
 *
 * Two questions, in order, and the second is the one that actually decides it:
 *
 *   Q1  Is there a usable public cadastral service for the county?
 *   Q2  Is the field it exposes in the SAME identifier namespace as `parcelNodeId`?
 *
 * `parcelNodeId` is `{county_fips}:{parcelKey}` (plan-county-parcel-nodes.ts), so for a
 * prop_id-keyed county the node id IS the txgio `prop_id`. A service that answers in the ACCOUNT
 * namespace instead would corroborate every account-keyed row and deny every map-keyed row — it
 * would INVERT the answer, and do so confidently. That is not hypothetical here: Williamson's CAD
 * registry row names `PropertyID` (the account) while the parcel-map id is `QuickRefID`
 * (`QuickRefID='R000009'` -> 1, `PropertyID='R000009'` -> 0). Registering the documented field
 * would have reported every real Williamson parcel as missing.
 *
 * So each entry below carries the field's namespace evidence, and the namespace was verified
 * against REAL node ids from the atoms store plus a FABRICATED control id before registration —
 * see the `p275-namespace-probe` artifact. `country-parcel-id-currency.test.mjs` reproduces the
 * Williamson inversion against a fake layer so the trap stays visible in CI.
 *
 * A county with no usable public service registers NOTHING and says so (McLennan). That is an
 * answer the dispatch asks for, not an omission: the review then reports that county's candidates
 * as UNMEASURED with the reason, never as absent.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PIECES
 * ---------------------------------------------------------------------------------------------
 *
 * Every entry maps an id list to `Map<token, { reading: "live" | "absent" | "unmeasured", reason? }>`
 * and carries `.requests` (a count, read not assumed) once it has run. Throw `LIVE_CURRENCY_UNREACHABLE`
 * from `makeArcgisIdCurrencySource` and the CLI marks EVERY candidate of that county unmeasured.
 */

import { makeArcgisIdCurrencySource } from "./county-parcel-id-currency.mjs";
import { parcelCurrencyFromBcadMap, bulkLoadBcadRingsByPropId } from "./bastrop-batch-bulk-prefetch.mjs";

/** Why a county has no source, when it has none. Anything here means "report UNMEASURED". */
export const NO_SOURCE_REASONS = {
  "48309":
    "no usable public county-wide cadastral service found. Searched: the ArcGIS Online catalog " +
    "for county-wide parcels (only city-scale layers exist -- City of Robinson parcels, and City " +
    "of Waco's McLennan_County_Map which carries voting precincts and commissioner districts and " +
    "no parcel layer); the TrueAutomation MapSearch org that hosts many Texas CADs (no McLennan " +
    "service in its 84-service list). gis.mclennancounty.net / .org and maps.mclennancounty.net " +
    "do not resolve from this host; gis.wacotx.gov answers 404 at the REST root.",
};

/**
 * County FIPS -> reader. An ABSENT key (and `undefined` for 48309) means no registered source.
 *
 * @type {Record<string, ((ids: string[]) => Promise<Map<string, {reading: string, reason?: string}>>) | undefined>}
 */
export const LIVE_CURRENCY_SOURCES = {
  // ---- 48021 Bastrop. Pre-existing since P-212, deliberately UNCHANGED by P-275: the falsifier
  // "the new sources reproduce P-212's live count" needs this control to stay exactly as it was.
  // Field: prop_id. Namespace: the node ids ARE normalized BCAD prop_ids.
  // HOST NOTE (2026-09-17, measured): on this machine EVERY Node HTTPS call fails with
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE — `https://example.com/` included — because the local
  // TLS-interception root CA is in the Windows store and Node does not read it by default. That is
  // a host fact, not a county fact: BCAD answers HTTP 200 to curl.exe and to Node with
  // `--use-system-ca`. The runs recorded in the P-275 close were made with that flag; without it
  // the review reports every candidate UNMEASURED with the transport reason (which is the correct
  // behaviour for an unreachable source, and is exactly what the first run produced).
  "48021": (() => {
    let requests = 0;
    const source = async (propIds) => {
      const countingFetch = (input, init) => {
        requests += 1;
        return fetch(input, init);
      };
      const bcadByPropId = await bulkLoadBcadRingsByPropId(propIds, countingFetch);
      const out = new Map();
      for (const propId of propIds) {
        out.set(
          propId,
          parcelCurrencyFromBcadMap(propId, bcadByPropId).ok
            ? { reading: "live" }
            : { reading: "absent" },
        );
      }
      // Kept on the Map as well: callers read it either way, and the registry's contract is
      // that the COUNT is available, not where it hangs.
      out.requests = requests;
      return out;
    };
    // `.requests` is part of the registry contract, so it lives on the reader like every other
    // entry here -- the ArcGIS factory exposes it as a getter and this hand-written source used
    // to expose it only on the returned Map, so a caller following the contract read undefined
    // and a caller reading the Map read 0 for the four counties that are not Bastrop.
    Object.defineProperty(source, "requests", { get: () => requests });
    return source;
  })(),

  // ---- 48055 Caldwell. Caldwell CAD public parcel layer. Field Prop_ID = the parcel map id.
  "48055": makeArcgisIdCurrencySource({
    url: "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_County_Parcel_Map/FeatureServer/1",
    idField: "Prop_ID",
  }),

  // ---- 48209 Hays. Hays County GIS "Hays County Parcels". Field prop_id (Integer) = the parcel
  // MAP id, which is what the 2026-09-13 ruling says the Hays node id is. The CAD source registry
  // records Hays as `honest_absent` (probed 2026-08-09); that row is STALE — a public anonymous
  // service exists and answers. Reported, not edited (doc_repo's registry is planner-owned).
  "48209": makeArcgisIdCurrencySource({
    url: "https://services5.arcgis.com/bVphnK8rPe5MHUSr/arcgis/rest/services/Hays_County_Parcels/FeatureServer/0",
    idField: "prop_id",
  }),

  // ---- 48309 McLennan. NO SOURCE — see NO_SOURCE_REASONS.
  "48309": undefined,

  // ---- 48453 Travis. Travis County GIS / TCAD parcel layer. Field PROP_ID (Integer) = the parcel
  // map id (geo_id is the SECOND namespace and is deliberately not used).
  // LIMIT, and it turns out to be TOTAL for the retired population: Travis node ids are MIXED, and
  // all 40 of Travis's retired parcel-node atoms are SYNTHETIC keys
  // ("48453:_feature-stratmap25-landparcels-48453-travis-202508-<n>"). A synthetic key is a
  // within-vintage identity (invariant S1) that no external service can be asked about, so those
  // 40 report UNMEASURED by construction — correctly — and this source has no askable subject
  // among them. It still serves the ACTIVE-id namespace.
  "48453": makeArcgisIdCurrencySource({
    url: "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD/MapServer/0",
    idField: "PROP_ID",
  }),

  // ---- 48491 Williamson. "county_wcad_parcels". Field QuickRefID (String) = the parcel map id.
  // THE field that decided the design: the CAD registry names PropertyID for this county, and
  // PropertyID is the ACCOUNT. Measured: QuickRefID='R000009' (a real node id) -> 1,
  // PropertyID='R000009' -> 0, QuickRefID='R379107' (a retired serve-side id) -> 1.
  "48491": makeArcgisIdCurrencySource({
    url: "https://gis.wilco.org/arcgis/rest/services/public/county_wcad_parcels/MapServer/0",
    idField: "QuickRefID",
  }),
};

/** The reader for a county, or null. Never fabricates a source, never falls back to txgio_parcel. */
export function liveCurrencySourceFor(countyFips) {
  return LIVE_CURRENCY_SOURCES[String(countyFips)] ?? null;
}

/** Registered counties, sorted. Everything else has no source and must report UNMEASURED. */
export function registeredLiveCurrencyCounties() {
  return Object.keys(LIVE_CURRENCY_SOURCES)
    .filter((fips) => typeof LIVE_CURRENCY_SOURCES[fips] === "function")
    .sort();
}
