import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  // P-219: the site-plan and dossier export routes now construct the one
  // reader unconditionally, exactly as the feasibility route already did.
  // RETRIEVAL_API_URL/KEY are unset in this test so the real
  // `recordReaderFromEnv` would return undefined anyway — but the mock must
  // still export the NAME or the module import fails before any assertion,
  // which is the same failure mode this file's sibling already documents.
  recordReaderFromEnv: vi.fn(() => undefined),
  // parcel-terrain.ts also imports the dossier author; the mock must define
  // it or Vitest refuses the import (unused in these tests).
  authorParcelPropertyDossierExport: vi.fn(),
  authorParcelSitePlanExport: vi.fn(
    async (opts: { parcelNodeId: string; setback?: { front: number } }) => ({
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
      // Honest-absent when the route passed no setback atom (2026-07-27 change).
      setbackHonestAbsence: !opts.setback,
      streetHonestAbsence: true,
      zoningHonestAbsence: false,
      floodZoneHonestUnavailable: true,
      pdfPageCount: 1,
      // Prove the author received the real atom (incl. silent axes) when present,
      // and undefined (not a fabricated setback) when absent.
      _echoFront: opts.setback?.front ?? null,
    }),
  ),
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

/** P-240 (OPS-24, 2026-09-15): refresh is now asynchronous — mirrors
 * waitForJobSettled in feasibility-export-route.test.ts. Polls
 * GET .../site-plan-export until the job reaches a terminal state. */
async function waitForJobSettled(
  app: ReturnType<typeof buildParcelTerrainRoutes>,
  id: string,
  maxAttempts = 50,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await app.request(`/${id}/site-plan-export`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.state === "ready" || body.state === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`site-plan-export job for ${id} did not settle within ${maxAttempts} polls`);
}

describe("site-plan setback gate", () => {
  beforeEach(() => {
    vi.mocked(authorParcelSitePlanExport).mockClear();
  });

  it("exports honest-absent (ready, NOT failed) when no setback-rule atom exists (2026-07-27 operator requirement)", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(
      { async resolve() { return null; } },
      storage,
    );
    const refreshRes = await app.request(
      `/${parcelMissing}/site-plan-export/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    // The whole sheet still exports; the setback layer is honest-absent, never a
    // failed job and never a fabricated F/S/R.
    expect(refreshRes.status).toBe(202);
    const settled = await waitForJobSettled(app, parcelMissing);
    expect(settled.state).toBe("ready");
    const result = settled.result as { setbackHonestAbsence?: boolean };
    expect(result.setbackHonestAbsence).toBe(true);
    // The author was called with NO setback atom (undefined) — nothing fabricated.
    expect(authorParcelSitePlanExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelSitePlanExport).mock.calls[0]![0]!;
    expect(call.setback).toBeUndefined();
  });

  it("allows export when atom exists with not_specified side/rear (no false refusal)", async () => {
    const storage = new InMemoryStorage();
    await seedSetback(storage, parcelWithSetback);
    const app = buildParcelTerrainRoutes(
      { async resolve() { return null; } },
      storage,
    );
    const refreshRes = await app.request(
      `/${parcelWithSetback}/site-plan-export/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(refreshRes.status).toBe(202);
    await waitForJobSettled(app, parcelWithSetback);
    expect(authorParcelSitePlanExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelSitePlanExport).mock.calls[0]![0]!;
    expect(call.setback).toBeDefined();
    const setback = call.setback!;
    expect(setback.front).toBe(15);
    expect(setback.side).toBe(0);
    expect(setback.rear).toBe(0);
    const sideProv = (setback as { fieldProvenance?: { side?: { notSpecified?: boolean } } })
      .fieldProvenance?.side;
    expect(sideProv?.notSpecified).toBe(true);
  });
});
