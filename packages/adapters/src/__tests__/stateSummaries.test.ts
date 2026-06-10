/**
 * Unit tests for the state-tier payload summary chips rendered in
 * the Site Context tab. Mirrors the structure of
 * `federalSummaries.test.ts`: each formatter has a describe block
 * covering the happy path and the graceful-degradation paths, then a
 * small registry block exercises the `summarizeStatePayload`
 * dispatcher.
 */

import { describe, expect, it } from "vitest";
import {
  diffStatePayload,
  summarizeAddressPointPayload,
  summarizeEdwardsAquiferPayload,
  summarizeElevationContoursPayload,
  summarizeParcelPayload,
  summarizeStatePayload,
} from "../state/summaries";

describe("summarizeElevationContoursPayload", () => {
  it("singularizes for one contour", () => {
    expect(
      summarizeElevationContoursPayload({
        kind: "elevation-contours",
        featureCount: 1,
        features: [],
      }),
    ).toBe("1 elevation contour nearby");
  });

  it("pluralizes for many contours", () => {
    expect(
      summarizeElevationContoursPayload({
        kind: "elevation-contours",
        featureCount: 8,
        features: [],
      }),
    ).toBe("8 elevation contours nearby");
  });

  it("falls back to the array length when featureCount is missing", () => {
    expect(
      summarizeElevationContoursPayload({
        kind: "elevation-contours",
        features: [{}, {}, {}],
      }),
    ).toBe("3 elevation contours nearby");
  });

  it("emits the empty-state chip when there are no contours nearby", () => {
    expect(
      summarizeElevationContoursPayload({
        kind: "elevation-contours",
        featureCount: 0,
        features: [],
      }),
    ).toBe("No elevation contours nearby");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeElevationContoursPayload({ kind: "parcel" }),
    ).toBeNull();
    expect(summarizeElevationContoursPayload(null)).toBeNull();
    expect(summarizeElevationContoursPayload("not an object")).toBeNull();
  });
});

describe("summarizeParcelPayload", () => {
  it("includes the parcel id and acres when both are present", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: {
          attributes: { PARCEL_ID: "01-12345", ACRES: 0.42 },
        },
      }),
    ).toBe("Parcel 01-12345 · 0.42 ac");
  });

  it("renders the id alone when acres are missing", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "PIN-99" } },
      }),
    ).toBe("Parcel PIN-99");
  });

  it("renders acres alone when the id column is missing", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: { ACRES: 12.34 } },
      }),
    ).toBe("Parcel · 12.34 ac");
  });

  it("falls back to a generic chip when attributes are empty", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: {} },
      }),
    ).toBe("Parcel polygon present");
  });

  it("emits a public-land chip when the adapter persisted a null parcel (UGRC public-land row)", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: null,
        note: "no-parcel-at-point",
      }),
    ).toBe("No parcel at this point (public land)");
  });

  it("trims trailing zeros when formatting fractional acres", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "A", ACRES: 0.4 } },
      }),
    ).toBe("Parcel A · 0.4 ac");
  });

  it("uses one-decimal rounding for very large parcels", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "X", ACRES: 1234.56 } },
      }),
    ).toBe("Parcel X · 1234.6 ac");
  });

  it("accepts alternate parcel-id and acres column names", () => {
    expect(
      summarizeParcelPayload({
        kind: "parcel",
        parcel: { attributes: { APN: "X-1", GIS_ACRES: 5 } },
      }),
    ).toBe("Parcel X-1 · 5 ac");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(summarizeParcelPayload({ kind: "zoning" })).toBeNull();
    expect(summarizeParcelPayload(undefined)).toBeNull();
  });
});

describe("summarizeAddressPointPayload", () => {
  it("uses the canonical FullAdd column when present", () => {
    expect(
      summarizeAddressPointPayload({
        kind: "address-point",
        feature: { attributes: { FullAdd: "100 Main St" } },
      }),
    ).toBe("Address: 100 Main St");
  });

  it("reconstructs from number + street when no full-address column is present", () => {
    expect(
      summarizeAddressPointPayload({
        kind: "address-point",
        feature: {
          attributes: { AddNum: "100", StreetName: "Main St" },
        },
      }),
    ).toBe("Address: 100 Main St");
  });

  it("falls back to a generic chip when no recognizable address columns are present", () => {
    expect(
      summarizeAddressPointPayload({
        kind: "address-point",
        feature: { attributes: { OBJECTID: 1 } },
      }),
    ).toBe("Address point present");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeAddressPointPayload({ kind: "elevation-contours" }),
    ).toBeNull();
  });
});

describe("summarizeEdwardsAquiferPayload", () => {
  it("calls out a recharge-only parcel (recharge has the strictest rules)", () => {
    expect(
      summarizeEdwardsAquiferPayload({
        kind: "edwards-aquifer",
        inRecharge: true,
        inContributing: false,
      }),
    ).toBe("In Edwards Aquifer recharge zone");
  });

  it("calls out a contributing-only parcel (Bastrop's typical case)", () => {
    expect(
      summarizeEdwardsAquiferPayload({
        kind: "edwards-aquifer",
        inRecharge: false,
        inContributing: true,
      }),
    ).toBe("In Edwards Aquifer contributing zone");
  });

  it("combines both zones when the parcel intersects both polygons", () => {
    expect(
      summarizeEdwardsAquiferPayload({
        kind: "edwards-aquifer",
        inRecharge: true,
        inContributing: true,
      }),
    ).toBe("In Edwards Aquifer recharge & contributing zones");
  });

  it("emits an outside chip when neither zone is intersected", () => {
    expect(
      summarizeEdwardsAquiferPayload({
        kind: "edwards-aquifer",
        inRecharge: false,
        inContributing: false,
      }),
    ).toBe("Outside Edwards Aquifer zones");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(summarizeEdwardsAquiferPayload({ kind: "parcel" })).toBeNull();
  });
});

describe("summarizeStatePayload (registry)", () => {
  it("routes by layerKind to the correct formatter", () => {
    expect(
      summarizeStatePayload("ugrc-dem", {
        kind: "elevation-contours",
        featureCount: 2,
        features: [],
      }),
    ).toBe("2 elevation contours nearby");
    expect(
      summarizeStatePayload("inside-idaho-dem", {
        kind: "elevation-contours",
        featureCount: 0,
        features: [],
      }),
    ).toBe("No elevation contours nearby");
    expect(
      summarizeStatePayload("ugrc-parcels", {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "U-1" } },
      }),
    ).toBe("Parcel U-1");
    expect(
      summarizeStatePayload("inside-idaho-parcels", {
        kind: "parcel",
        parcel: { attributes: { APN: "I-1", ACRES: 2 } },
      }),
    ).toBe("Parcel I-1 · 2 ac");
    expect(
      summarizeStatePayload("ugrc-address-points", {
        kind: "address-point",
        feature: { attributes: { FullAdd: "200 Oak Ave" } },
      }),
    ).toBe("Address: 200 Oak Ave");
    expect(
      summarizeStatePayload("tceq-edwards-aquifer", {
        kind: "edwards-aquifer",
        inRecharge: false,
        inContributing: true,
      }),
    ).toBe("In Edwards Aquifer contributing zone");
  });

  it("returns null for unknown layer kinds (federal/local rows fall through)", () => {
    expect(
      summarizeStatePayload("fema-nfhl-flood-zone", {
        kind: "flood-zone",
      }),
    ).toBeNull();
    expect(
      summarizeStatePayload("grand-county-ut-zoning", {
        kind: "zoning",
      }),
    ).toBeNull();
  });
});

describe("diffStatePayload", () => {
  it("returns one entry per moved key for an elevation-contours rerun", () => {
    const changes = diffStatePayload(
      "ugrc-dem",
      { kind: "elevation-contours", featureCount: 3, features: [] },
      { kind: "elevation-contours", featureCount: 5, features: [] },
    );
    expect(changes).toEqual([
      {
        key: "featureCount",
        label: "Contours nearby",
        before: "3",
        after: "5",
      },
    ]);
  });

  it("falls back to the array length when featureCount is missing (mirrors the chip)", () => {
    const changes = diffStatePayload(
      "inside-idaho-dem",
      { kind: "elevation-contours", features: [{}, {}] },
      { kind: "elevation-contours", features: [{}, {}, {}, {}] },
    );
    expect(changes).toEqual([
      {
        key: "featureCount",
        label: "Contours nearby",
        before: "2",
        after: "4",
      },
    ]);
  });

  it("surfaces parcelPresent flipping to public-land + drops Parcel ID/Acres rows", () => {
    // A rerun that lost the parcel polygon (e.g. UGRC dropped the
    // sliver between two adjoining lots) should call out the
    // presence move plus the now-missing id/acres rather than
    // silently emitting "(none)" without context.
    const changes = diffStatePayload(
      "ugrc-parcels",
      {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "01-12345", ACRES: 0.42 } },
      },
      { kind: "parcel", parcel: null, note: "no-parcel-at-point" },
    );
    expect(changes).toEqual([
      {
        key: "parcelPresent",
        label: "Parcel polygon",
        before: "Present",
        after: "None (public land)",
      },
      {
        key: "parcelId",
        label: "Parcel ID",
        before: "01-12345",
        after: "(none)",
      },
      {
        key: "parcelAcres",
        label: "Acres",
        before: "0.42 ac",
        after: "(none)",
      },
    ]);
  });

  it("formats the acres delta with the same units as the inline summary chip", () => {
    const changes = diffStatePayload(
      "inside-idaho-parcels",
      { kind: "parcel", parcel: { attributes: { APN: "I-1", ACRES: 0.42 } } },
      { kind: "parcel", parcel: { attributes: { APN: "I-1", ACRES: 1.5 } } },
    );
    expect(changes).toEqual([
      {
        key: "parcelAcres",
        label: "Acres",
        before: "0.42 ac",
        after: "1.5 ac",
      },
    ]);
  });

  it("surfaces an address change for a UGRC address-point rerun", () => {
    const changes = diffStatePayload(
      "ugrc-address-points",
      {
        kind: "address-point",
        feature: { attributes: { FullAdd: "100 Main St" } },
      },
      {
        kind: "address-point",
        feature: { attributes: { FullAdd: "102 Main St" } },
      },
    );
    expect(changes).toEqual([
      {
        key: "address",
        label: "Address",
        before: "100 Main St",
        after: "102 Main St",
      },
    ]);
  });

  it("emits Yes/No deltas for the Edwards Aquifer recharge + contributing flags", () => {
    const changes = diffStatePayload(
      "tceq-edwards-aquifer",
      {
        kind: "edwards-aquifer",
        inRecharge: true,
        inContributing: false,
      },
      {
        kind: "edwards-aquifer",
        inRecharge: false,
        inContributing: true,
      },
    );
    expect(changes).toEqual([
      {
        key: "inRecharge",
        label: "Recharge zone",
        before: "Yes",
        after: "No",
      },
      {
        key: "inContributing",
        label: "Contributing zone",
        before: "No",
        after: "Yes",
      },
    ]);
  });

  it("returns an empty array when every key formats identically (true no-op rerun)", () => {
    const payload = {
      kind: "parcel",
      parcel: { attributes: { PARCEL_ID: "01-12345", ACRES: 0.42 } },
    };
    expect(
      diffStatePayload("ugrc-parcels", payload, { ...payload }),
    ).toEqual([]);
  });

  it("returns null when the payload kinds differ between reruns", () => {
    expect(
      diffStatePayload(
        "ugrc-parcels",
        { kind: "parcel", parcel: null },
        { kind: "elevation-contours", featureCount: 1, features: [{}] },
      ),
    ).toBeNull();
  });

  it("returns null when either payload is malformed", () => {
    expect(
      diffStatePayload(
        "ugrc-parcels",
        null,
        { kind: "parcel", parcel: null },
      ),
    ).toBeNull();
    expect(
      diffStatePayload(
        "ugrc-parcels",
        { parcel: null },
        { kind: "parcel", parcel: null },
      ),
    ).toBeNull();
  });

  it("returns null for non-state layer kinds (federal/local rows are skipped)", () => {
    expect(
      diffStatePayload(
        "fema-nfhl-flood-zone",
        { kind: "flood-zone", floodZone: "AE" },
        { kind: "flood-zone", floodZone: "X" },
      ),
    ).toBeNull();
    expect(
      diffStatePayload(
        "grand-county-ut-zoning",
        { kind: "zoning", zoning: { attributes: { ZONE_CODE: "R-1" } } },
        { kind: "zoning", zoning: { attributes: { ZONE_CODE: "R-2" } } },
      ),
    ).toBeNull();
  });
});
