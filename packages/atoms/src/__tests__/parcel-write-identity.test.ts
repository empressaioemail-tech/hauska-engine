/**
 * P-55 / WDLL 11 — Wave C new-write identity.
 *
 * A write that skips assertCanonicalParcelEntityId still mints the old
 * shape. Bypass named: COPY / raw SQL INSERT INTO atoms.
 */
import { describe, expect, it } from "vitest";

import {
  appliesToLinkFromPropertyAtom,
  assertCanonicalParcelEntityId,
  buildingFootprintAbsenceEntityId,
  buildingFootprintPresentEntityId,
  mintOldShapeIfHelperSkipped,
  mintParcelFactIdentity,
  ParcelEntityIdRejectedError,
  resolveCanonicalParcelKey,
  specialDistrictAbsenceEntityId,
  specialDistrictPresentEntityId,
} from "../parcel-write-identity.js";

describe("assertCanonicalParcelEntityId (WDLL 11 C1/C2)", () => {
  it("rejects decimal-padded parcel entity_id", () => {
    expect(() => assertCanonicalParcelEntityId("48021:27303.00000000")).toThrow(
      ParcelEntityIdRejectedError,
    );
  });

  it("rejects :outside and :primary tokens", () => {
    expect(() =>
      assertCanonicalParcelEntityId("48021:27303:sd:outside"),
    ).toThrow(/sentinel token 'outside'/);
    expect(() =>
      assertCanonicalParcelEntityId("48021:27303:footprint:primary"),
    ).toThrow(/sentinel token 'primary'/);
  });

  it("accepts integer grammar, district suffix, footprint none, and county coverage", () => {
    expect(() => assertCanonicalParcelEntityId("48021:27303")).not.toThrow();
    expect(() => assertCanonicalParcelEntityId("48201:12345:sd:999")).not.toThrow();
    expect(() =>
      assertCanonicalParcelEntityId("48021:27303:footprint:none"),
    ).not.toThrow();
    expect(() =>
      assertCanonicalParcelEntityId("48021:_county_coverage"),
    ).not.toThrow();
  });
});

describe("resolveCanonicalParcelKey (WDLL 11 C1/C3)", () => {
  it("strips StratMap pad and records the padded source in externalKeys", () => {
    const id = resolveCanonicalParcelKey("48021:27303.00000000");
    expect(id.parcelNodeId).toBe("48021:27303");
    expect(id.entityId).toBe("48021:27303");
    expect(id.paddedSource).toBe(true);
    expect(id.externalKeys[0]?.keyValue).toBe("48021:27303.00000000");
    expect(id.externalKeys[0]?.keyKind).toBe("prop_id");
  });

  it("records the received integer key so C3 cannot drop source keys", () => {
    const id = resolveCanonicalParcelKey("48021:27303");
    expect(id.entityId).toBe("48021:27303");
    expect(id.externalKeys[0]?.keyValue).toBe("48021:27303");
    expect(id.paddedSource).toBe(false);
  });
});

describe("family entity_id mint (WDLL 11 C2)", () => {
  it("SD present keeps district id; SD absence is :sd not :outside", () => {
    expect(specialDistrictPresentEntityId("48201:12345", "999").entityId).toBe(
      "48201:12345:sd:999",
    );
    expect(specialDistrictAbsenceEntityId("48021:27303").entityId).toBe(
      "48021:27303:sd",
    );
    expect(() => specialDistrictPresentEntityId("48021:27303", "outside")).toThrow(
      /sentinel token 'outside'/,
    );
  });

  it("footprint primary leaves :primary; absence uses :none", () => {
    expect(buildingFootprintPresentEntityId("48021:27303", "primary").entityId).toBe(
      "48021:27303:footprint",
    );
    expect(
      buildingFootprintPresentEntityId("48021:27303", "ml-feature-1").entityId,
    ).toBe("48021:27303:footprint:ml-feature-1");
    expect(buildingFootprintAbsenceEntityId("48021:27303").entityId).toBe(
      "48021:27303:footprint:none",
    );
  });

  it("padded flood input mints integer entity_id and keeps the pad in externalKeys", () => {
    const id = mintParcelFactIdentity("48021:27303.00000000");
    expect(id.entityId).toBe("48021:27303");
    expect(id.externalKeys[0]?.keyValue).toBe("48021:27303.00000000");
  });
});

describe("applies-to is the edge (WDLL 11 C4)", () => {
  it("fact → parcel-node at the canonical integer key", () => {
    const link = appliesToLinkFromPropertyAtom({
      entityType: "flood-hazard-fact",
      entityId: "48021:27303",
      parcelNodeId: "48021:27303",
    });
    expect(link).toEqual({
      fromEntityType: "flood-hazard-fact",
      fromEntityId: "48021:27303",
      toEntityType: "parcel-node",
      toEntityId: "48021:27303",
      linkType: "applies-to",
    });
  });

  it("does not treat parcel-node or county-coverage as applies-to", () => {
    expect(
      appliesToLinkFromPropertyAtom({
        entityType: "parcel-node",
        entityId: "48021:27303",
        parcelNodeId: "48021:27303",
      }),
    ).toBeNull();
    expect(
      appliesToLinkFromPropertyAtom({
        entityType: "flood-hazard-fact",
        entityId: "48021:_county_coverage",
        parcelNodeId: "48021:_county_coverage",
      }),
    ).toBeNull();
  });
});

describe("skip-helper still mints the old shape (bypass = COPY / raw SQL)", () => {
  it("a write that skips the helper keeps padded and sentinel entity_id", () => {
    expect(mintOldShapeIfHelperSkipped("48021:27303.00000000")).toBe(
      "48021:27303.00000000",
    );
    expect(mintOldShapeIfHelperSkipped("48021:27303:sd:outside")).toBe(
      "48021:27303:sd:outside",
    );
    expect(mintOldShapeIfHelperSkipped("48021:27303:footprint:primary")).toBe(
      "48021:27303:footprint:primary",
    );
    expect(() =>
      assertCanonicalParcelEntityId(
        mintOldShapeIfHelperSkipped("48021:27303.00000000"),
      ),
    ).toThrow(ParcelEntityIdRejectedError);
  });
});
