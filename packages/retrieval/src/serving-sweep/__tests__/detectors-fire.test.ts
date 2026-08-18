/**
 * EVERY DETECTOR IS PROVEN ABLE TO FIRE BEFORE ANY OF ITS ZEROS ARE BELIEVED.
 *
 * DEV_PROCESS 2.2: a gating indicator is tested for its ability to FIRE before
 * it is trusted. The Bastrop sweep returned 0 for two of the five contradiction
 * kinds, and a zero from a detector that CANNOT fire is not a clean bill of
 * health, it is a dead gate. Each test below hands `projectSheet` a payload
 * that must trip exactly one detector, and asserts it trips.
 *
 * It also proves the geojson stand-in substitution changes no served decision,
 * which is the deviation the sweep relies on to avoid pulling megabytes of
 * coordinates per parcel out of Postgres.
 */
import { describe, expect, it } from "vitest";
import { projectSheet } from "../project-sheet.js";
import { deriveBakedCardModel } from "../vendor/baked-facets.js";
import type { BakedFacetPayload } from "../vendor/baked-facets.js";

function servedBody(facets: Record<string, unknown>, tier2: unknown = undefined) {
  return {
    parcelNodeId: "48021:9001",
    facets: { parcelNodeId: "48021:9001", countyFips: "48021", countyName: "Bastrop", ...facets },
    ...(tier2 !== undefined ? { tier2 } : {}),
  } as Record<string, unknown>;
}

function inputs(over: Partial<Parameters<typeof projectSheet>[0]> = {}) {
  return {
    parcelNodeId: "48021:9001",
    servedBody: servedBody({}),
    storeTier2Flood: null,
    floodHazardFact: null,
    cadRoll: null,
    centroid: null,
    ...over,
  };
}

describe("contradiction detectors can fire", () => {
  it("envelope-not-derived-but-area-shown fires when an area rides a non-derived envelope", () => {
    const obs = projectSheet(
      inputs({
        servedBody: servedBody({
          zoning: { district: "GC" },
          envelope: {
            status: "declined",
            declineReason: "setback-rule-pending",
            buildableAreaSqFt: 6325,
            geojson: { type: "FeatureCollection", features: [{ type: "Feature" }] },
          },
          facetCoverage: { zoning: true, envelope: false },
        }),
      }),
    );
    expect(obs.contradictions).toContain("envelope-not-derived-but-area-shown");
  });

  it("setbacks-present-card-absent-brief fires when the wire carries setbacks the coverage gate hides", () => {
    // brief-view-model.ts:365 reads env.setbacks with no coverage check;
    // compare-facts.ts:269 reads the coverage-gated card facet. One payload,
    // two answers.
    const facets = {
      zoning: { district: "GC" },
      envelope: {
        status: "declined",
        declineReason: "warm-verify-decline",
        setbacks: { front_ft: 20, side_ft: 5, rear_ft: 20 },
      },
      facetCoverage: { zoning: true, envelope: false },
    };
    expect(deriveBakedCardModel(facets as BakedFacetPayload).setbacks.state).not.toBe("present");
    const obs = projectSheet(inputs({ servedBody: servedBody(facets) }));
    expect(obs.contradictions).toContain("setbacks-present-card-absent-brief");
  });

  it("flood-zone-disagreement fires only when BOTH paths name a zone and they differ", () => {
    const differ = projectSheet(
      inputs({
        storeTier2Flood: { status: "in-sfha", floodZone: "AO" },
        floodHazardFact: { floodZone: "AE" },
      }),
    );
    expect(differ.contradictions).toContain("flood-zone-disagreement");
    expect(differ.floodZoneCount).toBe(2);

    const agree = projectSheet(
      inputs({
        storeTier2Flood: { status: "in-sfha", floodZone: "AE" },
        floodHazardFact: { floodZone: "ae" },
      }),
    );
    expect(agree.contradictions).not.toContain("flood-zone-disagreement");

    // An absent second opinion is NOT a disagreement (DEV_PROCESS 4.3).
    const oneSided = projectSheet(
      inputs({ storeTier2Flood: { status: "in-sfha", floodZone: "AO" }, floodHazardFact: null }),
    );
    expect(oneSided.contradictions).not.toContain("flood-zone-disagreement");
  });

  it("field-unavailable-but-present-upstream fires when the store has flood and the wire does not", () => {
    const obs = projectSheet(
      inputs({ storeTier2Flood: { status: "in-sfha", floodZone: "AO" } }),
    );
    expect(obs.contradictions).toContain("field-unavailable-but-present-upstream");
    expect(obs.fields.flood.reason).toBe("tier2-dropped-by-bff-merge");

    // and it does NOT fire when the overlay actually reaches the wire
    const served = projectSheet(
      inputs({
        servedBody: servedBody({}, { flood: { status: "in-sfha", floodZone: "AO" } }),
        storeTier2Flood: { status: "in-sfha", floodZone: "AO" },
      }),
    );
    expect(served.fields.flood.state).toBe("present");
    expect(served.contradictions).not.toContain("field-unavailable-but-present-upstream");
  });

  it("address-absent-but-on-cad-roll fires for the punctuation sentinel", () => {
    const obs = projectSheet(
      inputs({
        servedBody: servedBody({ baseFacts: { apn: "36521", situsAddress: ", ," } }),
        cadRoll: { situsAddress: "1503 FARM ST" },
      }),
    );
    expect(obs.contradictions).toContain("address-absent-but-on-cad-roll");
    expect(obs.fields.situsAddress.state).toBe("absentCovered");
    expect(obs.fields.situsAddress.reason).toBe("served-punctuation-sentinel");
    // The card's own verdict is the opposite, and that gap IS the finding.
    expect(obs.servedCardCallsSitusPresent).toBe(true);
  });

  it("the Travis-shaped stub is NOT an address either", () => {
    // `", TX 78660"` passes an alphanumeric test and carries no street. The
    // instrument's first predicate counted it as an address; this asserts the
    // corrected rule rejects it, in both directions.
    const obs = projectSheet(
      inputs({
        servedBody: servedBody({ baseFacts: { apn: "280168", situsAddress: ", TX 78660" } }),
        cadRoll: null,
      }),
    );
    expect(obs.fields.situsAddress.state).toBe("absentCovered");
    expect(obs.fields.situsAddress.reason).toBe("served-no-street-segment");
    expect(obs.servedCardCallsSitusPresent).toBe(true);

    const real = projectSheet(
      inputs({
        servedBody: servedBody({
          baseFacts: { apn: "280168", situsAddress: "17002 SIMSBROOK DR , TX 78660" },
        }),
      }),
    );
    expect(real.fields.situsAddress.state).toBe("present");
  });

  it("a legible address is present, and no contradiction is invented", () => {
    const obs = projectSheet(
      inputs({
        servedBody: servedBody({ baseFacts: { apn: "36521", situsAddress: "1503 FARM ST" } }),
        cadRoll: { situsAddress: "1503 FARM ST" },
      }),
    );
    expect(obs.fields.situsAddress.state).toBe("present");
    expect(obs.contradictions).not.toContain("address-absent-but-on-cad-roll");
  });
});

describe("geojson stand-in changes no served decision", () => {
  const withReal = {
    zoning: { district: "GC" },
    envelope: {
      status: "ok" as const,
      district: "GC",
      setbacks: { front_ft: 20, side_ft: 5, rear_ft: 20 },
      buildableAreaSqFt: 6325,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-97.3087, 30.1127],
                  [-97.3087, 30.1125],
                  [-97.3085, 30.1125],
                  [-97.3087, 30.1127],
                ],
              ],
            },
          },
        ],
      },
    },
    facetCoverage: { zoning: true, envelope: true },
  };
  const withStandIn = {
    ...withReal,
    envelope: {
      ...withReal.envelope,
      geojson: { type: "FeatureCollection", features: [{ type: "Feature" }] },
    },
  };

  it("produces an identical card model", () => {
    expect(deriveBakedCardModel(withStandIn as BakedFacetPayload)).toEqual(
      deriveBakedCardModel(withReal as BakedFacetPayload),
    );
  });

  it("produces identical field states and contradictions", () => {
    const a = projectSheet(inputs({ servedBody: servedBody(withReal) }));
    const b = projectSheet(inputs({ servedBody: servedBody(withStandIn) }));
    expect(b.fields).toEqual(a.fields);
    expect(b.contradictions).toEqual(a.contradictions);
  });

  it("distinguishes an ABSENT geojson key from a JSON-null one", () => {
    const nulled = { ...withReal, envelope: { ...withReal.envelope, geojson: null } };
    const absent = { ...withReal, envelope: { ...withReal.envelope } };
    delete (absent.envelope as { geojson?: unknown }).geojson;
    expect(deriveBakedCardModel(nulled as BakedFacetPayload).buildableDisplayKind).not.toBe(
      undefined,
    );
    expect(projectSheet(inputs({ servedBody: servedBody(nulled) })).fields.geometry.state).toBe(
      "absentUncovered",
    );
    expect(projectSheet(inputs({ servedBody: servedBody(absent) })).fields.geometry.state).toBe(
      "absentUncovered",
    );
  });
});
