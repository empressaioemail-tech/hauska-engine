/**
 * Seam tests for building-footprint writer (@hauska-engine/atoms).
 */
import { describe, expect, it } from "vitest";
import { BUILDING_FOOTPRINT_SCHEMA } from "@empressaio/atom-contract/property";

import {
  buildBuildingFootprintPerParcelAbsenceAtom,
  buildCountyBuildingFootprintCoverageAbsenceAtom,
  buildPresentBuildingFootprintAtom,
  buildingFootprintClaimContentHash,
  type PropertyFactWriteProvenance,
} from "../building-footprint-writer.js";
import { buildingFootprintAtomDid } from "../fact-writer-ids.js";

const PROVENANCE: PropertyFactWriteProvenance = {
  sourceAdapter: "ml-global-building-footprints-v1",
  sourceCitation:
    "Microsoft Building Footprints (ODC-By 1.0) via ml-global-building-footprints-v1",
  sourceUrl:
    "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Texas.geojson.zip",
  sourceVintage: "GlobalMLBuildingFootprints-Texas",
  observedAt: "2026-08-09T12:00:00.000Z",
  jurisdictionTenant: "tx_48021",
  contentHash: "fnv1a64:deadbeefdeadbeef",
};

describe("building-footprint writer seam", () => {
  it("mints stable prefixed DIDs", () => {
    const did = buildingFootprintAtomDid({
      parcelNodeId: "48021:27303",
      footprintId: "primary",
    });
    expect(did).toMatch(/^bfoot_[0-9a-f]{16}$/);
  });

  it("builds present ML footprint with entityId parcelNodeId:footprint:footprintId", () => {
    const atom = buildPresentBuildingFootprintAtom(
      {
        parcelNodeId: "48021:27303",
        footprintId: "primary",
        sourceTier: "ml-derived",
        footprintGeometry: {
          type: "Polygon",
          coordinates: [
            [
              [-97.3189, 30.1101],
              [-97.3185, 30.1101],
              [-97.3185, 30.1105],
              [-97.3189, 30.1105],
              [-97.3189, 30.1101],
            ],
          ],
        },
      },
      {
        ...PROVENANCE,
        contentHash: buildingFootprintClaimContentHash({
          parcelNodeId: "48021:27303",
          footprintId: "primary",
          sourceTier: "ml-derived",
          mlFeatureId: "ml-fixture-1",
        }),
      },
    );

    expect(atom.entityType).toBe("building-footprint");
    expect(atom.entityId).toBe("48021:27303:footprint:primary");
    expect(atom.sourceTier).toBe("ml-derived");
    expect(atom.accessPolicy).toBe("public-free");
    expect(BUILDING_FOOTPRINT_SCHEMA.safeParse(atom).success).toBe(true);
  });

  it("builds per-parcel no-footprint-feature absence", () => {
    const atom = buildBuildingFootprintPerParcelAbsenceAtom(
      {
        parcelNodeId: "48021:99999",
        absenceKind: "no-footprint-feature",
        reason: "ml-spatial-join-below-50pct-overlap-threshold",
      },
      PROVENANCE,
    );
    expect(atom.absence?.kind).toBe("no-footprint-feature");
    expect(atom.sourceTier).toBe("ml-derived");
    expect(atom.footprintGeometry).toBeUndefined();
  });

  it("builds county verifiedAbsence coverage row", () => {
    const atom = buildCountyBuildingFootprintCoverageAbsenceAtom(
      {
        countyFips: "48021",
        provenanceScope: ["microsoft-global-ml-building-footprints"],
      },
      PROVENANCE,
    );
    expect(atom.sourceTier).toBe("absent");
    expect(atom.verifiedAbsence?.evaluated).toBe(true);
    expect(atom.parcelNodeId).toBe("48021:_county_coverage");
    expect(atom.footprintId).toBe("county-coverage");
  });
});
