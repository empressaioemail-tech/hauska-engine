import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import {
  buildBexarAbsenceZoningProof,
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
} from "@hauska-engine/storage";

import { buildApp } from "../server.js";

describe("GET /property-nodes/:parcelNodeId/atom-chain (Gate C)", () => {
  it("returns empty slots when no property atoms exist", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "" });
    const res = await app.request("/property-nodes/48209:156346/atom-chain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.parcelNodeId).toBe("48209:156346");
    expect(body.zoningFact).toBeNull();
    expect(body.setbackRule).toBeNull();
    expect(body.buildableEnvelope).toBeNull();
    expect(body.atoms).toEqual([]);
  });

  it("serves Hays gold chain + Bexar absence atom (not I-2)", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof());
    await storage.writePropertyAtom(buildHaysSetbackRuleProof());
    await storage.writePropertyAtom(buildHaysEnvelopeProof());
    await storage.writePropertyAtom(buildBexarAbsenceZoningProof());

    const app = buildApp({ storage, apiKey: "" });

    const hays = await app.request("/property-nodes/48209:156346/atom-chain");
    expect(hays.status).toBe(200);
    const haysBody = (await hays.json()) as {
      zoningFact: { district?: string } | null;
      setbackRule: { sourceCodeAtomRef?: { role?: string } } | null;
      buildableEnvelope: { reasoningChain?: { reasoningKind?: string } } | null;
      atoms: unknown[];
    };
    expect(haysBody.zoningFact?.district).toBe("RS");
    expect(haysBody.setbackRule?.sourceCodeAtomRef?.role).toBe("rule");
    expect(haysBody.buildableEnvelope?.reasoningChain?.reasoningKind).toBe(
      "derived",
    );
    expect(haysBody.atoms).toHaveLength(3);

    const bexar = await app.request("/property-nodes/48029:410119/atom-chain");
    const bexarBody = (await bexar.json()) as {
      zoningFact: { absence?: { kind?: string }; district?: string } | null;
    };
    expect(bexarBody.zoningFact?.absence?.kind).toBe("no-zoning-stamp");
    expect(bexarBody.zoningFact?.district).toBeUndefined();
    // Must not invent a fallback industrial district stamp (e.g. former I-2 shim).
    expect(bexarBody.zoningFact).not.toMatchObject({ district: expect.any(String) });

    const atomRes = await app.request(
      "/atoms/did:hauska:zoning-fact:48209:156346",
    );
    expect(atomRes.status).toBe(200);
    const atomBody = (await atomRes.json()) as {
      atom: { entityType?: string; district?: string } | null;
    };
    expect(atomBody.atom?.entityType).toBe("zoning-fact");
    expect(atomBody.atom?.district).toBe("RS");
  });
});
