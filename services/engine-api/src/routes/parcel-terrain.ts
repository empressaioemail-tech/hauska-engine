import { Hono } from "hono";
import { z } from "zod";

import { InMemoryStorage } from "@hauska-engine/storage";
import {
  authorParcelTerrainExport,
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

/**
 * Engine-api has no configured place-store client yet. The route therefore
 * accepts the documented bboxOverride for operator tests and reports an honest
 * geometry-unavailable error for parcel-only calls until its resolver is wired.
 */
export function buildParcelTerrainRoutes(
  resolver: ParcelGeometryResolver = { resolve: async () => null },
  storage = new InMemoryStorage(),
  artifactStore = new MemoryArtifactStore(),
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
