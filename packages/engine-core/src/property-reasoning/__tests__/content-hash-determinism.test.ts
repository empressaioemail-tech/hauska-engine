/**
 * A6 — determinism: timestamp out of content-hash (Phase A foundation).
 *
 * Engines must be deterministic: same frozen inputs -> same outputs, so the
 * whole state can be rewarmed on any recipe improvement. warmAt/extractedAt/
 * fetchedAt/promotedAt are PROVENANCE, not content — two rewarms of identical
 * inputs at different wall-clock times must produce the SAME content hash.
 */

import { describe, expect, it } from "vitest";

import { getSetbackTable } from "@hauska-engine/adapters";

import bastropDescriptor from "../fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  contentHashExcludingTimestamps,
  stripTimestampsForHash,
} from "../confidence.js";
import { setbackTableDescriptorFromAdapter } from "../setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../types.js";
import { PARCEL_714_SPRING_33512 } from "../../depth-warm/fixtures/parcelRings.js";
import { edgeLabels714SpringHonest } from "../../depth-warm/fixtures/edgeLabels714Spring.js";
import { emitDepthWarmPromotion } from "../../depth-warm/promote.js";
import { computeWarmCandidate } from "../../depth-warm/warm-compute.js";

function buildDescriptor(): JurisdictionDescriptor {
  const adapterSetback = setbackTableDescriptorFromAdapter(
    getSetbackTable("bastrop-development-code"),
  );
  if (!adapterSetback) {
    throw new Error("bastrop-development-code adapter table required");
  }
  const base = bastropDescriptor as JurisdictionDescriptor;
  return {
    ...base,
    setbackTable: adapterSetback,
  };
}

const descriptor = buildDescriptor();
const PARCEL_ID = "48021:33512";
const SPRING_ROAD = {
  osmWayId: 123456789,
  osmHighwayTag: "residential",
  name: "Spring Street",
  classification: "residential" as const,
  polyline: [
    [-97.3188, 30.1102],
    [-97.3182, 30.1105],
    [-97.3176, 30.1108],
  ] as [number, number][],
};

describe("stripTimestampsForHash / contentHashExcludingTimestamps (A6 unit)", () => {
  it("strips timestamp keys at any nesting depth", () => {
    const value = {
      a: 1,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      nested: {
        extractedAt: "2026-01-01T00:00:00.000Z",
        b: 2,
        deeper: { assembledAt: "x", assertedAt: "y", keep: 3 },
      },
      versionStamp: "foo:1:2026-01-01T00:00:00.000Z",
      contentHash: "should-not-survive-either",
    };
    const stripped = stripTimestampsForHash(value);
    expect(stripped).toEqual({
      a: 1,
      nested: { b: 2, deeper: { keep: 3 } },
    });
  });

  it("two objects identical except timestamp values hash equal", () => {
    const a = {
      geometry: [1, 2, 3],
      district: "SF-1",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      extractedAt: "2026-01-01T00:00:00.000Z",
      readContract: { assembledAt: "2026-01-01T00:00:00.000Z", axes: { x: 1 } },
    };
    const b = {
      ...a,
      fetchedAt: "2026-06-15T12:34:56.000Z",
      extractedAt: "2026-06-15T12:34:56.000Z",
      readContract: { assembledAt: "2026-06-15T12:34:56.000Z", axes: { x: 1 } },
    };
    expect(contentHashExcludingTimestamps(a)).toBe(contentHashExcludingTimestamps(b));
  });

  it("two objects differing in real content hash differently", () => {
    const a = { district: "SF-1", fetchedAt: "2026-01-01T00:00:00.000Z" };
    const b = { district: "MU", fetchedAt: "2026-01-01T00:00:00.000Z" };
    expect(contentHashExcludingTimestamps(a)).not.toBe(
      contentHashExcludingTimestamps(b),
    );
  });
});

describe("promoted atom content hash is rewarm-deterministic (A6 integration)", () => {
  it("two promotions of identical warm content at different extractedAt hash equal", () => {
    const candidate = computeWarmCandidate({
      parcelNodeId: PARCEL_ID,
      district: "SF-1",
      parcelRing: PARCEL_714_SPRING_33512,
      descriptor,
      roads: [SPRING_ROAD],
      edgeLabels: edgeLabels714SpringHonest(),
    });

    const atomsEarly = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
      extractedAt: "2026-01-01T00:00:00.000Z",
    });
    const atomsLate = emitDepthWarmPromotion({
      candidate,
      descriptor,
      zoningFactAtomDid: `did:hauska:zoning-fact:${PARCEL_ID}`,
      extractedAt: "2026-12-31T23:59:59.000Z",
    });

    const envEarly = atomsEarly.find((a) => a.entityType === "buildable-envelope")!;
    const envLate = atomsLate.find((a) => a.entityType === "buildable-envelope")!;
    expect(envEarly.contentHash).toBeTruthy();
    expect(envEarly.contentHash).toBe(envLate.contentHash);
    // Sanity: the atoms really did carry different provenance timestamps.
    expect(
      (envEarly as { extractedAt?: string }).extractedAt,
    ).not.toBe((envLate as { extractedAt?: string }).extractedAt);

    const setbackEarly = atomsEarly.find((a) => a.entityType === "setback-rule")!;
    const setbackLate = atomsLate.find((a) => a.entityType === "setback-rule")!;
    expect(setbackEarly.contentHash).toBeTruthy();
    expect(setbackEarly.contentHash).toBe(setbackLate.contentHash);
  });
});
