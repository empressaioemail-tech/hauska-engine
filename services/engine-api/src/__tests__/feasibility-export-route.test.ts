import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";

// Mirrors dossier-export-route.test.ts's pattern exactly: the engine-core
// author is mocked here to pin the ROUTE contract (validation, 404/410,
// artifact download) without a live network DEM fetch — the author's own
// behavior (real atom reads, real PDF bytes) is covered in engine-core
// (feasibility-author.test.ts, feasibility-model.test.ts, feasibility.test.ts).
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7 fake feasibility bytes");

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  authorParcelSitePlanExport: vi.fn(),
  authorParcelPropertyDossierExport: vi.fn(),
  authorParcelFeasibilityExport: vi.fn(
    async (opts: {
      parcelNodeId: string;
      narrativeOverride?: { text: string };
      storage: { writePropertyAtom(atom: unknown): Promise<void> };
      artifactStore: {
        put(input: { parcelNodeId: string; format: string; bytes: Uint8Array; contentType: string }): Promise<string>;
      };
    }) => {
      const ref = await opts.artifactStore.put({
        parcelNodeId: opts.parcelNodeId,
        format: "pdf-feasibility",
        bytes: FAKE_PDF,
        contentType: "application/pdf",
      });
      const atom = {
        entityType: "parcel-terrain-model",
        atomDid: `pterrain_feasibility_${opts.parcelNodeId}`,
        entityId: opts.parcelNodeId,
        parcelNodeId: opts.parcelNodeId,
        contentHash: "",
        artifacts: {
          "pdf-feasibility": {
            format: "pdf-feasibility",
            ref,
            byteCount: FAKE_PDF.byteLength,
            pageCount: 4,
            sitePlanAppended: true,
            feasibilitySectionCount: 11,
            feasibilityOpenItemCount: 6,
            narrativeIsDeterministicSkeleton: !opts.narrativeOverride,
          },
        },
      };
      await opts.storage.writePropertyAtom(atom);
      return {
        atom,
        pageCount: 4,
        feasibilityPageCount: 3,
        sitePlanAppended: true,
        sectionCount: 11,
        openItemCount: 6,
        narrativeIsDeterministicSkeleton: !opts.narrativeOverride,
      };
    },
  ),
}));

import { authorParcelFeasibilityExport } from "@hauska-engine/engine-core/site-plan";
import { buildParcelTerrainRoutes, type ReadableArtifactStore } from "../routes/parcel-terrain.js";

const parcelNodeId = "48021:47595";

function memoryArtifactStore(): ReadableArtifactStore {
  const data = new Map<string, Uint8Array>();
  return {
    async put(input) {
      const key = `memory://terrain/${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
    async get(ref) {
      return data.get(ref) ?? null;
    },
  };
}

const nullResolver = { async resolve() { return null; } };

describe("feasibility-export routes", () => {
  beforeEach(() => {
    vi.mocked(authorParcelFeasibilityExport).mockClear();
  });

  it("POST refresh: 400 on an invalid body (never falls through to the author on bad input)", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolutionMeters: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    expect(authorParcelFeasibilityExport).not.toHaveBeenCalled();
  });

  it("POST refresh: 201, records the artifact, forwards narrativeOverride through verbatim", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const body = {
      address: "1009 Chestnut St, Bastrop, TX",
      countyName: "Bastrop County",
      narrativeOverride: { text: "A generated narrative.", generatedBy: "test-llm", generatedAt: "2026-09-04T00:00:00Z" },
    };
    const res = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const responseBody = (await res.json()) as Record<string, unknown>;
    expect(responseBody.sectionCount).toBe(11);
    expect(responseBody.openItemCount).toBe(6);
    expect(responseBody.narrativeIsDeterministicSkeleton).toBe(false);
    expect((responseBody.artifacts as Record<string, { format: string }>)["pdf-feasibility"]!.format).toBe("pdf-feasibility");

    expect(authorParcelFeasibilityExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelFeasibilityExport).mock.calls[0]![0]!;
    expect(call.narrativeOverride).toEqual(body.narrativeOverride);
    expect(call.descriptor).toEqual({ address: body.address, countyName: body.countyName });
  });

  it("GET download: 404 when no parcel-terrain-model atom exists yet", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(404);
  });

  it("GET download: real bytes round-trip after a refresh, Content-Type application/pdf", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await app.request(`/${parcelNodeId}/feasibility-export/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain("%PDF-1.7 fake feasibility bytes");
  });

  it("POST refresh: the author's honest failure (no resolvable site plan) surfaces as 422, not a fabricated success", async () => {
    vi.mocked(authorParcelFeasibilityExport).mockRejectedValueOnce(
      new Error("Feasibility report requires a resolvable site plan; none was available: parcel geometry could not be resolved for this parcel"),
    );
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/feasibility-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("feasibility_export_failed");
    expect(body.message).toContain("resolvable site plan");
  });
});
