import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  authorParcelSitePlanExport: vi.fn(async (opts: { parcelNodeId: string; setback: { front: number } }) => ({
    atom: {
      entityType: "parcel-terrain-model",
      parcelNodeId: opts.parcelNodeId,
      artifacts: {
        "dxf-site-plan": { ref: "memory://dxf", contentType: "application/dxf" },
        "ifc-site-plan": { ref: "memory://ifc", contentType: "application/step" },
        "pdf-site-plan": { ref: "memory://pdf", contentType: "application/pdf" },
      },
    },
    setbackDegenerate: false,
    streetHonestAbsence: true,
    zoningHonestAbsence: false,
    floodZoneHonestUnavailable: true,
    pdfPageCount: 1,
    // Prove the author received the real atom (incl. silent axes), not a fabricated setback.
    _echoFront: opts.setback.front,
  })),
}));

import { authorParcelSitePlanExport } from "@hauska-engine/engine-core/site-plan";
import { buildParcelTerrainRoutes } from "../routes/parcel-terrain.js";

const parcelWithSetback = "48021:47595";
const parcelMissing = "48021:999999";

async function seedSetback(storage: InMemoryStorage, parcelNodeId: string): Promise<void> {
  const atom = {
    entityType: "setback-rule",
    atomDid: `bastrop_tx/setback/${parcelNodeId}/1`,
    entityId: `${parcelNodeId}:setback:1`,
    jurisdictionTenant: "breadth_48021_bastrop",
    parcelNodeId,
    fetchedAt: new Date().toISOString(),
    extractedAt: new Date().toISOString(),
    sourceAdapter: "bastrop-b3",
    sourceUrl: "https://example.test/b3",
    sourceCitation: "P-5 setback",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `${parcelNodeId}:setback-rule:1`,
    districtCode: "P-5",
    front: 15,
    side: 0,
    rear: 0,
    sourceCodeAtomRef: {
      atomDid: "bastrop_tx/b3/6.5.003",
      role: "rule",
      entityType: "code-section",
    },
    fieldProvenance: {
      front: { atomDid: "bastrop_tx/b3/6.5.003", confidence: 0.9 },
      side: { atomDid: "bastrop_tx/b3/6.5.003", confidence: 0.8, notSpecified: true },
      rear: { atomDid: "bastrop_tx/b3/6.5.003", confidence: 0.8, notSpecified: true },
    },
  } as unknown as SetbackRuleAtomInstance;
  await storage.writePropertyAtom(atom);
}

describe("site-plan setback gate", () => {
  beforeEach(() => {
    vi.mocked(authorParcelSitePlanExport).mockClear();
  });

  it("422 setback_rule_missing only when no atom exists", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(
      { async resolve() { return null; } },
      storage,
    );
    const res = await app.request(
      `/${parcelMissing}/site-plan-export/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("setback_rule_missing");
    expect(authorParcelSitePlanExport).not.toHaveBeenCalled();
  });

  it("allows export when atom exists with not_specified side/rear (no false refusal)", async () => {
    const storage = new InMemoryStorage();
    await seedSetback(storage, parcelWithSetback);
    const app = buildParcelTerrainRoutes(
      { async resolve() { return null; } },
      storage,
    );
    const res = await app.request(
      `/${parcelWithSetback}/site-plan-export/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(201);
    expect(authorParcelSitePlanExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelSitePlanExport).mock.calls[0]![0]!;
    expect(call.setback.front).toBe(15);
    expect(call.setback.side).toBe(0);
    expect(call.setback.rear).toBe(0);
    const sideProv = call.setback.fieldProvenance?.side as
      | { notSpecified?: boolean }
      | undefined;
    expect(sideProv?.notSpecified).toBe(true);
  });
});
