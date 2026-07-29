import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";

// Mirrors the site-plan-setback-gate test pattern: the engine-core author is
// mocked; these tests pin the ROUTE contract (validation, honest-degrade
// passthrough, artifact download) — the author's own behavior is covered in
// engine-core (dossier-author.test.ts).
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7 fake dossier bytes");

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  authorParcelSitePlanExport: vi.fn(),
  authorParcelPropertyDossierExport: vi.fn(
    async (opts: {
      parcelNodeId: string;
      content: Record<string, unknown>;
      setback?: unknown;
      storage: { writePropertyAtom(atom: unknown): Promise<void> };
      artifactStore: {
        put(input: { parcelNodeId: string; format: string; bytes: Uint8Array; contentType: string }): Promise<string>;
      };
    }) => {
      const ref = await opts.artifactStore.put({
        parcelNodeId: opts.parcelNodeId,
        format: "pdf-dossier",
        bytes: FAKE_PDF,
        contentType: "application/pdf",
      });
      const atom = {
        entityType: "parcel-terrain-model",
        atomDid: `pterrain_dossier_${opts.parcelNodeId}`,
        entityId: opts.parcelNodeId,
        parcelNodeId: opts.parcelNodeId,
        contentHash: "",
        artifacts: {
          "pdf-dossier": {
            format: "pdf-dossier",
            ref,
            byteCount: FAKE_PDF.byteLength,
            pageCount: 5,
            dossierPageCount: 2,
            sitePlanAppended: true,
          },
        },
      };
      await opts.storage.writePropertyAtom(atom);
      return {
        atom,
        pageCount: 5,
        dossierPageCount: 2,
        sitePlanAppended: true,
        verdictIncluded: !!(opts.content as { verdictLine?: string }).verdictLine,
        briefSectionCount: 1,
        briefFactCount: 2,
        chatSummaryIncluded: !!(opts.content as { chatSummary?: unknown }).chatSummary,
        notesIncluded: !!(opts.content as { notes?: string }).notes,
        setbackHonestAbsence: !opts.setback,
        streetHonestAbsence: true,
        zoningHonestAbsence: false,
        floodZoneHonestUnavailable: true,
      };
    },
  ),
}));

import { authorParcelPropertyDossierExport } from "@hauska-engine/engine-core/site-plan";
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

const fullBody = {
  address: "1009 Chestnut St, Bastrop, TX",
  countyName: "Bastrop County",
  verdictLine: "BUILDABLE — envelope on file",
  brief: {
    sections: [
      {
        id: "zoning",
        title: "Zoning",
        facts: [
          { label: "District", value: "P-5", source: "bastrop_tx/b3", vintage: "2026" },
          { label: "Max height" },
        ],
      },
    ],
  },
  chatSummary: { summary: "Looks buildable.", savedAt: "2026-07-25T00:00:00Z", disclaimer: "AI content" },
  notes: "call the county",
};

describe("dossier-export routes", () => {
  beforeEach(() => {
    vi.mocked(authorParcelPropertyDossierExport).mockClear();
  });

  it("POST refresh: 201, passes the request content through VERBATIM (no fabrication, no rewriting)", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/dossier-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fullBody),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pageCount).toBe(5);
    expect(body.dossierPageCount).toBe(2);
    expect(body.sitePlanAppended).toBe(true);
    expect(body.verdictIncluded).toBe(true);
    expect((body.artifacts as Record<string, { format: string }>)["pdf-dossier"]!.format).toBe("pdf-dossier");

    expect(authorParcelPropertyDossierExport).toHaveBeenCalledOnce();
    const call = vi.mocked(authorParcelPropertyDossierExport).mock.calls[0]![0]!;
    expect(call.content.verdictLine).toBe(fullBody.verdictLine);
    expect(call.content.brief).toEqual(fullBody.brief);
    expect(call.content.chatSummary).toEqual(fullBody.chatSummary);
    expect(call.content.notes).toBe(fullBody.notes);
    // No setback atom seeded → author receives undefined, never a fabricated rule.
    expect(call.setback).toBeUndefined();
  });

  it("POST refresh: 400 on contract violations (oversized notes) — server-side cap, not a silent trim", async () => {
    const storage = new InMemoryStorage();
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/dossier-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "n".repeat(4001) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(authorParcelPropertyDossierExport).not.toHaveBeenCalled();
  });

  it("GET download: 404 before any refresh, then streams application/pdf after refresh (same-instance artifact)", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = memoryArtifactStore();
    const app = buildParcelTerrainRoutes(nullResolver, storage, artifactStore);

    const missing = await app.request(`/${parcelNodeId}/dossier-export/download`);
    expect(missing.status).toBe(404);

    const refresh = await app.request(`/${parcelNodeId}/dossier-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(refresh.status).toBe(201);

    const download = await app.request(`/${parcelNodeId}/dossier-export/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain("pdf-dossier.pdf");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain("%PDF-");

    const meta = await app.request(`/${parcelNodeId}/dossier-export`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { artifacts: Record<string, { ref: string }> };
    expect(metaBody.artifacts["pdf-dossier"]!.ref).toContain("memory://");
  });

  it("passes the parcel's setback-rule atom through when one is on file (same lookup as site-plan export)", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom({
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
      front: 15,
      side: 0,
      rear: 0,
      sourceCodeAtomRef: { atomDid: "bastrop_tx/b3/6.5.003", role: "rule", entityType: "code-section" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const app = buildParcelTerrainRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/dossier-export/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const call = vi.mocked(authorParcelPropertyDossierExport).mock.calls[0]![0]!;
    expect(call.setback).toBeDefined();
    expect((call.setback as { front: number }).front).toBe(15);
  });
});
