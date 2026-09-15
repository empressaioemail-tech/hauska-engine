/**
 * P-219 — both PDF products drew every setback line from an ordinance the City
 * of Bastrop repealed on 2026-04-14, and the engine had no corner-side concept.
 *
 * Verified at source before this test existed, live 2026-09-15, by exporting
 * the feasibility study for `48021:34049` (1109 Pecan St, SF-1, a CORNER lot)
 * through the Smart Site MCP and reading the PDF:
 *
 *     Setbacks  25 / 5 / 25 ft -- source: Setback rule for SF-1 cited to
 *     bastrop-per-parcel/34049/front, cited ... ORDINANCE NO. 2019-51 ...
 *     19,052 sq ft of buildable area
 *     64% of the 29,989 sq ft lot, an envelope roughly 131 by 158 ft at its widest
 *     FRONT SETBACK 25'   SIDE 5' (TYP.)   SIDE 5'   REAR 25'
 *
 * against a `setbackRulesFact` and parcel_record rails serving 30 / 10 / 30
 * with a 20 ft corner side, cited to Ordinance 2026-06 effective 2026-04-14.
 *
 * Each test below pins one leg of that defect.
 */
import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance, SetbackRuleAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

import { computeParcelInteriorFacts } from "../../boundary-primitive/interior.js";
import type { Ring } from "../../depth-warm/geometry.js";
import { prepareBoundaryEdgesForExport } from "../prepare-boundary-edges-for-export.js";
import { resolveExportSetback } from "../resolve-export-setback.js";
import { formatSetbackSummaryLine } from "../setback-display.js";
import type {
  ParcelRecordRail,
  ParcelRecordResponse,
} from "../parcel-record-reader-client.js";

const PARCEL = "48021:34049";
const BASE_LNG = -97.31717;
const BASE_LAT = 30.11238;
const DEG_PER_FT_LAT = 1 / 364000;
const DEG_PER_FT_LNG = 1 / (364000 * Math.cos((BASE_LAT * Math.PI) / 180));

function ftRing(pts: Array<[number, number]>): Ring {
  const ring = pts.map(
    ([x, y]) => [BASE_LNG + x * DEG_PER_FT_LNG, BASE_LAT + y * DEG_PER_FT_LAT] as [number, number],
  );
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

/**
 * The 48021:34049 lot, to its live dimensions: the ledger's own boundary
 * primitive spans 179.7 ft east-west and 166.9 ft north-south.
 */
const CORNER_LOT_RING = ftRing([
  [0, 0],
  [179.7, 0],
  [179.7, 166.9],
  [0, 166.9],
]);

/** Roles as the ledger carries them for this parcel, read live 2026-09-15. */
const LEDGER_ROLES: ReadonlyArray<BoundaryEdgeAtomInstance["role"]> = [
  "front",
  "side_corner",
  "rear",
  "side",
];

function storedEdges(
  roles: ReadonlyArray<BoundaryEdgeAtomInstance["role"]>,
  opts?: { feet?: number; sourceAdapter?: string },
): BoundaryEdgeAtomInstance[] {
  const facts = computeParcelInteriorFacts(CORNER_LOT_RING)!;
  return roles.map((role, i) => {
    const interior = facts.edges.find((e) => e.edgeIndex === i)!;
    const boundaryEdgeId = `${PARCEL}:boundary:${i}`;
    return {
      entityType: "property-boundary-edge",
      atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: PARCEL,
      countyFips: "48021",
      propId: "34049",
      edgeIndex: i,
      role,
      adjacencyKind: "ROW",
      parcelNeighborPropId: null,
      facingRoad: null,
      setback: {
        feet: opts?.feet ?? 5,
        provenance: "stale-fixture",
        atomCitation: "bastrop-per-parcel/34049/front",
      },
      interior: {
        ringCcw: interior.ringCcw,
        centroidInside: interior.centroidInside,
        inwardNormal: interior.inwardNormal,
        edgeEndpoints: interior.edgeEndpoints,
      },
      effectiveDate: "2026-07-29",
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy: "platform-internal",
      sourceCitation: "test fixture",
      extractedAt: "2026-07-29T00:00:00.000Z",
      atomTier: "data",
      // The live stored edges carry exactly this adapter, which is what makes
      // `isStaleBastropCitySetbackRule` fire and the value refresh run.
      jurisdictionTenant: "bastrop-city-tx",
      fetchedAt: "2026-07-29T00:00:00.000Z",
      sourceAdapter: opts?.sourceAdapter ?? "descriptor-fixture",
      sourceUrl: "test://",
      contentHash: "fixture",
    } satisfies BoundaryEdgeAtomInstance;
  });
}

/** The persisted setback-rule atom exactly as the defect had it. */
function repealedSetbackAtom(): SetbackRuleAtomInstance {
  return {
    entityType: "setback-rule",
    atomDid: `did:hauska:setback-rule:${PARCEL}:setback:1`,
    entityId: `${PARCEL}:setback:1`,
    jurisdictionTenant: "bastrop-city-tx",
    parcelNodeId: PARCEL,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    extractedAt: "2026-07-30T00:00:00.000Z",
    sourceAdapter: "bastrop-per-parcel-record-layer-23",
    sourceUrl:
      "https://www.cityofbastrop.org/page/open/6743/0/ORDINANCE%20NO.%202019-51%20BASTROP%20BUILDING%20BLOCKS.pdf",
    sourceCitation: "Setback rule for SF-1 cited to bastrop-per-parcel/34049/front",
    accessPolicy: "platform-internal",
    atomTier: "data",
    status: "active",
    districtCode: "SF-1",
    front: 25,
    side: 5,
    sideInteriorFt: 5,
    rear: 25,
    // The defect's own shape: no corner-side value at all.
    sourceCodeAtomRef: {
      atomDid: "bastrop-per-parcel/34049/front",
      role: "rule",
      entityType: "code-section",
    },
  } as unknown as SetbackRuleAtomInstance;
}

function scalarRail(value: number): ParcelRecordRail {
  return {
    cell: { kind: "value", value },
    gate: { verdict: "pass", evaluatedAt: "2026-09-15T00:00:00.000Z" },
    serve: "record",
    atom: null,
    atomBacked: false,
    rendering: null,
    companions: [],
  };
}

/** The parcel_record rails as the live reader serves them for this parcel. */
function liveRecord(): ParcelRecordResponse {
  return {
    parcelNodeId: PARCEL,
    placeKey: PARCEL,
    countyFips: "48021",
    railRegistrySha: "test",
    readAt: "2026-09-15T00:00:00.000Z",
    rails: {
      setbackFrontFt: scalarRail(30),
      setbackSideFt: scalarRail(10),
      setbackRearFt: scalarRail(30),
      setbackCornerFt: scalarRail(20),
      situsAddress: {
        ...scalarRail(0),
        cell: { kind: "value", value: "1109 PECAN ST" },
      },
    },
    refused: null,
  };
}

describe("P-219 leg 1 — the engine resolves setbacks from the same fact the facet uses", () => {
  it("follows the parcel_record rails, and declines the repealed atom by name", async () => {
    const resolved = await resolveExportSetback({
      parcelNodeId: PARCEL,
      districtCode: "SF-1",
      jurisdictionKey: "bastrop-development-code",
      atom: repealedSetbackAtom(),
      record: liveRecord(),
    });
    expect(resolved.provenanceKind).toBe("parcel-record-rails");
    expect(resolved.front).toBe(30);
    expect(resolved.side).toBe(10);
    expect(resolved.rear).toBe(30);
    expect(resolved.cornerFt).toBe(20);
    expect(resolved.honestAbsence).toBe(false);
    // "If the numbers now match but you cannot say WHICH source the engine
    // reads, you have patched a value rather than a provenance." The sheet
    // prints this.
    expect(resolved.sourceCodeAtomDid).toBe("bastrop_tx/bdc-2026-adopted/14.02.003");
    expect(resolved.sourceCitation).toContain("2026-06");
    expect(resolved.sourceDate).toBe("2026-04-14");
    // Retirement, proven by decline rather than by documentation.
    expect(resolved.retiredAtomDeclined?.atomDid).toBe("bastrop-per-parcel/34049/front");
  });

  it("honest-absents rather than serving the repealed atom when the reader is absent (R13 holds)", async () => {
    const resolved = await resolveExportSetback({
      parcelNodeId: PARCEL,
      districtCode: "SF-1",
      jurisdictionKey: "bastrop-development-code",
      atom: repealedSetbackAtom(),
      // No reader and no record: the report must never FAIL for want of one,
      // but it must not invent a number either.
      record: null,
    });
    // R13 (AMENDMENT 8) forbids serving the ruled chart's SCALARS for a
    // Bastrop city district without a layer-23 per-parcel record, and P-219
    // deliberately did not overturn that standing ruling (see the note in
    // `getSetbackTableForZoning` and the proposal in this lane's close). So
    // the degraded path is an honest absence — no dimension drawn, the legend
    // says the layer is unverified — and NOT the repealed 25/5/25.
    expect(resolved.honestAbsence).toBe(true);
    expect([resolved.front, resolved.side, resolved.rear]).toEqual([0, 0, 0]);
    expect(resolved.retiredAtomDeclined?.atomDid).toBe("bastrop-per-parcel/34049/front");
    expect(resolved.honestAbsenceReason).toContain("retired");
  });

  it("NEVER falls back to the repealed atom's numbers — the whole defect, in one assertion", async () => {
    for (const record of [liveRecord(), null]) {
      const resolved = await resolveExportSetback({
        parcelNodeId: PARCEL,
        districtCode: "SF-1",
        jurisdictionKey: "bastrop-development-code",
        atom: repealedSetbackAtom(),
        record,
      });
      expect([resolved.front, resolved.side, resolved.rear]).not.toEqual([25, 5, 25]);
      expect(resolved.sourceCodeAtomDid).not.toMatch(/^bastrop-per-parcel\//);
      expect(resolved.sourceCitation ?? "").not.toContain("2019-51");
    }
  });

  it("still uses a NON-retired persisted atom, so this is a retirement and not a bypass", async () => {
    const liveAtom = {
      ...repealedSetbackAtom(),
      front: 11,
      side: 12,
      rear: 13,
      // The atom's own districtCode wins over the caller's, matching the
      // pre-P-219 convention in `composeSitePlanModelForParcel`.
      districtCode: "NOT-A-RULED-DISTRICT",
      sourceCodeAtomRef: {
        atomDid: "grand-county-ut/code/1.2.3",
        role: "rule",
        entityType: "code-section",
      },
    } as unknown as SetbackRuleAtomInstance;
    const resolved = await resolveExportSetback({
      parcelNodeId: "49019:1234",
      // A district with no ruled row, so the atom is the only candidate.
      districtCode: "NOT-A-RULED-DISTRICT",
      jurisdictionKey: "grand-county-ut",
      atom: liveAtom,
      record: null,
    });
    expect(resolved.provenanceKind).toBe("setback-rule-atom");
    expect([resolved.front, resolved.side, resolved.rear]).toEqual([11, 12, 13]);
    expect(resolved.retiredAtomDeclined).toBeUndefined();
  });

  it("honest-absents rather than serving a retired value when no ruled row exists", async () => {
    const resolved = await resolveExportSetback({
      parcelNodeId: "49019:1234",
      districtCode: "NOT-A-RULED-DISTRICT",
      jurisdictionKey: "grand-county-ut",
      atom: {
        ...repealedSetbackAtom(),
        districtCode: "NOT-A-RULED-DISTRICT",
      } as unknown as SetbackRuleAtomInstance,
      record: null,
    });
    expect(resolved.honestAbsence).toBe(true);
    expect(resolved.front).toBe(0);
    expect(resolved.honestAbsenceReason).toContain("retired");
  });
});

describe("P-219 — the bastrop-tx routing key never leaks Bastrop numbers out of county", () => {
  it("does not hand an out-of-county SF-1 parcel Bastrop's SF-1 row", async () => {
    // Caught by this lane's own fixture: the two-key walk that lets a Bastrop
    // city parcel stamped `bastrop-tx` reach its `bastrop-development-code`
    // row would, ungated, hand the same row to any parcel anywhere stamped
    // "SF-1" with no jurisdiction key. That is a silent fallback, which is the
    // defect class this program hunts.
    const elsewhere = await resolveExportSetback({
      parcelNodeId: "48453:99999", // Travis County, not Bastrop
      districtCode: "SF-1",
      jurisdictionKey: null,
      atom: null,
      record: liveRecord(),
    });
    // The rails still supply the numbers (they are the parcel's own record),
    // but Bastrop's ordinance is NOT cited over them.
    expect(elsewhere.sourceCitation).toBeNull();
    expect(elsewhere.sourceLabel).toBe("Parcel record (ledger rails)");
    expect(elsewhere.sourceCodeAtomDid).not.toContain("bdc-2026-adopted");

    // The same call for a Bastrop County parcel DOES cite the ordinance — the
    // gate must be able to not fire, or it is an outage rather than a guard.
    const bastrop = await resolveExportSetback({
      parcelNodeId: PARCEL,
      districtCode: "SF-1",
      jurisdictionKey: null,
      atom: null,
      record: liveRecord(),
    });
    expect(bastrop.sourceCitation).toContain("2026-06");
    expect(bastrop.sourceCodeAtomDid).toBe("bastrop_tx/bdc-2026-adopted/14.02.003");
    expect(bastrop.sourceDate).toBe("2026-04-14");
  });
});

describe("P-219 leg 2 — a corner lot draws its corner-side setback", () => {
  it("gives the side_corner edge 20 ft and the interior side 10 ft, off the ruled table", async () => {
    const prepared = await prepareBoundaryEdgesForExport({
      parcelNodeId: PARCEL,
      storedEdges: storedEdges(LEDGER_ROLES),
      ringWgs84: CORNER_LOT_RING,
      roads: [],
      setback: {
        front: 30,
        side: 10,
        rear: 30,
        cornerFt: 20,
        provenance: "parcel-record-rails",
        sourceCodeAtomDid: "bastrop_tx/bdc-2026-adopted/14.02.003",
        districtCode: "SF-1",
      },
    });
    expect(prepared.setbackValuesRefreshed).toBe(true);
    const byRole = new Map(
      prepared.edges!.map((e) => [e.role, "kind" in e.setback ? "absent" : e.setback.feet]),
    );
    expect(byRole.get("front")).toBe(30);
    expect(byRole.get("rear")).toBe(30);
    expect(byRole.get("side")).toBe(10);
    // THE half that was missing. Before P-219 this read 5 — the interior-side
    // value wearing a corner label, which is the string P-214's customer saw.
    expect(byRole.get("side_corner")).toBe(20);
    const corner = prepared.edges!.find((e) => e.role === "side_corner")!;
    expect("kind" in corner.setback ? null : corner.setback.atomCitation).toBe(
      "bastrop_tx/bdc-2026-adopted/14.02.003",
    );
  });

  it("refuses a corner edge rather than substituting the interior side when the district publishes no corner value", async () => {
    const prepared = await prepareBoundaryEdgesForExport({
      parcelNodeId: PARCEL,
      storedEdges: storedEdges(LEDGER_ROLES),
      ringWgs84: CORNER_LOT_RING,
      roads: [],
      setback: {
        front: 30,
        side: 10,
        rear: 30,
        // No corner-side standard for this district. Do not invent one.
        cornerFt: null,
        provenance: "ruled-setback-table",
        sourceCodeAtomDid: "some/ruled/row",
        districtCode: "XX",
      },
    });
    const corner = prepared.edges!.find((e) => e.role === "side_corner")!;
    expect("kind" in corner.setback).toBe(true);
    expect("kind" in corner.setback ? corner.setback.reason : "").toContain(
      "not published for this district",
    );
    // The interior side is unaffected — this is an absence on one axis, not a
    // collapse of the layer.
    const side = prepared.edges!.find((e) => e.role === "side")!;
    expect("kind" in side.setback ? "absent" : side.setback.feet).toBe(10);
  });

  it("prints the corner on the sheet's summary line, and omits it when there is none", () => {
    expect(
      formatSetbackSummaryLine({ front: 30, side: 10, rear: 30, cornerFt: 20 }),
    ).toBe("30 / 10 / 30 ft, corner side 20 ft");
    // A district with no corner value reads exactly as it always did.
    expect(
      formatSetbackSummaryLine({ front: 30, side: 10, rear: 30, cornerFt: null }),
    ).toBe("30 / 10 / 30 ft");
    // A silent corner declares itself rather than borrowing the side number.
    expect(
      formatSetbackSummaryLine({
        front: 30,
        side: 10,
        rear: 30,
        cornerFt: 20,
        notSpecified: { sideCorner: true },
      }),
    ).toContain("corner side not specified");
  });
});

describe("P-219 leg 3 / D2 — the buildable figure does not outlive the setbacks it was baked from", () => {
  it("marks the persisted atom superseded, naming the axes that moved", async () => {
    const resolved = await resolveExportSetback({
      parcelNodeId: PARCEL,
      districtCode: "SF-1",
      jurisdictionKey: "bastrop-development-code",
      atom: repealedSetbackAtom(),
      record: liveRecord(),
    });
    // 25 -> 30, 5 -> 10, 25 -> 30, and a corner that did not exist -> 20.
    expect(resolved.supersededAtom?.atomDid).toBe(`did:hauska:setback-rule:${PARCEL}:setback:1`);
    expect(resolved.supersededAtom?.axes.sort()).toEqual(["corner", "front", "rear", "side"]);
  });

  it("does NOT mark it superseded when the followed values match the atom", async () => {
    // The negative control: this gate must be able to NOT fire, or every
    // buildable figure in the product disappears and the "fix" is an outage.
    const agreeingAtom = {
      ...repealedSetbackAtom(),
      front: 30,
      side: 10,
      rear: 30,
      sideCornerFt: 20,
      sourceCodeAtomRef: {
        atomDid: "bastrop_tx/bdc-2026-adopted/14.02.003",
        role: "rule",
        entityType: "code-section",
      },
    } as unknown as SetbackRuleAtomInstance;
    const resolved = await resolveExportSetback({
      parcelNodeId: PARCEL,
      districtCode: "SF-1",
      jurisdictionKey: "bastrop-development-code",
      atom: agreeingAtom,
      record: liveRecord(),
    });
    expect(resolved.supersededAtom).toBeUndefined();
  });
});
