import { Hono } from "hono";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InMemoryStorage } from "@hauska-engine/storage";
import {
  authorParcelTerrainExport,
  createParcelGeometryResolverFromEnv,
  type ParcelGeometryResolver,
  type TerrainArtifactStore,
} from "@hauska-engine/engine-core/parcel-terrain";
import {
  GcsTerrainArtifactStore,
} from "../terrain/gcs-artifact-store.js";

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

const DOWNLOADABLE_FORMATS = ["glb", "ifc", "dxf-3dface", "dxf-contour"] as const;
type DownloadableFormat = (typeof DOWNLOADABLE_FORMATS)[number];

const CONTENT_TYPES: Record<DownloadableFormat, string> = {
  glb: "model/gltf-binary",
  ifc: "application/step",
  "dxf-3dface": "application/dxf",
  "dxf-contour": "application/dxf",
};

const EXTENSIONS: Record<DownloadableFormat, string> = {
  glb: "glb",
  ifc: "ifc",
  "dxf-3dface": "dxf",
  "dxf-contour": "dxf",
};

interface ReadableArtifactStore extends TerrainArtifactStore {
  get(ref: string): Promise<Uint8Array | null>;
}

export { type ReadableArtifactStore };

class MemoryArtifactStore implements ReadableArtifactStore {
  readonly data = new Map<string, Uint8Array>();
  async put(input: { parcelNodeId: string; format: string; bytes: Uint8Array }): Promise<string> {
    const key = `memory://terrain/${input.parcelNodeId}/${input.format}/${Date.now()}`;
    this.data.set(key, input.bytes);
    return key;
  }
  async get(ref: string): Promise<Uint8Array | null> {
    return this.data.get(ref) ?? null;
  }
}

class LocalDiskArtifactStore implements ReadableArtifactStore {
  constructor(private readonly root: string) {}
  async put(input: { parcelNodeId: string; format: string; bytes: Uint8Array }): Promise<string> {
    const safeNodeId = input.parcelNodeId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = join(this.root, safeNodeId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${input.format}-${Date.now()}`);
    await writeFile(path, input.bytes);
    return `file://${path.replace(/\\/g, "/")}`;
  }
  async get(ref: string): Promise<Uint8Array | null> {
    if (!ref.startsWith("file://")) return null;
    const path = ref.slice("file://".length);
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  }
}

function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ReadableArtifactStore {
  if (env.TERRAIN_ARTIFACT_BUCKET) {
    return new GcsTerrainArtifactStore({ bucket: env.TERRAIN_ARTIFACT_BUCKET });
  }
  // /tmp is a canary-only persistence seam. Cloud Run instances may be
  // replaced; Gate X download works same-instance after refresh. Prefer
  // TERRAIN_ARTIFACT_BUCKET for cross-instance download durability.
  return env.TERRAIN_ARTIFACT_DIR
    ? new LocalDiskArtifactStore(env.TERRAIN_ARTIFACT_DIR)
    : new MemoryArtifactStore();
}

export { artifactStoreFromEnv };

function isDownloadableFormat(value: string | undefined): value is DownloadableFormat {
  return !!value && (DOWNLOADABLE_FORMATS as readonly string[]).includes(value);
}

/**
 * TxGIO-backed counties resolve directly from the shared parcel store when
 * TXGIO_DATABASE_URL (or DATABASE_URL) is configured. bboxOverride remains an
 * explicit test fallback; non-TxGIO counties return an honest unresolved error.
 */
export function buildParcelTerrainRoutes(
  resolver: ParcelGeometryResolver = createParcelGeometryResolverFromEnv(),
  storage = new InMemoryStorage(),
  artifactStore: ReadableArtifactStore = artifactStoreFromEnv(),
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
  // Same-instance Gate X download: refresh persists bytes in the artifact
  // store; this route streams them by format. Deferred formats 404.
  app.get("/:parcelNodeId/terrain-export/download", async (c) => {
    const format = c.req.query("format");
    if (!isDownloadableFormat(format)) {
      return c.json({
        error: "invalid_format",
        message: `format must be one of ${DOWNLOADABLE_FORMATS.join(", ")}`,
      }, 400);
    }
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    const artifact = atom.artifacts[format];
    if (!artifact || artifact.deferred) {
      return c.json({
        error: "artifact_unavailable",
        message: artifact?.deferredReason ?? `No ${format} artifact for this parcel`,
      }, 404);
    }
    const bytes = await artifactStore.get(artifact.ref);
    if (!bytes) {
      return c.json({
        error: "artifact_evicted",
        message: "Artifact bytes are no longer on this instance; call terrain-export/refresh again",
      }, 410);
    }
    const safeNodeId = c.req.param("parcelNodeId").replace(/[^a-zA-Z0-9._-]/g, "_");
    c.header("Content-Type", CONTENT_TYPES[format]);
    c.header(
      "Content-Disposition",
      `attachment; filename="${safeNodeId}.${format}.${EXTENSIONS[format]}"`,
    );
    return c.body(Buffer.from(bytes));
  });
  return app;
}
