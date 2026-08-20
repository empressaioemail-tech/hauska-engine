/**
 * W-30 — chain wire must not synthesize accessPolicy as public-free.
 *
 * The two serving mappers (getPropertyAtomChain / getRoadAtomChain) used
 * `payload.accessPolicy ?? "public-free"`. An atom carrying no policy was
 * served as the most permissive ADR-017 value. listJurisdictions is a
 * separate, declared exception and is not under test here.
 */

import { describe, expect, it } from "vitest";

import type {
  PropertyAtomInstance,
  RoadNodeAtomInstance,
} from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

const PARCEL = "48021:w30-policy";
const ROAD_ID = "48021:road:9001";

function writeProperty(
  storage: InMemoryStorage,
  body: Record<string, unknown>,
) {
  return storage.writePropertyAtom(body as unknown as PropertyAtomInstance);
}

function writeRoad(storage: InMemoryStorage, body: Record<string, unknown>) {
  return storage.writeRoadAtom(body as unknown as RoadNodeAtomInstance);
}

function assertOmittedNotPublicFree(entry: { accessPolicy?: string } | undefined) {
  expect(entry).toBeDefined();
  expect(entry!.accessPolicy).not.toBe("public-free");
  expect(entry!.accessPolicy).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(entry, "accessPolicy")).toBe(
    false,
  );
}

describe("getPropertyAtomChain — accessPolicy fail-closed (W-30)", () => {
  it("field absent: atoms[] does not emerge as public-free", async () => {
    const storage = new InMemoryStorage();
    await writeProperty(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "SF-1",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      // accessPolicy omitted
    });
    const chain = await new HybridRetrieval(storage).getPropertyAtomChain(
      PARCEL,
    );
    const entry = chain.atoms.find((a) => a.type === "zoning-fact");
    assertOmittedNotPublicFree(entry);
    expect(
      (entry!.payload as { accessPolicy?: unknown }).accessPolicy,
    ).toBeUndefined();
  });

  it("field explicitly undefined: atoms[] does not emerge as public-free", async () => {
    const storage = new InMemoryStorage();
    await writeProperty(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "MU",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      accessPolicy: undefined,
    });
    const chain = await new HybridRetrieval(storage).getPropertyAtomChain(
      PARCEL,
    );
    assertOmittedNotPublicFree(
      chain.atoms.find((a) => a.type === "zoning-fact"),
    );
  });

  it("field explicitly null: atoms[] does not emerge as public-free", async () => {
    const storage = new InMemoryStorage();
    await writeProperty(storage, {
      entityType: "zoning-fact",
      entityId: PARCEL,
      parcelNodeId: PARCEL,
      district: "GC",
      sourceAdapter: "txgio-zoning-stamp:bastrop-city-tx",
      accessPolicy: null,
    });
    const chain = await new HybridRetrieval(storage).getPropertyAtomChain(
      PARCEL,
    );
    assertOmittedNotPublicFree(
      chain.atoms.find((a) => a.type === "zoning-fact"),
    );
  });

  it("explicit public-paid is copied, not widened to public-free", async () => {
    const storage = new InMemoryStorage();
    await writeProperty(storage, {
      entityType: "owner-fact",
      entityId: `${PARCEL}:2025`,
      parcelNodeId: PARCEL,
      accessPolicy: "public-paid",
      status: "active",
      taxYear: 2025,
      ownerName: "Stub Owner",
    });
    const chain = await new HybridRetrieval(storage).getPropertyAtomChain(
      PARCEL,
    );
    const entry = chain.atoms.find((a) => a.type === "owner-fact");
    expect(entry?.accessPolicy).toBe("public-paid");
  });
});

describe("getRoadAtomChain — accessPolicy fail-closed (W-30)", () => {
  it("field absent: atoms[] does not emerge as public-free", async () => {
    const storage = new InMemoryStorage();
    await writeRoad(storage, {
      entityType: "road-node",
      entityId: ROAD_ID,
      roadNodeId: ROAD_ID,
      // accessPolicy omitted
    });
    const chain = await new HybridRetrieval(storage).getRoadAtomChain(ROAD_ID);
    expect(chain.atoms).toHaveLength(1);
    assertOmittedNotPublicFree(chain.atoms[0]);
  });

  it("field explicitly null: atoms[] does not emerge as public-free", async () => {
    const storage = new InMemoryStorage();
    await writeRoad(storage, {
      entityType: "road-node",
      entityId: ROAD_ID,
      roadNodeId: ROAD_ID,
      accessPolicy: null,
    });
    const chain = await new HybridRetrieval(storage).getRoadAtomChain(ROAD_ID);
    assertOmittedNotPublicFree(chain.atoms[0]);
  });

  it("explicit public-free is copied when the atom actually carries it", async () => {
    const storage = new InMemoryStorage();
    await writeRoad(storage, {
      entityType: "road-node",
      entityId: ROAD_ID,
      roadNodeId: ROAD_ID,
      accessPolicy: "public-free",
    });
    const chain = await new HybridRetrieval(storage).getRoadAtomChain(ROAD_ID);
    expect(chain.atoms[0]?.accessPolicy).toBe("public-free");
  });
});
