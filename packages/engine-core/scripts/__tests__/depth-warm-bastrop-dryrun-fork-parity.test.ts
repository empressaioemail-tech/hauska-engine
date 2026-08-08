/**
 * Dry-run / apply compute-path parity — regression guard for the 2026-08-08
 * fork where readBoundaryEdgesForParcel was gated on !dryRun, making dry-run
 * incapable of emitting road-classification-mismatch (472 apply-only bucket).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BoundaryEdgeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";
import { getSetbackTable } from "@hauska-engine/adapters";

import bastropDescriptor from "../../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { computeParcelInteriorFacts } from "../../src/boundary-primitive/interior.js";
import { bucketVerifyFailReasons } from "../../src/depth-warm/honest-decline-promote.js";
import { PARCEL_28286_LIVE_TXGIO } from "../../src/depth-warm/fixtures/parcelRings.js";
import { setbackTableDescriptorFromAdapter } from "../../src/property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../src/property-reasoning/types.js";
import { warmThenVerify } from "../../src/depth-warm/warm-then-verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const bastropBatchPath = join(HERE, "../depth-warm-bastrop-batch.mjs");
const elginBatchPath = join(HERE, "../depth-warm-elgin-batch.mjs");
const caldwellBatchPath = join(HERE, "../depth-warm-caldwell-batch.mjs");
const bastropBatchSource = readFileSync(bastropBatchPath, "utf8");
const elginBatchSource = readFileSync(elginBatchPath, "utf8");
const caldwellBatchSource = readFileSync(caldwellBatchPath, "utf8");

const COUNTY_FIPS = "48021";
const PARCEL_NODE_ID = `${COUNTY_FIPS}:28286`;

function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  if (!adapterSetback) {
    throw new Error("bastrop-development-code adapter table required");
  }
  return {
    ...(bastropDescriptor as JurisdictionDescriptor),
    setbackTable: adapterSetback,
    sourceAdapter: "bastrop-per-parcel-record-layer-23",
  };
}

function buildBoundaryAtom(
  ring: typeof PARCEL_28286_LIVE_TXGIO,
  spec: {
    edgeIndex: number;
    role: BoundaryEdgeAtomInstance["role"];
    classification: BoundaryEdgeAtomInstance["facingRoad"] extends infer R
      ? R extends { classification: infer C }
        ? C
        : never
      : never;
    osmHighwayTag: string;
  },
): BoundaryEdgeAtomInstance {
  const facts = computeParcelInteriorFacts(ring);
  if (!facts) throw new Error("fixture ring has no interior facts");
  const edgeInterior = facts.edges.find((e) => e.edgeIndex === spec.edgeIndex);
  if (!edgeInterior) throw new Error(`missing edge ${spec.edgeIndex}`);

  const boundaryEdgeId = `${COUNTY_FIPS}:28286:boundary:${spec.edgeIndex}`;
  return {
    entityType: "property-boundary-edge",
    atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
    boundaryEdgeId,
    entityId: boundaryEdgeId,
    parcelNodeId: PARCEL_NODE_ID,
    countyFips: COUNTY_FIPS,
    propId: "28286",
    edgeIndex: spec.edgeIndex,
    role: spec.role,
    adjacencyKind: "ROW",
    parcelNeighborPropId: null,
    facingRoad: {
      roadNodeId: `${COUNTY_FIPS}:road:fixture`,
      classification: spec.classification,
      provenance: "osm-overpass-v1",
      osmHighwayTag: spec.osmHighwayTag,
    },
    setback: {
      feet: 15,
      provenance: "road-class-setback-table",
      atomCitation: bastropDescriptor.key,
    },
    interior: {
      ringCcw: edgeInterior.ringCcw,
      centroidInside: edgeInterior.centroidInside,
      inwardNormal: edgeInterior.inwardNormal,
      edgeEndpoints: edgeInterior.edgeEndpoints,
    },
    effectiveDate: "2026-07-27",
    status: "active",
    supersedesEntityId: null,
    reasoningChain: { reasoningKind: "observed" },
    accessPolicy: "platform-internal",
    sourceCitation: "dryrun-fork-parity fixture",
    extractedAt: "2026-07-27T00:00:00.000Z",
    atomTier: "data",
    jurisdictionTenant: bastropDescriptor.jurisdictionTenant,
    fetchedAt: "2026-07-27T00:00:00.000Z",
    sourceAdapter: "test",
    sourceUrl: "test://",
    contentHash: "fixture",
  };
}

/** Full ring boundary primitive with a deliberate road-class vs OSM-tag mismatch on front. */
function boundaryAtomsWithClassificationMismatch(): BoundaryEdgeAtomInstance[] {
  const ring = PARCEL_28286_LIVE_TXGIO;
  const facts = computeParcelInteriorFacts(ring);
  if (!facts) throw new Error("fixture ring has no interior facts");

  return facts.edges.map((edge) => {
    if (edge.edgeIndex === 2) {
      return buildBoundaryAtom(ring, {
        edgeIndex: 2,
        role: "front",
        classification: "alley",
        osmHighwayTag: "residential",
      });
    }
    const boundaryEdgeId = `${COUNTY_FIPS}:28286:boundary:${edge.edgeIndex}`;
    return {
      entityType: "property-boundary-edge",
      atomDid: buildAtomDid("property-boundary-edge", boundaryEdgeId).raw,
      boundaryEdgeId,
      entityId: boundaryEdgeId,
      parcelNodeId: PARCEL_NODE_ID,
      countyFips: COUNTY_FIPS,
      propId: "28286",
      edgeIndex: edge.edgeIndex,
      role: edge.edgeIndex === 0 ? "rear" : "side",
      adjacencyKind: edge.edgeIndex === 0 ? "unmapped" : "neighbor-parcel",
      parcelNeighborPropId: null,
      facingRoad: null,
      setback: {
        kind: "unmapped-adjacency",
        reason: "fixture",
      },
      interior: {
        ringCcw: edge.ringCcw,
        centroidInside: edge.centroidInside,
        inwardNormal: edge.inwardNormal,
        edgeEndpoints: edge.edgeEndpoints,
      },
      effectiveDate: "2026-07-27",
      status: "active",
      supersedesEntityId: null,
      reasoningChain: { reasoningKind: "observed" },
      accessPolicy: "platform-internal",
      sourceCitation: "dryrun-fork-parity fixture",
      extractedAt: "2026-07-27T00:00:00.000Z",
      atomTier: "data",
      jurisdictionTenant: bastropDescriptor.jurisdictionTenant,
      fetchedAt: "2026-07-27T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "test://",
      contentHash: "fixture",
    };
  });
}

function verifySnapshot(result: Awaited<ReturnType<typeof warmThenVerify>>) {
  const reasons = [
    ...result.verify.gates.geometry.reasons,
    ...result.verify.gates.roadClassification.reasons,
    ...result.verify.gates.setbackEdgeDistance.reasons,
    ...result.verify.gates.frontOrientation.reasons,
    ...result.verify.gates.r32PerEdgeInset.reasons,
    ...result.verify.gates.facesAnswer.reasons,
  ];
  return {
    verifyPass: result.verify.pass,
    bucket: bucketVerifyFailReasons(reasons),
    failureBuckets: {
      geometry: result.verify.gates.geometry.pass,
      roadClassification: result.verify.gates.roadClassification.pass,
      setbackEdgeDistance: result.verify.gates.setbackEdgeDistance.pass,
      frontOrientation: result.verify.gates.frontOrientation.pass,
      r32PerEdgeInset: result.verify.gates.r32PerEdgeInset.pass,
      facesAnswer: result.verify.gates.facesAnswer.pass,
    },
  };
}

describe("depth-warm batch dry-run fork parity (2026-08-08)", () => {
  it("bastrop batch loads boundary primitives in bulk before the compute loop (dry-run parity)", () => {
    expect(bastropBatchSource).toContain("bulkLoadBoundaryEdgesByParcel");
    expect(bastropBatchSource).toContain("boundaryEdgesFromBulkMap");
    const loopStart = bastropBatchSource.indexOf("for (const row of parcelRows)");
    const loopBody = bastropBatchSource.slice(loopStart);
    expect(loopBody).not.toMatch(/await readBoundaryEdgesForParcel\(/);
    expect(bastropBatchSource).not.toMatch(
      /if\s*\(\s*!dryRun\s*\)\s*\{[\s\S]*?createPgStorage/,
    );
  });

  it("elgin and caldwell sibling batches also read boundary primitive on dry-run", () => {
    for (const source of [elginBatchSource, caldwellBatchSource]) {
      expect(source).not.toMatch(
        /if\s*\(\s*!dryRun\s*&&\s*storageHandle\?\.storage\s*\)\s*\{[\s\S]*?readBoundaryEdgesForParcel/,
      );
      expect(source).toMatch(
        /if\s*\(\s*storageHandle\?\.storage\s*\)\s*\{[\s\S]*?readBoundaryEdgesForParcel/,
      );
    }
  });

  it("dry and apply warmThenVerify legs match verifyPass and failure-bucket distribution on fixture cohort", async () => {
    const descriptor = buildDescriptor();
    const boundaryEdges = boundaryAtomsWithClassificationMismatch();
    const baseInput = {
      parcelNodeId: PARCEL_NODE_ID,
      district: "SF-1",
      parcelRing: PARCEL_28286_LIVE_TXGIO,
      rawParcelRing: PARCEL_28286_LIVE_TXGIO,
      descriptor,
      roads: [],
      edgeLabels: [],
      boundaryEdges,
      zoningFactAtomDid: "did:hauska:zoning-fact:fixture",
      situsAddress: null,
    };

    const dryLeg = await warmThenVerify({
      ...baseInput,
      storage: undefined,
      promote: false,
    });
    const applyLeg = await warmThenVerify({
      ...baseInput,
      storage: {
        readPropertyAtom: async () => null,
        writePropertyAtom: async () => {
          throw new Error("apply leg must not write when verify fails");
        },
      } as never,
      promote: true,
    });

    const drySnap = verifySnapshot(dryLeg);
    const applySnap = verifySnapshot(applyLeg);

    expect(drySnap).toEqual(applySnap);
    expect(drySnap.verifyPass).toBe(false);
    expect(drySnap.bucket).toBe("road-classification-mismatch");
    expect(dryLeg.promoted).toBeNull();
    expect(applyLeg.promoted).toBeNull();
  });
});
