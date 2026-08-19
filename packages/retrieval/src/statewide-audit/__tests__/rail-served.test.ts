// LIVENESS AND NEGATIVE CONTROL for the fourteen-rail SERVED detector.
//
// The whole value of this file is that it makes a ZERO mean something. The
// widened sweep reports `no-slot-in-payload` for NINE of fourteen rails across
// roughly thirteen million parcels, and that number is only evidence if the
// detector would have fired had a slot been there. So:
//
//  1. EVERY rail's detector fires on a payload that carries its slot.
//  2. The REAL production body, captured from the deployed surface, produces
//     exactly the slot set we claim and no more — the negative control.
//  3. `mud` does NOT fire on `facets.zoning.district`, which is the false
//     positive that a lazier token list would have shipped.
//  4. An unavailable wire probe never reports on-wire-not-served, because an
//     absent probe is not an absence.

import { describe, expect, it } from "vitest";

import {
  ALL_RAIL_KEYS,
  RAIL_SLOT_TOKENS,
  bumpRailTally,
  emptyRailTally,
  keyPathsOf,
  railServedState,
  shapeSignature,
  slotMapFor,
  valuedPathsOf,
} from "../rail-served.js";
import type { RailKey } from "../types.js";

/**
 * The REAL served body for Bastrop 48021:36521, captured from
 * https://property-explorer-xi.vercel.app/api/spine/property-atoms/48021:36521/facets
 * on 2026-08-19: HTTP 200, X-Pe-Read-Path atom-chain-warm, 2045 bytes, 69 key
 * paths. Trimmed to the key STRUCTURE, which is what a slot map reads.
 */
const REAL_BODY: Record<string, unknown> = {
  parcelNodeId: "48021:36521",
  adapterKey: "node-facets:tier1",
  source: "baked-snapshot",
  snapshotAt: "2026-08-08T00:00:00.000Z",
  readPath: "atom-chain-warm",
  baseFactsMerged: true,
  facets: {
    parcelNodeId: "48021:36521",
    countyFips: "48021",
    countyName: "Bastrop",
    bakedAt: "2026-08-08T00:00:00.000Z",
    baseFacts: {
      apn: "36521",
      situsAddress: ", ,",
      situsCity: null,
      situsState: null,
      landUse: { code: "A1", description: "Residential", source: "cad-roll", vintage: "data-export-01.14.2026" },
      acreage: { value: 0.5, sqft: 21780, method: "cad" },
    },
    zoning: { district: "R-1", jurisdictionKey: "bastrop-city-tx" },
    envelope: {
      status: "ok",
      district: "R-1",
      setbacks: { front_ft: 25, side_ft: 5, rear_ft: 20 },
      buildableAreaSqFt: 12000,
      maxHeightFt: 35,
      maxImperviousPct: 45,
      minLotSize: 6000,
      approximate: false,
      provisional: false,
      disclosure: "…",
      secondSource: { source: "…", note: "…", citationUrl: "…" },
      geojson: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { kind: "buildable", depthWarm: true, recipeVersion: "1.0.0" } }] },
    },
    facetCoverage: { baseFacts: true, zoning: true, envelope: true, landUse: true, acreage: true },
    provenance: {
      parcelSource: "txgio",
      parcelVintage: "stratmap25-landparcels_48021_bastrop_202503",
      landUseSource: "cad-roll",
      landUseGateBlocked: false,
      depthWarmPromoted: true,
    },
  },
};

/** A hypothetical future payload that DOES carry every rail. */
const WIDE_BODY: Record<string, unknown> = {
  ...REAL_BODY,
  tier2: { flood: { status: "in-sfha", floodZone: "AO" } },
  attachingRoads: [{ roadNodeId: "48021:road:1", frontage: 60 }],
  facets: {
    ...(REAL_BODY.facets as Record<string, unknown>),
    footprint: { primary: { buildingArea: 1800 } },
    easement: { utilityEasement: [{ kind: "electric" }] },
    owner: { ownerName: "REDACTED" },
    wells: [{ apiNumber: "42001314840000" }],
    pipelines: [{ pipelineOperator: "X" }],
    railCorridor: { railroad: "UP" },
    specialDistrict: { mud: "Bastrop County WCID 2" },
  },
};

describe("every rail detector fires on a payload that carries its slot", () => {
  const wide = slotMapFor(WIDE_BODY);
  const valued = valuedPathsOf(WIDE_BODY);

  for (const rail of ALL_RAIL_KEYS) {
    it(`${rail} is detected as served on the wide payload`, () => {
      const paths = wide.pathsByRail[rail];
      expect(paths.length).toBeGreaterThan(0);
      const state = railServedState({
        rail,
        slotPaths: paths,
        valuedPaths: valued,
        chainEntityTypes: new Set(),
        wireProbeUnavailable: false,
      });
      expect(state).toBe("served");
    });
  }

  it("covers all fourteen rails and no more", () => {
    expect(ALL_RAIL_KEYS).toHaveLength(14);
    expect(Object.keys(RAIL_SLOT_TOKENS).sort()).toEqual([...ALL_RAIL_KEYS].sort());
  });
});

describe("negative control against the REAL production body", () => {
  const real = slotMapFor(REAL_BODY);

  it("NINE rails have NO key path in the real body — measured, and it is two more than the frozen FieldKey list implies", () => {
    // This assertion was written expecting SEVEN and the control caught the
    // error, which is the entire reason it exists. The frozen FieldKey union
    // NAMES flood and frontage, so a reader of the record would assume both are
    // served. Neither has a key path on the real wire: `tier2` is absent
    // entirely (SS-W5's F1, reproduced here structurally) and `attachingRoads`
    // is never copied by the PE adapter. Nine of fourteen rails cannot reach a
    // human through this endpoint at all.
    const slotless = ALL_RAIL_KEYS.filter((r) => real.pathsByRail[r].length === 0).sort();
    expect(slotless).toEqual([
      "easement",
      "flood",
      "footprint",
      "mud",
      "owner",
      "rail-corridor",
      "roads",
      "rrc-pipelines",
      "rrc-wells",
    ]);
  });

  it("mud does NOT false-positive on facets.zoning.district or facets.envelope.district", () => {
    const leaves = keyPathsOf(REAL_BODY).map((h) => h.path);
    expect(leaves).toContain("/facets/zoning/district");
    expect(leaves).toContain("/facets/envelope/district");
    expect(real.pathsByRail.mud).toEqual([]);
  });

  it("flood has NO slot on the real body — the tier2 key is absent from the wire", () => {
    expect(real.pathsByRail.flood).toEqual([]);
    expect(real.pathsByRail.flood.length).toBe(0);
  });

  it("exactly FIVE rails have a slot on the real body", () => {
    const withSlots = ALL_RAIL_KEYS.filter((r) => real.pathsByRail[r].length > 0).sort();
    expect(withSlots).toEqual(["cad", "envelope", "geometry", "landuse", "zoning"]);
  });

  it("geometry's only slot is the buildable-envelope polygon, never a parcel ring", () => {
    expect(real.pathsByRail.geometry).toEqual([
      "/facets/envelope/geojson",
      "/facets/envelope/geojson/features[0]/geometry",
    ]);
  });
});

describe("state precedence and the wire distinction", () => {
  const real = slotMapFor(REAL_BODY);
  const valued = valuedPathsOf(REAL_BODY);

  it("a slot that exists and carries nothing is slot-empty, never no-slot", () => {
    const state = railServedState({
      rail: "zoning",
      slotPaths: real.pathsByRail.zoning,
      valuedPaths: new Set(),
      chainEntityTypes: new Set(["zoning-fact"]),
      wireProbeUnavailable: false,
    });
    expect(state).toBe("slot-empty");
  });

  it("no slot plus the atom on the chain is on-wire-not-served, an ADAPTER fix", () => {
    const state = railServedState({
      rail: "footprint",
      slotPaths: [],
      valuedPaths: valued,
      chainEntityTypes: new Set(["building-footprint"]),
      wireProbeUnavailable: false,
    });
    expect(state).toBe("on-wire-not-served");
  });

  it("no slot and no atom is no-slot-in-payload, a NEW FIELD", () => {
    const state = railServedState({
      rail: "footprint",
      slotPaths: [],
      valuedPaths: valued,
      chainEntityTypes: new Set(),
      wireProbeUnavailable: false,
    });
    expect(state).toBe("no-slot-in-payload");
  });

  it("an UNAVAILABLE wire probe never manufactures on-wire-not-served", () => {
    const state = railServedState({
      rail: "footprint",
      slotPaths: [],
      valuedPaths: valued,
      chainEntityTypes: new Set(["building-footprint"]),
      wireProbeUnavailable: true,
    });
    expect(state).toBe("no-slot-in-payload");
  });

  it("divergence: adding a value to the slot flips slot-empty to served", () => {
    const before = railServedState({
      rail: "zoning",
      slotPaths: real.pathsByRail.zoning,
      valuedPaths: new Set(),
      chainEntityTypes: new Set(),
      wireProbeUnavailable: false,
    });
    const after = railServedState({
      rail: "zoning",
      slotPaths: real.pathsByRail.zoning,
      valuedPaths: new Set(real.pathsByRail.zoning),
      chainEntityTypes: new Set(),
      wireProbeUnavailable: false,
    });
    expect(before).toBe("slot-empty");
    expect(after).toBe("served");
  });
});

describe("shape memoisation is safe", () => {
  it("two bodies with the same structure share a signature", () => {
    const a = JSON.parse(JSON.stringify(REAL_BODY));
    const b = JSON.parse(JSON.stringify(REAL_BODY));
    (b.facets as Record<string, unknown>).parcelNodeId = "48021:99999";
    (b.facets as Record<string, Record<string, unknown>>).zoning!.district = "C-1";
    expect(shapeSignature(a)).toBe(shapeSignature(b));
  });

  it("a body that GAINS a facet key gets a different signature, so a new slot is never memoised away", () => {
    const a = JSON.parse(JSON.stringify(REAL_BODY));
    const b = JSON.parse(JSON.stringify(REAL_BODY));
    (b.facets as Record<string, unknown>).footprint = { primary: { buildingArea: 1 } };
    expect(shapeSignature(a)).not.toBe(shapeSignature(b));
  });

  it("a body that GAINS tier2 gets a different signature", () => {
    const a = JSON.parse(JSON.stringify(REAL_BODY));
    const b = JSON.parse(JSON.stringify(REAL_BODY));
    b.tier2 = { flood: { floodZone: "AE" } };
    expect(shapeSignature(a)).not.toBe(shapeSignature(b));
  });
});

describe("tally", () => {
  it("bumps exactly one bucket per parcel", () => {
    const t = emptyRailTally();
    bumpRailTally(t, "served");
    bumpRailTally(t, "slot-empty");
    bumpRailTally(t, "on-wire-not-served");
    bumpRailTally(t, "no-slot-in-payload");
    expect(t).toEqual({ served: 1, slotEmpty: 1, onWireNotServed: 1, noSlotInPayload: 1 });
  });
});
