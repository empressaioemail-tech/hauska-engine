/**
 * MCP1 — parcel-keyed list + atom-chain widen (flood-hazard-fact, owner-fact).
 */

import { describe, expect, it } from "vitest";

import {
  PARCEL_KEYED_PROPERTY_ENTITY_TYPES,
  PROPERTY_ENTITY_TYPES,
  type PropertyAtomInstance,
} from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

const PARCEL = "48021:999001";

function writeAtom(storage: InMemoryStorage, body: Record<string, unknown>) {
  return storage.writePropertyAtom(body as unknown as PropertyAtomInstance);
}

describe("PARCEL_KEYED_PROPERTY_ENTITY_TYPES", () => {
  it("derives from PROPERTY_ENTITY_TYPES and excludes road-node only", () => {
    expect(PARCEL_KEYED_PROPERTY_ENTITY_TYPES).not.toContain("road-node");
    expect(PROPERTY_ENTITY_TYPES).toContain("road-node");
    expect(PARCEL_KEYED_PROPERTY_ENTITY_TYPES.length).toBe(
      PROPERTY_ENTITY_TYPES.length - 1,
    );
    for (const t of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
      expect(PROPERTY_ENTITY_TYPES).toContain(t);
    }
  });
});

describe("getPropertyAtomChain — atomsByType parcel-keyed widen", () => {
  it("lists flood-hazard-fact and owner-fact on chain when stored", async () => {
    const storage = new InMemoryStorage();
    await writeAtom(storage, {
      entityType: "flood-hazard-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      accessPolicy: "public-free",
      status: "active",
      inFloodplain: false,
    });
    await writeAtom(storage, {
      entityType: "owner-fact",
      entityId: `${PARCEL}:2025`,
      parcelNodeId: PARCEL,
      accessPolicy: "public-paid",
      status: "active",
      taxYear: 2025,
      ownerName: "Stub Owner",
    });
    const listed = await storage.listPropertyAtomsByParcelNodeId(PARCEL);
    const types = listed.map((r) => r.entityType).sort();
    expect(types).toContain("flood-hazard-fact");
    expect(types).toContain("owner-fact");
    expect(types).not.toContain("road-node");

    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getPropertyAtomChain(PARCEL);

    for (const entityType of PARCEL_KEYED_PROPERTY_ENTITY_TYPES) {
      expect(chain.atomsByType).toHaveProperty(entityType);
    }
    expect(chain.atomsByType["road-node"]).toBeUndefined();
    expect(chain.atomsByType["flood-hazard-fact"]?.entityType).toBe(
      "flood-hazard-fact",
    );
    expect(chain.atomsByType["owner-fact"]?.entityType).toBe("owner-fact");
    expect(
      chain.atoms.some((a) => a.type === "flood-hazard-fact"),
    ).toBe(true);
    expect(chain.atoms.some((a) => a.type === "owner-fact")).toBe(true);
  });
});
