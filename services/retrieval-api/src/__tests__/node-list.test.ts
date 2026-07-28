/**
 * GET /nodes — county → parcel/road node roster (CC browse; Control Tower
 * flow port). Wire shape pinned with Command Center.
 *
 * identifiers honesty: persisted property atom bodies carry NO situs address
 * and NO APN (verified against @empressaio/atom-contract/property shapes), so
 * parcel rows expose only propId; road rows expose roadName from the road-node
 * atom's displayName. q matches exactly those fields plus node_id.
 */

import { describe, expect, it } from "vitest";

import { buildAtomDid } from "@hauska-engine/atoms";
import type { ZoningFactAtomInstance } from "@hauska-engine/atoms";
import {
  InMemoryStorage,
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
} from "@hauska-engine/storage";
import {
  bastropRoadIntakeDescriptor,
  emitRoadNode,
  parseOsmWayElement,
} from "@hauska-engine/engine-core/road-intake";

import { buildApp } from "../server.js";

const HAYS_GOLD = "48209:156346";

function cloneZoningForParcel(parcelNodeId: string): ZoningFactAtomInstance {
  const base = buildHaysZoningFactProof();
  return {
    ...base,
    parcelNodeId,
    entityId: parcelNodeId,
    atomDid: buildAtomDid("zoning-fact", parcelNodeId).raw,
    contentHash: `node-list-test-${parcelNodeId}`,
  };
}

const SPRING_STREET_ELEMENT = {
  type: "way" as const,
  id: 123456789,
  tags: { highway: "residential", name: "Spring Street" },
  geometry: [
    { lat: 30.1102, lon: -97.3188 },
    { lat: 30.1105, lon: -97.3182 },
  ],
};

const UNNAMED_WAY_ELEMENT = {
  type: "way" as const,
  id: 987654321,
  tags: { highway: "unclassified" },
  geometry: [
    { lat: 30.12, lon: -97.31 },
    { lat: 30.121, lon: -97.309 },
  ],
};

async function seededParcelApp() {
  const storage = new InMemoryStorage();
  await storage.writePropertyAtom(buildHaysZoningFactProof());
  await storage.writePropertyAtom(buildHaysSetbackRuleProof());
  await storage.writePropertyAtom(buildHaysEnvelopeProof());
  await storage.writePropertyAtom(cloneZoningForParcel("48209:100001"));
  return buildApp({ storage, apiKey: "" });
}

async function seededRoadApp() {
  const storage = new InMemoryStorage();
  const descriptor = bastropRoadIntakeDescriptor();
  for (const element of [SPRING_STREET_ELEMENT, UNNAMED_WAY_ELEMENT]) {
    const obs = parseOsmWayElement(element, "2026-07-25T12:00:00.000Z");
    expect(obs).not.toBeNull();
    await storage.writeRoadAtom(emitRoadNode(descriptor, obs!));
  }
  return buildApp({ storage, apiKey: "" });
}

describe("GET /nodes param validation", () => {
  it.each([
    ["missing county", "/nodes"],
    ["short county", "/nodes?county=480"],
    ["non-numeric county", "/nodes?county=bastr"],
    ["bad nodeType", "/nodes?county=48021&nodeType=boundary"],
    ["limit 0", "/nodes?county=48021&limit=0"],
    ["limit over max", "/nodes?county=48021&limit=201"],
    ["non-numeric limit", "/nodes?county=48021&limit=abc"],
    ["negative offset", "/nodes?county=48021&offset=-1"],
    ["non-integer offset", "/nodes?county=48021&offset=1.5"],
  ])("400 on %s", async (_label, path) => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request(path);
    expect(res.status).toBe(400);
  });
});

describe("GET /nodes parcel roster", () => {
  it("lists DISTINCT parcel nodes for the county with atom families", async () => {
    const app = await seededParcelApp();
    const res = await app.request("/nodes?county=48209");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      county: string;
      nodeType: string;
      nodes: Array<{
        node_id: string;
        node_type: string;
        display_name: string | null;
        identifiers: { propId?: string; roadName?: string };
        atom_families?: string[];
      }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.available).toBe(true);
    expect(body.county).toBe("48209");
    expect(body.nodeType).toBe("parcel");
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.nodes.map((n) => n.node_id)).toEqual([
      "48209:100001",
      HAYS_GOLD,
    ]);
    const gold = body.nodes.find((n) => n.node_id === HAYS_GOLD)!;
    expect(gold.node_type).toBe("parcel");
    expect(gold.display_name).toBeNull();
    expect(gold.identifiers).toEqual({ propId: "156346" });
    expect(gold.atom_families).toEqual([
      "buildable-envelope",
      "setback-rule",
      "zoning-fact",
    ]);
  });

  it("does not leak other counties' parcels", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof()); // 48209
    await storage.writePropertyAtom(cloneZoningForParcel("48021:28286"));
    const app = buildApp({ storage, apiKey: "" });
    const res = await app.request("/nodes?county=48021");
    const body = (await res.json()) as { nodes: Array<{ node_id: string }> };
    expect(body.nodes.map((n) => n.node_id)).toEqual(["48021:28286"]);
  });
});

describe("GET /nodes road roster", () => {
  it("lists road nodes with roadName identifier from displayName", async () => {
    const app = await seededRoadApp();
    const res = await app.request("/nodes?county=48021&nodeType=road");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      nodeType: string;
      total: number;
      nodes: Array<{
        node_id: string;
        node_type: string;
        display_name: string | null;
        identifiers: { roadName?: string };
      }>;
    };
    expect(body.available).toBe(true);
    expect(body.nodeType).toBe("road");
    expect(body.total).toBe(2);
    // Named roads sort before unnamed (NULLS LAST parity with Pg).
    expect(body.nodes[0]!.node_id).toBe("48021:road:123456789");
    expect(body.nodes[0]!.node_type).toBe("road");
    expect(body.nodes[0]!.display_name).toBe("Spring Street");
    expect(body.nodes[0]!.identifiers).toEqual({ roadName: "Spring Street" });
    expect(body.nodes[1]!.node_id).toBe("48021:road:987654321");
    expect(body.nodes[1]!.display_name).toBeNull();
    expect(body.nodes[1]!.identifiers).toEqual({});
  });
});

describe("GET /nodes q search", () => {
  it("matches parcel node_id / propId substrings", async () => {
    const app = await seededParcelApp();
    const res = await app.request("/nodes?county=48209&q=156346");
    const body = (await res.json()) as {
      total: number;
      nodes: Array<{ node_id: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.nodes[0]!.node_id).toBe(HAYS_GOLD);
  });

  it("matches road displayName case-insensitively", async () => {
    const app = await seededRoadApp();
    const res = await app.request("/nodes?county=48021&nodeType=road&q=SPRING");
    const body = (await res.json()) as {
      total: number;
      nodes: Array<{ node_id: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.nodes[0]!.node_id).toBe("48021:road:123456789");
  });

  it("q with no hits on a populated county stays available (empty result, not degrade)", async () => {
    const app = await seededParcelApp();
    const res = await app.request("/nodes?county=48209&q=zzz-no-such-parcel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      total: number;
      nodes: unknown[];
    };
    expect(body.available).toBe(true);
    expect(body.total).toBe(0);
    expect(body.nodes).toEqual([]);
  });
});

describe("GET /nodes pagination", () => {
  it("pages deterministically with real total", async () => {
    const storage = new InMemoryStorage();
    for (const propId of ["100001", "100002", "100003"]) {
      await storage.writePropertyAtom(cloneZoningForParcel(`48209:${propId}`));
    }
    const app = buildApp({ storage, apiKey: "" });

    const page1 = (await (
      await app.request("/nodes?county=48209&limit=2&offset=0")
    ).json()) as { total: number; nodes: Array<{ node_id: string }>; limit: number; offset: number };
    expect(page1.total).toBe(3);
    expect(page1.limit).toBe(2);
    expect(page1.nodes.map((n) => n.node_id)).toEqual([
      "48209:100001",
      "48209:100002",
    ]);

    const page2 = (await (
      await app.request("/nodes?county=48209&limit=2&offset=2")
    ).json()) as { total: number; nodes: Array<{ node_id: string }>; offset: number };
    expect(page2.total).toBe(3);
    expect(page2.offset).toBe(2);
    expect(page2.nodes.map((n) => n.node_id)).toEqual(["48209:100003"]);
  });
});

describe("GET /nodes honest-degrade", () => {
  it("county with no data → available:false with reason", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/nodes?county=48999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      reason?: string;
      nodes: unknown[];
      total: number;
    };
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/no parcel nodes persisted for county 48999/);
    expect(body.nodes).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("county with parcels but no roads → road roster degrades honestly", async () => {
    const app = await seededParcelApp();
    const res = await app.request("/nodes?county=48209&nodeType=road");
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/no road nodes persisted for county 48209/);
  });
});

describe("route ordering — /nodes vs /nodes/:nodeId", () => {
  it("node DETAIL still resolves after the list route registration", async () => {
    const app = await seededParcelApp();
    const res = await app.request(`/nodes/${HAYS_GOLD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requested_node_id?: string;
      node?: { node_type?: string };
    };
    expect(body.requested_node_id).toBe(HAYS_GOLD);
    expect(body.node?.node_type).toBe("parcel");
  });
});
