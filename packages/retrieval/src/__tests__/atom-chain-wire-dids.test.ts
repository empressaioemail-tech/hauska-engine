/**
 * PR-3 — getPropertyAtomChain wires DIDs onto every served slot.
 * zoningFact / setbackRule / buildableEnvelope are guaranteed atomDid
 * (backfilled when the stored row predates the field, same fallback the
 * atoms-list mapper already used); sourceCitation / sourceCodeAtomRef pass
 * through as-is when present, absent otherwise (honest, never invented).
 */

import { describe, expect, it } from "vitest";

import type { PropertyAtomInstance, StoredAtomInstance } from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

const PARCEL = "48021:141364";

function writeAtom(storage: InMemoryStorage, body: Record<string, unknown>) {
  return storage.writePropertyAtom(body as unknown as PropertyAtomInstance);
}

describe("getPropertyAtomChain — DID + provenance wiring on served slots", () => {
  it("backfills atomDid on a legacy row that never had one, for every slot", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "SF-1",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      sourceCitation: "Bastrop GIS zoning layer",
      accessPolicy: "public-free",
      // no atomDid field — mirrors real legacy fixture rows in this repo.
    });
    await writeAtom(storage, {
      entityType: "setback-rule",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceCitation: "Setback rule for SF-1 cited to did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      sourceCodeAtomRef: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
        role: "rule",
        entityType: "code-section",
      },
      front: 30,
      side: 10,
      rear: 30,
      accessPolicy: "public-free",
      // no atomDid field.
    });
    await writeAtom(storage, {
      entityType: "buildable-envelope",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      recipeVersion: "1.0.0",
      sourceCitation: "Derived buildable envelope",
      outcome: { kind: "buildable", areaSqFt: 4000 },
      extractedAt: "2026-08-03T15:11:03.320Z",
      accessPolicy: "public-free",
      // no atomDid field.
    });

    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);

    expect(
      (chain.zoningFact as (StoredAtomInstance & { atomDid?: string }) | null)
        ?.atomDid,
    ).toBe(`did:hauska:zoning-fact:${PARCEL}`);
    expect(
      (chain.setbackRule as (StoredAtomInstance & { atomDid?: string }) | null)
        ?.atomDid,
    ).toBe(`did:hauska:setback-rule:${PARCEL}`);
    expect(
      (
        chain.buildableEnvelope as
          | (StoredAtomInstance & { atomDid?: string })
          | null
      )?.atomDid,
    ).toBe(`did:hauska:buildable-envelope:${PARCEL}`);
  });

  it("preserves an existing well-formed atomDid rather than overwriting it", async () => {
    const storage = new InMemoryStorage();
    const explicitDid = "did:hauska:zoning-fact:custom-entity-id";
    await writeAtom(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      atomDid: explicitDid,
      parcelNodeId: PARCEL,
      district: "MU",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      accessPolicy: "public-free",
    });
    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);
    expect(
      (chain.zoningFact as (StoredAtomInstance & { atomDid?: string }) | null)
        ?.atomDid,
    ).toBe(explicitDid);
  });

  it("surfaces sourceCitation and sourceCodeAtomRef on setbackRule when present, without fabricating them elsewhere", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "setback-rule",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceCitation: "Setback rule for SF-1 cited to Sec. 14.02.003",
      sourceCodeAtomRef: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
        role: "rule",
        entityType: "code-section",
      },
      front: 30,
      side: 10,
      rear: 30,
      accessPolicy: "public-free",
    });
    // buildable-envelope has no sourceCodeAtomRef on its contract shape — must
    // stay absent (honest), never inherited from setback-rule.
    await writeAtom(storage, {
      entityType: "buildable-envelope",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      sourceCitation: "Derived buildable envelope",
      outcome: { kind: "buildable", areaSqFt: 4000 },
      extractedAt: "2026-08-03T15:11:03.320Z",
      accessPolicy: "public-free",
    });

    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);

    const setbackRule = chain.setbackRule as
      | (StoredAtomInstance & {
          sourceCitation?: string;
          sourceCodeAtomRef?: { atomDid: string; role: string; entityType: string };
        })
      | null;
    expect(setbackRule?.sourceCitation).toBe(
      "Setback rule for SF-1 cited to Sec. 14.02.003",
    );
    expect(setbackRule?.sourceCodeAtomRef).toMatchObject({
      atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      role: "rule",
      entityType: "code-section",
    });

    const buildableEnvelope = chain.buildableEnvelope as
      | (StoredAtomInstance & { sourceCodeAtomRef?: unknown })
      | null;
    expect(buildableEnvelope?.sourceCodeAtomRef).toBeUndefined();
  });

  it("graceful absence: a slot instance with no sourceCodeAtomRef leaves the field undefined, not fabricated", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "IND",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      sourceCitation: "Bastrop GIS zoning layer",
      accessPolicy: "public-free",
      // No district-code-section-map hit modeled here (unmapped path) — no
      // sourceCodeAtomRef on the stored row.
    });
    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);
    const zoningFact = chain.zoningFact as
      | (StoredAtomInstance & { sourceCodeAtomRef?: unknown; atomDid?: string })
      | null;
    expect(zoningFact?.sourceCodeAtomRef).toBeUndefined();
    expect(zoningFact?.atomDid).toBe(`did:hauska:zoning-fact:${PARCEL}`);
  });

  it("atoms-list entries keep their existing did-guarantee behavior unchanged", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "GC",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      accessPolicy: "public-free",
    });
    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);
    const entry = chain.atoms.find((a) => a.type === "zoning-fact");
    expect(entry?.did).toBe(`did:hauska:zoning-fact:${PARCEL}`);
  });
});
