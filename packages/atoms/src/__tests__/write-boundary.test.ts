import { describe, expect, it } from "vitest";

import { buildAtomDid } from "../did.js";
import type { PropertyAtomInstance } from "../property-instances.js";
import {
  DID_NAMESPACE,
  KEY_SENTINEL,
  NON_CANONICAL_BINDING,
  STARVED_EDGE,
  assertEdgesNotStarved,
  assertPropertyWriteBoundary,
  expectedAppliesToCount,
} from "../write-boundary.js";

type BoundaryFixture = Pick<
  PropertyAtomInstance,
  "entityType" | "entityId" | "parcelNodeId" | "atomDid"
>;

function cad(
  overrides: Partial<BoundaryFixture> = {},
): BoundaryFixture {
  const entityType = overrides.entityType ?? "cad-parcel-roll";
  const entityId = overrides.entityId ?? "48029:12345";
  const parcelNodeId = overrides.parcelNodeId ?? "48029:12345";
  return {
    entityType,
    entityId,
    parcelNodeId,
    atomDid: overrides.atomDid ?? buildAtomDid(entityType, entityId).raw,
  };
}

describe("assertPropertyWriteBoundary (P-82 item 1)", () => {
  it("accepts a Bexar cad key", () => {
    expect(() => assertPropertyWriteBoundary(cad())).not.toThrow();
  });

  it("refuses a bare key as NON_CANONICAL_BINDING before INSERT", () => {
    expect(() => assertPropertyWriteBoundary(cad({ entityId: "12345" }))).toThrow(
      expect.objectContaining({ code: NON_CANONICAL_BINDING }),
    );
  });

  it("refuses :outside and :primary as KEY_SENTINEL", () => {
    expect(() =>
      assertPropertyWriteBoundary(cad({ entityId: "48029:12345:outside" })),
    ).toThrow(expect.objectContaining({ code: KEY_SENTINEL }));
    expect(() =>
      assertPropertyWriteBoundary(cad({ entityId: "48029:12345:primary" })),
    ).toThrow(expect.objectContaining({ code: KEY_SENTINEL }));
  });

  it("refuses body.atomDid in another namespace as DID_NAMESPACE", () => {
    expect(() =>
      assertPropertyWriteBoundary(
        cad({ atomDid: "did:other:cad-parcel-roll:48029:12345" }),
      ),
    ).toThrow(expect.objectContaining({ code: DID_NAMESPACE }));
  });

  it("refuses body.atomDid whose entityType does not match the column", () => {
    expect(() =>
      assertPropertyWriteBoundary(
        cad({ atomDid: "did:hauska:zoning-fact:48029:12345" }),
      ),
    ).toThrow(expect.objectContaining({ code: DID_NAMESPACE }));
  });

  it("admits a writer-local atomDid that is not a DID", () => {
    expect(() =>
      assertPropertyWriteBoundary(cad({ atomDid: "fhfact_6514bebf8b04b91f" })),
    ).not.toThrow();
  });

  it("accepts matching did:hauska column namespace", () => {
    const atomDid = buildAtomDid("cad-parcel-roll", "48029:12345").raw;
    expect(() => assertPropertyWriteBoundary(cad({ atomDid }))).not.toThrow();
  });
});

describe("expectedAppliesToCount (P-82 item 4)", () => {
  it("skipped helper fails STARVED_EDGE; matching count passes", () => {
    const atoms = [
      {
        entityType: "cad-parcel-roll",
        parcelNodeId: "48029:1",
      } as const satisfies Pick<PropertyAtomInstance, "entityType" | "parcelNodeId">,
    ];
    expect(() => assertEdgesNotStarved(atoms, 0)).toThrow(
      expect.objectContaining({ code: STARVED_EDGE }),
    );
    expect(() => assertEdgesNotStarved(atoms, 1)).not.toThrow();
  });

  it("counts parcel-keyed facts and skips county coverage", () => {
    expect(
      expectedAppliesToCount([
        { entityType: "cad-parcel-roll", parcelNodeId: "48029:1" },
        { entityType: "parcel-node", parcelNodeId: "48029:1" },
        { entityType: "cad-parcel-roll", parcelNodeId: "48029:_county_coverage" },
        { entityType: "cad-parcel-roll", parcelNodeId: "" },
      ] as const satisfies ReadonlyArray<
        Pick<PropertyAtomInstance, "entityType" | "parcelNodeId">
      >),
    ).toBe(1);
  });
});
