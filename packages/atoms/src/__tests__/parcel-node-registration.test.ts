/**
 * Rail 1 `parcel-node` registration + writer-seam tests.
 *
 * Also pins the two ADR-029 site layers that shipped in contract 1.12.0 but
 * were never registered engine-side — the reason their manifest columns read
 * UNPUB — plus the 1.14.0 manifest rails (flood / cad / landuse).
 */
import { describe, expect, it } from "vitest";

import {
  PROPERTY_ENTITY_TYPES,
  isPropertyEntityType,
  isPropertyAtomInstance,
  type PropertyEntityType,
} from "../property-instances.js";
import {
  buildCountyCoverageAbsenceAtom,
  buildParcelNodeAbsenceAtom,
  buildResolvedParcelNodeAtom,
  type ParcelNodeWriteProvenance,
} from "../parcel-node-writer.js";

const PROVENANCE: ParcelNodeWriteProvenance = {
  sourceAdapter: "txgio-stratmap-bulk-v1",
  sourceCitation: "TxGIO StratMap Texas Parcels 2026 county 48021",
  sourceUrl: "https://data.tnris.org/stratmap/parcels/2026",
  sourceVintage: "2026-01-01",
  observedAt: "2026-08-08T12:00:00.000Z",
  jurisdictionTenant: "tx-48021",
  contentHash: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
};

describe("property registration — parcel-node and ADR-029 site layers", () => {
  it("registers parcel-node (MCP advertised it with no engine writer)", () => {
    expect(PROPERTY_ENTITY_TYPES).toContain("parcel-node");
    expect(isPropertyEntityType("parcel-node")).toBe(true);
  });

  it("registers building-footprint and utility-easement (contract 1.12.0)", () => {
    expect(PROPERTY_ENTITY_TYPES).toContain("building-footprint");
    expect(PROPERTY_ENTITY_TYPES).toContain("utility-easement");
    expect(isPropertyEntityType("building-footprint")).toBe(true);
    expect(isPropertyEntityType("utility-easement")).toBe(true);
  });

  it("registers flood-hazard-fact, cad-parcel-roll, and land-use-fact (contract 1.14.0)", () => {
    expect(PROPERTY_ENTITY_TYPES).toContain("flood-hazard-fact");
    expect(PROPERTY_ENTITY_TYPES).toContain("cad-parcel-roll");
    expect(PROPERTY_ENTITY_TYPES).toContain("land-use-fact");
    expect(isPropertyEntityType("flood-hazard-fact")).toBe(true);
    expect(isPropertyEntityType("cad-parcel-roll")).toBe(true);
    expect(isPropertyEntityType("land-use-fact")).toBe(true);
  });

  it("keeps the four pre-existing property types registered (additive only)", () => {
    for (const type of [
      "zoning-fact",
      "setback-rule",
      "buildable-envelope",
      "parcel-terrain-model",
    ] as ReadonlyArray<PropertyEntityType>) {
      expect(PROPERTY_ENTITY_TYPES).toContain(type);
    }
    expect(PROPERTY_ENTITY_TYPES.length).toBe(12);
  });

  it("registers owner-fact (contract 1.16.0), the one paid property type", () => {
    expect(PROPERTY_ENTITY_TYPES).toContain("owner-fact");
    expect(isPropertyEntityType("owner-fact")).toBe(true);
  });

  it("registers special-district-fact (contract 1.18.0, mud rail)", () => {
    expect(PROPERTY_ENTITY_TYPES).toContain("special-district-fact");
    expect(isPropertyEntityType("special-district-fact")).toBe(true);
  });

  it("does not register unrelated types", () => {
    expect(isPropertyEntityType("road-node")).toBe(false);
    expect(isPropertyEntityType("parcel-record")).toBe(false);
    expect(isPropertyEntityType("code-section")).toBe(false);
  });
});

describe("parcel-node writer seam", () => {
  it("builds a resolved anchor pointing at txgio_parcel", () => {
    const atom = buildResolvedParcelNodeAtom(
      {
        countyFips: "48021",
        parcelKey: "27303",
        keyKind: "prop_id",
        geometrySourceTier: "txgio-stratmap",
      },
      PROVENANCE,
    );

    expect(atom.entityType).toBe("parcel-node");
    expect(atom.parcelNodeId).toBe("48021:27303");
    expect(atom.atomDid).toBe("did:hauska:parcel-node:48021:27303");
    expect(atom.geometryStoreRef?.store).toBe("txgio_parcel");
    expect(atom.geometryStoreRef?.propId).toBe("27303");
    expect(atom.geometryLoaded).toBe(true);
    expect(atom.accessPolicy).toBe("public-free");
    expect(atom.entityId).toBe("48021:27303");
    expect(atom.status).toBe("active");
    expect(isPropertyAtomInstance(atom)).toBe(true);
  });

  it("never carries ring coordinates (Geometry Law rule 1)", () => {
    const atom = buildResolvedParcelNodeAtom(
      {
        countyFips: "48021",
        parcelKey: "27303",
        keyKind: "prop_id",
        geometrySourceTier: "txgio-stratmap",
      },
      PROVENANCE,
    );
    expect(JSON.stringify(atom)).not.toMatch(/"coordinates"/);
    expect(Object.keys(atom)).not.toContain("geometry");
  });

  it("builds per-parcel typed absence in a loaded county", () => {
    const atom = buildParcelNodeAbsenceAtom(
      {
        countyFips: "48021",
        parcelKey: "99999",
        keyKind: "prop_id",
        geometrySourceTier: "txgio-stratmap",
        absenceKind: "no-parcel-geometry",
        reason: "county loaded 2026-01-01; prop_id 99999 has no ring row",
      },
      PROVENANCE,
    );

    expect(atom.absence?.kind).toBe("no-parcel-geometry");
    expect(atom.geometryLoaded).toBe(false);
    expect(atom.geometryStoreRef).toBeUndefined();
  });

  it("builds the MultiPolygon truncation finding rather than truncating", () => {
    const atom = buildParcelNodeAbsenceAtom(
      {
        countyFips: "48021",
        parcelKey: "27304",
        keyKind: "prop_id",
        geometrySourceTier: "txgio-stratmap",
        absenceKind: "geometry-incomplete",
        reason: "MultiPolygon with 3 rings; serving path resolves first ring only",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("geometry-incomplete");
  });

  it("builds county-coverage verified absence with a documented probe scope", () => {
    const atom = buildCountyCoverageAbsenceAtom(
      {
        countyFips: "48301",
        provenanceScope: ["txgio-stratmap-bulk", "county-arcgis-override"],
      },
      {
        ...PROVENANCE,
        sourceAdapter: "parcel-source-registry-probe-v1",
        sourceCitation: "Rail 1 parcel source registry probe 48301 2026-08-08",
        jurisdictionTenant: "tx-48301",
      },
    );

    expect(atom.parcelNodeId).toBe("48301:_county_coverage");
    expect(atom.geometrySourceTier).toBe("absent");
    expect(atom.geometryLoaded).toBe(false);
    expect(atom.verifiedAbsence?.evaluated).toBe(true);
    expect(atom.verifiedAbsence?.provenanceScope).toEqual([
      "txgio-stratmap-bulk",
      "county-arcgis-override",
    ]);
  });

  it("fails closed: a county absence with no documented probe scope is rejected", () => {
    expect(() =>
      buildCountyCoverageAbsenceAtom(
        { countyFips: "48301", provenanceScope: [] },
        PROVENANCE,
      ),
    ).toThrow();
  });

  it("write-then-verify: an out-of-county key cannot be persisted", () => {
    expect(() =>
      buildResolvedParcelNodeAtom(
        {
          countyFips: "48021",
          parcelKey: "bad key with spaces",
          keyKind: "prop_id",
          geometrySourceTier: "txgio-stratmap",
        },
        PROVENANCE,
      ),
    ).toThrow();
  });

  it("records crosswalk key kind and divergence count without re-picking truth", () => {
    const atom = buildResolvedParcelNodeAtom(
      {
        countyFips: "48453",
        parcelKey: "0207310401",
        keyKind: "geo_id_crosswalk",
        geometrySourceTier: "county-arcgis-override",
        divergenceObservationCount: 2,
        externalKeys: [
          {
            keyKind: "geo_id_crosswalk",
            keyValue: "0207310401",
            sourceCitation: "TCAD geo_id crosswalk 2026 roll",
          },
        ],
      },
      { ...PROVENANCE, jurisdictionTenant: "tx-48453" },
    );

    expect(atom.keyKind).toBe("geo_id_crosswalk");
    expect(atom.divergenceObservationCount).toBe(2);
    expect(atom.geometryStoreRef?.store).toBe("txgio_parcel");
    expect(atom.externalKeys?.[0]?.keyValue).toBe("0207310401");
  });
});
