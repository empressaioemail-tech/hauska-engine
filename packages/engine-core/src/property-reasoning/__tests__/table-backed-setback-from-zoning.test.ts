import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";

import {
  emitTableBackedSetbackAtoms,
  promoteTableBackedSetbackIfAbsent,
  resolveCodifiedSetbacksForStamp,
} from "../table-backed-setback-from-zoning.js";

describe("resolveCodifiedSetbacksForStamp", () => {
  it("resolves Austin SF-3 scalars from austin-tx table", () => {
    expect(resolveCodifiedSetbacksForStamp("austin-tx", "SF-3")).toEqual({
      front_ft: 25,
      side_ft: 5,
      rear_ft: 10,
      side_corner_ft: 15,
    });
  });

  it("resolves Pflugerville SF-S after table port", () => {
    expect(resolveCodifiedSetbacksForStamp("pflugerville-tx", "SF-S")).toEqual({
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
    });
  });

  it("returns null for Bastrop city per-parcel-only jurisdiction", () => {
    expect(resolveCodifiedSetbacksForStamp("bastrop-city-tx", "SF-1")).toBeNull();
  });
});

describe("emitTableBackedSetbackAtoms", () => {
  it("emits setback-rule + provisional envelope for Austin SF-3 gold shape", () => {
    const result = emitTableBackedSetbackAtoms({
      parcelNodeId: "48453:TEST-AUSTIN-SF3",
      countyFips: "48453",
      district: "SF-3",
      cityKey: "austin-tx",
      zoningFactAtomDid: "did:hauska:zoning-fact:48453:TEST-AUSTIN-SF3",
      zoningAssertedConfidence: {
        estimate: 0.9,
        n: 0,
        intervalWidth: 0.12,
        provenance: "asserted",
      },
    });
    expect(result?.setbackPresent).toBe(true);
    expect(result?.envelopePresent).toBe(true);
    const setback = result?.atoms.find((a) => a.entityType === "setback-rule");
    expect(setback).toMatchObject({ front: 25, side: 5, rear: 10 });
    const envelope = result?.atoms.find(
      (a) => a.entityType === "buildable-envelope",
    );
    expect(envelope).toMatchObject({
      outcome: { kind: "provisional-front-edge" },
    });
  });
});

describe("promoteTableBackedSetbackIfAbsent", () => {
  it("writes setback when parcel has zoning-fact but no setback-rule", async () => {
    const prev = process.env.PROPERTY_ATOM_PATH;
    process.env.PROPERTY_ATOM_PATH = "1";
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom({
      entityType: "zoning-fact",
      entityId: "48453:907247",
      parcelNodeId: "48453:907247",
      atomDid: "did:hauska:zoning-fact:48453:907247",
      atomTier: "data",
      accessPolicy: "public-free",
      status: "active",
      district: "SF-R",
      sourceAdapter: "txgio-zoning-stamp:pflugerville-tx",
      sourceUrl: "https://example.test/pflugerville",
      sourceCitation: "test",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      extractedAt: "2026-08-01T00:00:00.000Z",
      evaluatedAt: "2026-08-01T00:00:00.000Z",
      contentHash: "fnv1a64:0000000000000001",
      reasoningChain: { reasoningKind: "observed" },
      verificationStatus: "machine",
      readContract: {
        axes: {
          assertedConfidence: {
            estimate: 0.9,
            n: 0,
            intervalWidth: 0.12,
            provenance: "asserted",
          },
        },
        assembledAt: "2026-08-01T00:00:00.000Z",
      },
    } as never);

    const { wrote, atomDids } = await promoteTableBackedSetbackIfAbsent(storage, {
      parcelNodeId: "48453:907247",
      countyFips: "48453",
      district: "SF-R",
      cityKey: "pflugerville-tx",
      zoningFactAtomDid: "did:hauska:zoning-fact:48453:907247",
    });
    expect(wrote).toBe(true);
    expect(atomDids.length).toBeGreaterThanOrEqual(1);

    const rows = await storage.listPropertyAtomsByParcelNodeId("48453:907247");
    expect(rows.some((r) => r.entityType === "setback-rule")).toBe(true);
    process.env.PROPERTY_ATOM_PATH = prev;
  });
});
