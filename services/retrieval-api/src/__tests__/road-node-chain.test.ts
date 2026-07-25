import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import { HybridRetrieval } from "@hauska-engine/retrieval";

import {
  bastropRoadIntakeDescriptor,
  emitRoadNode,
  parseOsmWayElement,
} from "@hauska-engine/engine-core/road-intake";

const SPRING_STREET_ELEMENT = {
  type: "way" as const,
  id: 123456789,
  tags: { highway: "residential", name: "Spring Street" },
  geometry: [
    { lat: 30.1102, lon: -97.3188 },
    { lat: 30.1105, lon: -97.3182 },
  ],
};

describe("GET /road-nodes/:roadNodeId/atom-chain (R1)", () => {
  it("returns road-node atom for Bastrop Spring Street", async () => {
    const storage = new InMemoryStorage();
    const descriptor = bastropRoadIntakeDescriptor();
    const obs = parseOsmWayElement(SPRING_STREET_ELEMENT, "2026-07-25T12:00:00.000Z");
    expect(obs).not.toBeNull();
    const atom = emitRoadNode(descriptor, obs!);
    await storage.writeRoadAtom(atom);

    const retrieval = new HybridRetrieval(storage);
    const chain = await retrieval.getRoadAtomChain("48021:road:123456789");
    expect(chain.roadNodeId).toBe("48021:road:123456789");
    expect(chain.roadNode).not.toBeNull();
    expect(chain.atoms).toHaveLength(1);
    expect((chain.roadNode as { displayName?: string }).displayName).toBe("Spring Street");
  });
});

describe("buildApp road route validation", () => {
  it("rejects malformed roadNodeId", async () => {
    const { buildApp } = await import("../server.js");
    const app = buildApp({ apiKey: "", substrateDatabaseUrl: "" });
    const res = await app.request("/road-nodes/48021:33512/atom-chain");
    expect(res.status).toBe(400);
  });
});
