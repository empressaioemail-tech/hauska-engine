/**
 * FIX 3 (2026-08-06 dispatch): promote must fail closed on the shared
 * envelope ground-truth predicate, INDEPENDENT of mechanical verify. This
 * is the direct answer to the process-retro's R2 candidate (e) finding:
 * mechanical verify and serveTruthEdgeLabels both agreed on 48021:31308
 * while the actual served geometry leaked outside the parcel — no gate in
 * the promote path asserted containment before this fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import { getSetbackTable } from "@hauska-engine/adapters";

import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { setbackTableDescriptorFromAdapter } from "../../property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { computeWarmCandidate } from "../warm-compute.js";
import {
  promoteDepthWarmToStorage,
  EnvelopeGroundTruthPromoteDeclineError,
} from "../promote.js";

function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  if (!adapterSetback) {
    throw new Error("bastrop-development-code adapter table required");
  }
  const base = bastropDescriptor as JurisdictionDescriptor;
  return { ...base, setbackTable: adapterSetback };
}

const descriptor = buildDescriptor();
const PARCEL_ID = "48021:99001";

describe("promoteDepthWarmToStorage — FIX 3 ground-truth fail-closed gate", () => {
  const priorPropertyAtomPath = process.env.PROPERTY_ATOM_PATH;

  beforeEach(() => {
    process.env.PROPERTY_ATOM_PATH = "1";
  });

  afterEach(() => {
    if (priorPropertyAtomPath === undefined) delete process.env.PROPERTY_ATOM_PATH;
    else process.env.PROPERTY_ATOM_PATH = priorPropertyAtomPath;
  });

  it("refuses to persist a candidate whose insetRing leaks outside the parcel ring", async () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const labels = [
      { index: 0, label: "front" as const, roadClass: "residential" as const, osmHighwayTag: "residential" },
      { index: 1, label: "side" as const },
      { index: 2, label: "rear" as const },
      { index: 3, label: "side" as const },
    ];
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: ring,
      descriptor,
      roads: [
        {
          osmWayId: 1,
          osmHighwayTag: "residential",
          name: "Test Rd",
          classification: "residential",
          polyline: [
            [-97.3205, 30.1099],
            [-97.3195, 30.1099],
          ],
        },
      ],
      edgeLabels: labels,
    });
    expect(candidate.empty).toBe(false);
    expect(candidate.insetRing).not.toBeNull();

    // Tamper: shift the inset ring east so it leaks outside the parcel —
    // mirrors the operator-observed 31308 leak (2 of 4 inset vertices
    // outside the true parcel ring), independent of any label/count issue.
    const leakedInsetRing = candidate.insetRing!.map(
      ([lng, lat]) => [lng + 0.001, lat] as [number, number],
    );
    const tampered = { ...candidate, insetRing: leakedInsetRing };

    const storage = new InMemoryStorage();
    await expect(
      promoteDepthWarmToStorage(storage, {
        candidate: tampered,
        descriptor,
        zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
      }),
    ).rejects.toThrow(EnvelopeGroundTruthPromoteDeclineError);

    // Nothing persisted — fail-closed, no partial write.
    const stored = await storage.listBoundaryEdgesByParcelNodeId(PARCEL_ID);
    expect(stored.length).toBe(0);
  });

  it("persists normally when the candidate passes the ground-truth predicate", async () => {
    const ring: [number, number][] = [
      [-97.32, 30.11],
      [-97.31975, 30.11],
      [-97.31975, 30.1103],
      [-97.32, 30.1103],
      [-97.32, 30.11],
    ];
    const labels = [
      { index: 0, label: "front" as const, roadClass: "residential" as const, osmHighwayTag: "residential" },
      { index: 1, label: "side" as const },
      { index: 2, label: "rear" as const },
      { index: 3, label: "side" as const },
    ];
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: ring,
      descriptor,
      roads: [
        {
          osmWayId: 1,
          osmHighwayTag: "residential",
          name: "Test Rd",
          classification: "residential",
          polyline: [
            [-97.3205, 30.1099],
            [-97.3195, 30.1099],
          ],
        },
      ],
      edgeLabels: labels,
    });
    expect(candidate.empty).toBe(false);

    const storage = new InMemoryStorage();
    const result = await promoteDepthWarmToStorage(storage, {
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
    });
    expect(result.boundaryEdgeAtomDids.length).toBeGreaterThan(0);

    const stored = await storage.listBoundaryEdgesByParcelNodeId(PARCEL_ID);
    expect(stored.length).toBeGreaterThan(0);
  });
});
