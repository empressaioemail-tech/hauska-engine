import { Hono } from "hono";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InMemoryStorage } from "@hauska-engine/storage";
import {
  authorParcelTerrainExport,
  createParcelGeometryResolverFromEnv,
  type ParcelGeometryResolver,
  type TerrainArtifactStore,
} from "@hauska-engine/engine-core/parcel-terrain";

const bbox = z.object({
  westLng: z.number(), southLat: z.number(), eastLng: z.number(), northLat: z.number(),
});
const refreshBody = z.object({
  // Interim until the property-spine resolver is deployed. It is explicit,
  // never a hidden county-specific fallback.
  bboxOverride: bbox.optional(),
  resolutionMeters: z.number().positive().optional(),
  contourIntervalMeters: z.number().positive().optional(),
});

class MemoryArtifactStore implements TerrainArtifactStore {
  readonly data = new Map<string, Uint8Array>();
  async put(input: { parcelNodeId: string; format: string; bytes: Uint8Array }): Promise<string> {
    const key = `memory://terrain/${input.parcelNodeId}/${input.format}/${Date.now()}`;
    this.data.set(key, input.bytes);
    return key;
  }
}

class LocalDiskArtifactStore implements TerrainArtifactStore {
  constructor(private readonly root: string) {}
  async put(input: { parcelNodeId: string; format: string; bytes: Uint8Array }): Promise<string> {
    const safeNodeId = input.parcelNodeId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = join(this.root, safeNodeId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${input.format}-${Date.now()}`);
    await writeFile(path, input.bytes);
    return `file://${path.replace(/\\/g, "/")}`;
  }
}

function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): TerrainArtifactStore {
  // /tmp is a canary-only persistence seam. Cloud Run instances may be
  // replaced, so Gate X needs GCS wiring before artifact refs are durable.
  return env.TERRAIN_ARTIFACT_DIR
    ? new LocalDiskArtifactStore(env.TERRAIN_ARTIFACT_DIR)
    : new MemoryArtifactStore();
}

/**
 * TxGIO-backed counties resolve directly from the shared parcel store when
 * TXGIO_DATABASE_URL (or DATABASE_URL) is configured. bboxOverride remains an
 * explicit test fallback; non-TxGIO counties return an honest unresolved error.
 */
export function buildParcelTerrainRoutes(
  resolver: ParcelGeometryResolver = createParcelGeometryResolverFromEnv(),
  storage = new InMemoryStorage(),
  artifactStore = artifactStoreFromEnv(),
): Hono {
  const app = new Hono();
  app.post("/:parcelNodeId/terrain-export/refresh", async (c) => {
    const parsed = refreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    try {
      const atom = await authorParcelTerrainExport({
        parcelNodeId: c.req.param("parcelNodeId"),
        bboxOverride: parsed.data.bboxOverride,
        resolutionMeters: parsed.data.resolutionMeters,
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        resolver,
        storage,
        artifactStore,
      });
      return c.json({ atom, artifacts: atom.artifacts }, 201);
    } catch (error) {
      return c.json({ error: "terrain_export_failed", message: error instanceof Error ? error.message : String(error) }, 422);
    }
  });
  app.get("/:parcelNodeId/terrain-export", async (c) => {
    const format = c.req.query("format");
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    return c.json({
      atom,
      artifacts: format ? { [format]: atom.artifacts[format as keyof typeof atom.artifacts] } : atom.artifacts,
    });
  });
  return app;
}
