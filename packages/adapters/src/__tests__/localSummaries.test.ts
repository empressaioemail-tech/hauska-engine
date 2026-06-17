/**
 * Unit tests for the local-tier payload summary chips rendered in
 * the Site Context tab. Mirrors the structure of
 * `federalSummaries.test.ts` and `stateSummaries.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  diffLocalPayload,
  summarizeFloodplainPayload,
  summarizeLocalPayload,
  summarizeRoadsPayload,
  summarizeZoningPayload,
} from "../local/summaries";

describe("summarizeZoningPayload", () => {
  it("includes the zoning code and human-readable description when both are present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "R-1", ZONE_DESC: "Single-Family Residential" },
        },
      }),
    ).toBe("Zoning R-1 · Single-Family Residential");
  });

  it("emits the code alone when no description column is present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { ZONE_CODE: "C-2" } },
      }),
    ).toBe("Zoning C-2");
  });

  it("falls back to the description alone when no code column is present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { DESCRIPTION: "Mixed Use Overlay" } },
      }),
    ).toBe("Zoning: Mixed Use Overlay");
  });

  it("falls back to a generic chip when attributes are empty", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: {} },
      }),
    ).toBe("Zoning polygon present");
  });

  it("accepts the alternate ZONING column name", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { ZONING: "A-1" } },
      }),
    ).toBe("Zoning A-1");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(summarizeZoningPayload({ kind: "parcel" })).toBeNull();
    expect(summarizeZoningPayload(null)).toBeNull();
  });
});

describe("summarizeRoadsPayload", () => {
  it("attributes a county-GIS reading explicitly", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [{}, {}, {}],
      }),
    ).toBe("3 road segments (county GIS)");
  });

  it("singularizes for one feature", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [{}],
      }),
    ).toBe("1 road segment (county GIS)");
  });

  it("attributes the OSM fallback path and surfaces the search radius", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "osm",
        radiusMeters: 100,
        elements: [{}, {}],
      }),
    ).toBe("2 road segments within 100m (OSM)");
  });

  it("emits the empty-state chip when no roads were found", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [],
      }),
    ).toBe("No roads recorded near this point");
  });

  it("degrades gracefully when source attribution is missing", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        features: [{}],
      }),
    ).toBe("1 road segment");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeRoadsPayload({ kind: "floodplain" }),
    ).toBeNull();
  });
});

describe("summarizeFloodplainPayload", () => {
  it("surfaces the FEMA-derived FLD_ZONE when the parcel is in the floodplain", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "AE" } }],
      }),
    ).toBe("In mapped floodplain (Zone AE)");
  });

  it("falls back to the no-zone chip when in floodplain but no FLD_ZONE attribute is present", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: {} }],
      }),
    ).toBe("In mapped floodplain");
  });

  it("emits the outside chip when the parcel is not in a mapped floodplain", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: false,
        features: [],
      }),
    ).toBe("Outside mapped floodplain");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeFloodplainPayload({ kind: "zoning" }),
    ).toBeNull();
  });
});

describe("summarizeLocalPayload (registry)", () => {
  it("routes by layerKind to the correct formatter", () => {
    expect(
      summarizeLocalPayload("grand-county-ut-parcels", {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "G-1", ACRES: 0.5 } },
      }),
    ).toBe("Parcel G-1 · 0.5 ac");
    expect(
      summarizeLocalPayload("lemhi-county-id-zoning", {
        kind: "zoning",
        zoning: { attributes: { ZONE_CODE: "AG-1" } },
      }),
    ).toBe("Zoning AG-1");
    expect(
      summarizeLocalPayload("bastrop-tx-zoning", {
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "MF-2", ZONE_DESC: "Multi-Family" },
        },
      }),
    ).toBe("Zoning MF-2 · Multi-Family");
    expect(
      summarizeLocalPayload("grand-county-ut-roads", {
        kind: "roads",
        source: "osm",
        radiusMeters: 100,
        elements: [{}],
      }),
    ).toBe("1 road segment within 100m (OSM)");
    expect(
      summarizeLocalPayload("lemhi-county-id-roads", {
        kind: "roads",
        source: "county-gis",
        features: [{}, {}],
      }),
    ).toBe("2 road segments (county GIS)");
    expect(
      summarizeLocalPayload("bastrop-tx-floodplain", {
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "X" } }],
      }),
    ).toBe("In mapped floodplain (Zone X)");
  });

  it("returns null for unknown layer kinds (federal/state rows fall through)", () => {
    expect(
      summarizeLocalPayload("fema-nfhl-flood-zone", {
        kind: "flood-zone",
      }),
    ).toBeNull();
    expect(
      summarizeLocalPayload("ugrc-parcels", {
        kind: "parcel",
        parcel: null,
      }),
    ).toBeNull();
  });
});

describe("diffLocalPayload", () => {
  it("emits zoning code + district deltas for a county zoning rerun", () => {
    const changes = diffLocalPayload(
      "grand-county-ut-zoning",
      {
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "R-1", ZONE_DESC: "Single-Family Residential" },
        },
      },
      {
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "R-2", ZONE_DESC: "Two-Family Residential" },
        },
      },
    );
    expect(changes).toEqual([
      {
        key: "zoningCode",
        label: "Zoning code",
        before: "R-1",
        after: "R-2",
      },
      {
        key: "zoningDescription",
        label: "District",
        before: "Single-Family Residential",
        after: "Two-Family Residential",
      },
    ]);
  });

  it("calls out a roads source flip from county GIS to OSM with a normalized label", () => {
    const changes = diffLocalPayload(
      "grand-county-ut-roads",
      { kind: "roads", source: "county-gis", features: [{}, {}, {}] },
      {
        kind: "roads",
        source: "osm",
        radiusMeters: 100,
        elements: [{}, {}],
      },
    );
    expect(changes).toEqual([
      {
        key: "roadCount",
        label: "Road segments",
        before: "3",
        after: "2",
      },
      {
        key: "source",
        label: "Source",
        before: "County GIS",
        after: "OpenStreetMap",
      },
    ]);
  });

  it("reuses the shared parcel field config for the county parcel layers", () => {
    const changes = diffLocalPayload(
      "bastrop-tx-parcels",
      {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "B-1", ACRES: 5 } },
      },
      {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "B-1", ACRES: 7.5 } },
      },
    );
    expect(changes).toEqual([
      {
        key: "parcelAcres",
        label: "Acres",
        before: "5 ac",
        after: "7.5 ac",
      },
    ]);
  });

  it("surfaces a Bastrop floodplain rerun moving into a mapped FEMA zone", () => {
    const changes = diffLocalPayload(
      "bastrop-tx-floodplain",
      {
        kind: "floodplain",
        inMappedFloodplain: false,
        features: [],
      },
      {
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "AE" } }],
      },
    );
    expect(changes).toEqual([
      {
        key: "inMappedFloodplain",
        label: "In floodplain",
        before: "No",
        after: "Yes",
      },
      {
        key: "floodZone",
        label: "Flood zone",
        before: "(none)",
        after: "AE",
      },
    ]);
  });

  it("returns an empty array when every key formats identically (true no-op rerun)", () => {
    const payload = {
      kind: "zoning",
      zoning: { attributes: { ZONE_CODE: "R-1", ZONE_DESC: "Residential" } },
    };
    expect(
      diffLocalPayload("grand-county-ut-zoning", payload, { ...payload }),
    ).toEqual([]);
  });

  it("returns null when the payload kinds differ between reruns", () => {
    expect(
      diffLocalPayload(
        "bastrop-tx-floodplain",
        { kind: "floodplain", inMappedFloodplain: false, features: [] },
        { kind: "zoning", zoning: { attributes: {} } },
      ),
    ).toBeNull();
  });

  it("returns null when either payload is malformed", () => {
    expect(
      diffLocalPayload(
        "grand-county-ut-zoning",
        null,
        { kind: "zoning", zoning: { attributes: {} } },
      ),
    ).toBeNull();
    expect(
      diffLocalPayload(
        "grand-county-ut-zoning",
        { zoning: null },
        { kind: "zoning", zoning: null },
      ),
    ).toBeNull();
  });

  it("returns null for non-local layer kinds (federal/state rows are skipped)", () => {
    expect(
      diffLocalPayload(
        "fema-nfhl-flood-zone",
        { kind: "flood-zone", floodZone: "AE" },
        { kind: "flood-zone", floodZone: "X" },
      ),
    ).toBeNull();
    expect(
      diffLocalPayload(
        "ugrc-parcels",
        { kind: "parcel", parcel: null },
        { kind: "parcel", parcel: { attributes: {} } },
      ),
    ).toBeNull();
  });
});
