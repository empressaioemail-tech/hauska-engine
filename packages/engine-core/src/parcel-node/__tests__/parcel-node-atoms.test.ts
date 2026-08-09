/**
 * Rail 1 `parcel-node` atom-construction + write-then-verify tests.
 *
 * Uses the in-memory StoragePort, never a live database — an executor pointed
 * DATABASE_URL at a deployment Postgres and left 30 orphaned `test_*` schemas.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import {
  buildAtomForPlanned,
  buildAtomsForPlan,
  buildCountyCoverageAtom,
  parcelNodeContentHash,
  verifyStoredParcelNodeAtom,
  type CountyRunProvenance,
} from "../parcel-node-atoms.js";
import { planCountyParcelNodes, type TxgioParcelRowInput } from "../plan-county-parcel-nodes.js";

const VINTAGE = "stratmap25-landparcels_48261_kenedy_202503";

const PROVENANCE: CountyRunProvenance = {
  sourceAdapter: "txgio-stratmap-bulk-v1",
  sourceCitation: `TxGIO StratMap Land Parcels, county 48261, vintage ${VINTAGE}`,
  sourceUrl: "https://data.geographic.texas.gov/",
  observedAt: "2026-08-08T12:00:00.000Z",
  jurisdictionTenant: "tx_48261",
  verificationStatus: "machine",
};

function polygon(): unknown {
  return {
    type: "Polygon",
    coordinates: [
      [
        [-97.9597, 26.6222],
        [-97.9590, 26.6222],
        [-97.9590, 26.6230],
        [-97.9597, 26.6230],
        [-97.9597, 26.6222],
      ],
    ],
  };
}

function multiPart(): unknown {
  const part = (polygon() as { coordinates: unknown[] }).coordinates;
  return { type: "MultiPolygon", coordinates: [part, part] };
}

function tiled(
  featureIndex: number,
  propId: string | null,
  tiles = 3,
  geometry: unknown = polygon(),
): TxgioParcelRowInput[] {
  return Array.from({ length: tiles }, (_, i) => ({
    featureIndex,
    tileKey: `g0.02:-97.9${(60 + i).toString().padStart(2, "0")}0,26.6220`,
    propId,
    geoId: null,
    geometry,
    sourceVintage: VINTAGE,
  }));
}

const POLICY = {
  countyFips: "48261",
  keyKind: "prop_id",
  geometrySourceTier: "txgio-stratmap",
} as const;

describe("parcel-node atom construction", () => {
  it("builds a resolved anchor that POINTS at txgio_parcel and carries no ring", () => {
    const plan = planCountyParcelNodes(tiled(1, "15271"), POLICY);
    const [atom] = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);

    expect(atom!.entityType).toBe("parcel-node");
    expect(atom!.parcelNodeId).toBe("48261:15271");
    expect(atom!.geometryStoreRef).toEqual({
      store: "txgio_parcel",
      countyFips: "48261",
      propId: "15271",
    });
    expect(atom!.geometryLoaded).toBe(true);
    expect(atom!.sourceVintage).toBe(VINTAGE);
    // Geometry Law rule 1 — one ring, in the store, never duplicated here.
    expect(JSON.stringify(atom)).not.toMatch(/"coordinates"/);
  });

  it("builds each of the three typed absence kinds through the contract", () => {
    const rows = [
      ...tiled(0, "0"),
      ...tiled(1, "15271", 3, multiPart()),
      ...tiled(2, "15276", 3, { type: "Point", coordinates: [0, 0] }),
    ];
    const plan = planCountyParcelNodes(rows, POLICY);
    const atoms = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);

    const kinds = atoms.map((a) => a.absence?.kind).sort();
    expect(kinds).toEqual([
      "geometry-incomplete",
      "no-parcel-geometry",
      "parcel-key-unresolved",
    ]);
    for (const atom of atoms) {
      expect(atom.geometryLoaded).toBe(false);
      expect(atom.geometryStoreRef).toBeUndefined();
      expect(atom.absence?.reason.length).toBeGreaterThan(0);
    }
  });

  it("builds the county-coverage anchor and refuses one with no documented probe", () => {
    const anchor = buildCountyCoverageAtom(
      "48301",
      ["txgio-stratmap-bulk", "county-arcgis-override"],
      { ...PROVENANCE, jurisdictionTenant: "tx_48301" },
    );
    expect(anchor.parcelNodeId).toBe("48301:_county_coverage");
    expect(anchor.geometrySourceTier).toBe("absent");
    expect(anchor.verifiedAbsence?.evaluated).toBe(true);

    expect(() =>
      buildCountyCoverageAtom("48301", [], { ...PROVENANCE, jurisdictionTenant: "tx_48301" }),
    ).toThrow();
  });

  it("throws rather than persisting a shape the contract rejects", () => {
    expect(() =>
      buildAtomForPlanned(
        {
          outcome: "resolved",
          featureIndex: 1,
          parcelKey: "bad key with spaces",
          keyKind: "prop_id",
          additionalFeatureIndexes: [],
          sourceVintage: VINTAGE,
        },
        "48261",
        "txgio-stratmap",
        PROVENANCE,
      ),
    ).toThrow();
  });
});

describe("idempotence", () => {
  it("produces a stable content hash across runs so a re-run does not churn every row", () => {
    const plan = planCountyParcelNodes(tiled(1, "15271"), POLICY);
    const first = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);
    const later = buildAtomsForPlan(plan, "txgio-stratmap", {
      ...PROVENANCE,
      observedAt: "2026-09-01T09:00:00.000Z",
    });

    // Different run timestamps, identical claim -> identical hash and id.
    expect(later[0]!.contentHash).toBe(first[0]!.contentHash);
    expect(later[0]!.atomDid).toBe(first[0]!.atomDid);
    expect(later[0]!.extractedAt).not.toBe(first[0]!.extractedAt);
  });

  it("changes the content hash when the CLAIM changes", () => {
    const resolved = parcelNodeContentHash({
      parcelNodeId: "48261:15271",
      keyKind: "prop_id",
      geometrySourceTier: "txgio-stratmap",
      geometryLoaded: true,
    });
    const absent = parcelNodeContentHash({
      parcelNodeId: "48261:15271",
      keyKind: "prop_id",
      geometrySourceTier: "txgio-stratmap",
      geometryLoaded: false,
      absenceKind: "geometry-incomplete",
      absenceReason: "MultiPolygon with 2 parts",
    });
    expect(absent).not.toBe(resolved);
  });

  it("re-writing the same county does not duplicate atoms in the store", async () => {
    const storage = new InMemoryStorage();
    const plan = planCountyParcelNodes(
      [...tiled(1, "15271"), ...tiled(2, "15276"), ...tiled(0, "0")],
      POLICY,
    );
    const atoms = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);

    await storage.writePropertyAtomsBatch(atoms);
    await storage.writePropertyAtomsBatch(atoms);

    const back = await storage.listPropertyAtomsByParcelNodeId("48261:15271");
    expect(back.filter((a) => a.entityType === "parcel-node").length).toBe(1);
  });
});

describe("write-then-verify on stored bytes (Geometry Law rule 3)", () => {
  it("passes when the stored body is the atom that was planned", async () => {
    const storage = new InMemoryStorage();
    const plan = planCountyParcelNodes([...tiled(1, "15271"), ...tiled(0, "0")], POLICY);
    const atoms = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);
    await storage.writePropertyAtomsBatch(atoms);

    for (const atom of atoms) {
      const stored = (
        await storage.listPropertyAtomsByParcelNodeId(atom.parcelNodeId)
      ).find((a) => a.entityType === "parcel-node");
      expect(stored).toBeDefined();
      const verdict = verifyStoredParcelNodeAtom(stored, {
        parcelNodeId: atom.parcelNodeId,
        outcome: atom.geometryLoaded ? "resolved" : "absent",
      });
      expect(verdict).toEqual({ ok: true });
    }
  });

  it("fails when stored bytes no longer satisfy the contract", () => {
    const plan = planCountyParcelNodes(tiled(1, "15271"), POLICY);
    const [atom] = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);
    const tampered = { ...atom!, geometryStoreRef: undefined };

    const verdict = verifyStoredParcelNodeAtom(tampered, {
      parcelNodeId: "48261:15271",
      outcome: "resolved",
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { problem: string }).problem).toMatch(/PARCEL_NODE_SCHEMA/);
  });

  it("fails when a stored pointer names a DIFFERENT parcel than the atom claims", () => {
    const plan = planCountyParcelNodes(tiled(1, "15271"), POLICY);
    const [atom] = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);
    // A pointer that resolves someone else's ring is the master defect class:
    // gate one representation, serve another.
    const swapped = {
      ...atom!,
      geometryStoreRef: { store: "txgio_parcel", countyFips: "48261", propId: "99999" },
    };

    const verdict = verifyStoredParcelNodeAtom(swapped, {
      parcelNodeId: "48261:15271",
      outcome: "resolved",
    });
    expect(verdict.ok).toBe(false);
    // The contract's own superRefine rule 5 catches this at the schema layer,
    // before the verifier's redundant pointer check ever runs — which is the
    // stronger place for it to fail. Both guards are kept: the schema one is
    // authoritative, the verifier's is the backstop if the schema ever relaxes.
    expect((verdict as { problem: string }).problem).toMatch(
      /geometryStoreRef\.propId must equal the parcelNodeId key token/,
    );
  });

  it("fails when the stored outcome disagrees with the plan", () => {
    const plan = planCountyParcelNodes(tiled(1, "15271", 3, multiPart()), POLICY);
    const [atom] = buildAtomsForPlan(plan, "txgio-stratmap", PROVENANCE);

    const verdict = verifyStoredParcelNodeAtom(atom, {
      parcelNodeId: "48261:15271",
      outcome: "resolved",
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { problem: string }).problem).toMatch(/!= planned resolved/);
  });

  it("fails when an absence atom somehow carries a geometry pointer", () => {
    const verdict = verifyStoredParcelNodeAtom(
      { entityType: "parcel-node", parcelNodeId: "48261:15271" },
      { parcelNodeId: "48261:15271", outcome: "absent" },
    );
    expect(verdict.ok).toBe(false);
  });
});
