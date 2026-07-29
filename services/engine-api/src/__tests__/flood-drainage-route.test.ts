import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";

// Mirrors the dossier-export-route test pattern: the engine-core author is
// mocked; these tests pin the ROUTE contract (the PINNED shape the MCP/PE
// legs build against) — the author's behavior is covered in engine-core.
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7 fake flood-drainage bytes");

const FAKE_STUDY = {
  parcelNodeId: "48021:47595",
  catchmentGeoJson: { type: "FeatureCollection", features: [] },
  drainageZonesGeoJson: { type: "FeatureCollection", features: [] },
  rainfallResultGeoJson: null,
  flowLinesGeoJson: { type: "FeatureCollection", features: [] },
  rainfallDepthInches: 9.5,
  rainfallSource: "default",
  demProvenance: { source: "USGS 3DEP", resolutionMeters: 10 },
  briefing: "The modeled upstream catchment delivers runoff toward the parcel.",
  flowExits: [],
  stats: {
    catchmentAreaSqFt: 100,
    pondedAreaSqFt: null,
    pondedAreaModeledRegionSqFt: null,
    flowExitCount: 0,
    pourPoint: { lng: 0, lat: 0 },
  },
  computation: { library: "native-d8", routing: "d8", accumulationThreshold: 50 },
};

vi.mock("@hauska-engine/engine-core/site-plan", () => ({
  // parcel-terrain.ts (module under the same package export) imports these:
  authorParcelSitePlanExport: vi.fn(),
  authorParcelPropertyDossierExport: vi.fn(),
  authorParcelFloodDrainageReport: vi.fn(
    async (opts: {
      parcelNodeId: string;
      rainfallDepthInches?: number;
      descriptor?: { address?: string; countyName?: string };
      storage: { writePropertyAtom(atom: unknown): Promise<void> };
      artifactStore: {
        put(input: { parcelNodeId: string; format: string; bytes: Uint8Array; contentType: string }): Promise<string>;
      };
    }) => {
      const pdfRef = await opts.artifactStore.put({
        parcelNodeId: opts.parcelNodeId,
        format: "pdf-flood-drainage",
        bytes: FAKE_PDF,
        contentType: "application/pdf",
      });
      const study = {
        ...FAKE_STUDY,
        parcelNodeId: opts.parcelNodeId,
        ...(opts.rainfallDepthInches
          ? { rainfallDepthInches: opts.rainfallDepthInches, rainfallSource: "parameter" }
          : {}),
      };
      const studyBytes = new TextEncoder().encode(JSON.stringify(study));
      const studyRef = await opts.artifactStore.put({
        parcelNodeId: opts.parcelNodeId,
        format: "json-flood-drainage-study",
        bytes: studyBytes,
        contentType: "application/json",
      });
      const atom = {
        entityType: "parcel-terrain-model",
        atomDid: `pterrain_flood_${opts.parcelNodeId}`,
        entityId: opts.parcelNodeId,
        parcelNodeId: opts.parcelNodeId,
        contentHash: "",
        artifacts: {
          "pdf-flood-drainage": {
            format: "pdf-flood-drainage",
            ref: pdfRef,
            byteCount: FAKE_PDF.byteLength,
            pageCount: 2,
            rainfallDepthInches: study.rainfallDepthInches,
            rainfallSource: study.rainfallSource,
            computationLibrary: "native-d8",
            flowExitCount: 0,
          },
          "json-flood-drainage-study": {
            format: "json-flood-drainage-study",
            ref: studyRef,
            byteCount: studyBytes.byteLength,
          },
        },
      };
      await opts.storage.writePropertyAtom(atom);
      return { atom, study, pageCount: 2, honestEmpty: false };
    },
  ),
}));

import { authorParcelFloodDrainageReport } from "@hauska-engine/engine-core/site-plan";
import { buildFloodDrainageRoutes } from "../routes/flood-drainage.js";
import { type ReadableArtifactStore } from "../routes/parcel-terrain.js";
import type { EngineApiConfig } from "../config.js";
import { buildApp } from "../server.js";

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

describe("flood-drainage routes (PINNED contract)", () => {
  beforeEach(() => {
    vi.mocked(authorParcelFloodDrainageReport).mockClear();
  });

  it("POST refresh: 201 with { data: { parcelNodeId, study, artifact } } — the pinned shape", async () => {
    const storage = new InMemoryStorage();
    const app = buildFloodDrainageRoutes(nullResolver, storage, memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "141 Old Antioch Rd, Smithville, TX",
        countyName: "Bastrop County",
        rainfallDepthInches: 8,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        parcelNodeId: string;
        study: Record<string, unknown>;
        artifact: { format: string; pageCount: number };
      };
    };
    expect(body.data.parcelNodeId).toBe(parcelNodeId);
    // The pinned study fields all present.
    expect(body.data.study).toMatchObject({
      rainfallDepthInches: 8,
      rainfallSource: "parameter",
      demProvenance: { source: "USGS 3DEP", resolutionMeters: 10 },
    });
    expect(body.data.study.catchmentGeoJson).toBeDefined();
    expect(body.data.study.drainageZonesGeoJson).toBeDefined();
    expect(body.data.study.flowLinesGeoJson).toBeDefined();
    expect("rainfallResultGeoJson" in body.data.study).toBe(true);
    expect(typeof body.data.study.briefing).toBe("string");
    expect(body.data.artifact.format).toBe("pdf-flood-drainage");
    expect(body.data.artifact.pageCount).toBe(2);

    // Parameters pass through to the author verbatim.
    const call = vi.mocked(authorParcelFloodDrainageReport).mock.calls[0]![0]!;
    expect(call.rainfallDepthInches).toBe(8);
    expect(call.descriptor).toEqual({
      address: "141 Old Antioch Rd, Smithville, TX",
      countyName: "Bastrop County",
    });
  });

  it("POST refresh: 400 on contract violations (non-positive rainfall depth)", async () => {
    const app = buildFloodDrainageRoutes(nullResolver, new InMemoryStorage(), memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rainfallDepthInches: -2 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(authorParcelFloodDrainageReport).not.toHaveBeenCalled();
  });

  it("POST refresh: 422 honest failure when the author throws (unresolvable parcel)", async () => {
    vi.mocked(authorParcelFloodDrainageReport).mockRejectedValueOnce(
      new Error("Parcel geometry unavailable for 48021:47595"),
    );
    const app = buildFloodDrainageRoutes(nullResolver, new InMemoryStorage(), memoryArtifactStore());
    const res = await app.request(`/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("flood_drainage_refresh_failed");
    expect(body.message).toContain("geometry unavailable");
  });

  it("GET study: 404 before refresh, then returns the CACHED study JSON (the PE dock read)", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = memoryArtifactStore();
    const app = buildFloodDrainageRoutes(nullResolver, storage, artifactStore);

    const missing = await app.request(`/${parcelNodeId}/flood-drainage/study`);
    expect(missing.status).toBe(404);

    const refresh = await app.request(`/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(refresh.status).toBe(201);

    const res = await app.request(`/${parcelNodeId}/flood-drainage/study`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { parcelNodeId: string; study: Record<string, unknown> } };
    expect(body.data.parcelNodeId).toBe(parcelNodeId);
    expect(body.data.study.rainfallSource).toBe("default");
    expect(body.data.study.briefing).toContain("catchment");
  });

  it("GET download: 400 on wrong format, 404 before refresh, then streams application/pdf", async () => {
    const storage = new InMemoryStorage();
    const artifactStore = memoryArtifactStore();
    const app = buildFloodDrainageRoutes(nullResolver, storage, artifactStore);

    const badFormat = await app.request(`/${parcelNodeId}/flood-drainage/download?format=pdf-site-plan`);
    expect(badFormat.status).toBe(400);
    const noFormat = await app.request(`/${parcelNodeId}/flood-drainage/download`);
    expect(noFormat.status).toBe(400);

    const missing = await app.request(
      `/${parcelNodeId}/flood-drainage/download?format=pdf-flood-drainage`,
    );
    expect(missing.status).toBe(404);

    await app.request(`/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const download = await app.request(
      `/${parcelNodeId}/flood-drainage/download?format=pdf-flood-drainage`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toContain("flood-drainage.pdf");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toContain("%PDF-");
  });

  it("gate front: the routes only accept gate-proxied calls (401 without gate-front headers)", async () => {
    const config: EngineApiConfig = {
      port: 8080,
      gateServiceToken: "test-gate-token",
      startedAt: "2026-07-29T00:00:00.000Z",
      gateContextSigningKey: "",
      gateContextMode: "off",
    };
    const app = buildApp({ config });
    const res = await app.request(`/v1/property-nodes/${parcelNodeId}/flood-drainage/refresh`, {
      method: "POST",
      headers: { Authorization: "Bearer test-gate-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("gate_front_context_required");
  });
});
