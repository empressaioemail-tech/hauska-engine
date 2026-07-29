import { Hono } from "hono";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createPgStorage,
  InMemoryStorage,
  resolveSubstrateDatabaseUrl,
  type StoragePort,
} from "@hauska-engine/storage";
import {
  authorParcelTerrainExport,
  createParcelGeometryResolverFromEnv,
  type ParcelGeometryResolver,
  type TerrainArtifactStore,
} from "@hauska-engine/engine-core/parcel-terrain";
import {
  authorParcelPropertyDossierExport,
  authorParcelSitePlanExport,
} from "@hauska-engine/engine-core/site-plan";
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

const SITE_PLAN_DOWNLOADABLE_FORMATS = ["dxf-site-plan", "ifc-site-plan", "pdf-site-plan"] as const;
type SitePlanDownloadableFormat = (typeof SITE_PLAN_DOWNLOADABLE_FORMATS)[number];

const SITE_PLAN_CONTENT_TYPES: Record<SitePlanDownloadableFormat, string> = {
  "dxf-site-plan": "application/dxf",
  "ifc-site-plan": "application/step",
  "pdf-site-plan": "application/pdf",
};

const SITE_PLAN_EXTENSIONS: Record<SitePlanDownloadableFormat, string> = {
  "dxf-site-plan": "dxf",
  "ifc-site-plan": "ifc",
  "pdf-site-plan": "pdf",
};

function isSitePlanDownloadableFormat(value: string | undefined): value is SitePlanDownloadableFormat {
  return !!value && (SITE_PLAN_DOWNLOADABLE_FORMATS as readonly string[]).includes(value);
}

const sitePlanRefreshBody = z.object({
  bboxOverride: bbox.optional(),
  ringOverride: z.array(z.tuple([z.number(), z.number()])).optional(),
  resolutionMeters: z.number().positive().optional(),
  contourIntervalMeters: z.number().positive().optional(),
  frontEdgeIndex: z.number().int().nonnegative().optional(),
  skirtDepthFeet: z.number().positive().optional(),
  streetAnchors: z
    .array(
      z.object({
        name: z.string(),
        points: z.array(z.tuple([z.number(), z.number()])).min(2),
        sourceRef: z.string().optional(),
      }),
    )
    .optional(),
  // PDF summary-block-only descriptors (Wave 2) — caller-supplied, never
  // fabricated by the engine. Omitted fields render as honest "not on file".
  address: z.string().optional(),
  countyName: z.string().optional(),
});

/**
 * Property-dossier request contract (2026-07-29, pinned with the PE BFF/MCP
 * leg). Everything is optional and caller-supplied; the engine renders
 * exactly what the request carries (verbatim, labeled) and honest-degrades
 * on anything absent — never fabricates. Server-side caps mirror
 * `DOSSIER_CAPS`; the assembler sanitizes again (control chars, glyphs).
 */
const dossierRefreshBody = z.object({
  // Site-plan geometry seams (same as site-plan-export/refresh).
  bboxOverride: bbox.optional(),
  ringOverride: z.array(z.tuple([z.number(), z.number()])).optional(),
  resolutionMeters: z.number().positive().optional(),
  contourIntervalMeters: z.number().positive().optional(),
  frontEdgeIndex: z.number().int().nonnegative().optional(),
  skirtDepthFeet: z.number().positive().optional(),
  streetAnchors: z
    .array(
      z.object({
        name: z.string(),
        points: z.array(z.tuple([z.number(), z.number()])).min(2),
        sourceRef: z.string().optional(),
      }),
    )
    .optional(),
  // Dossier content — caller-supplied only.
  address: z.string().max(200).optional(),
  countyName: z.string().max(120).optional(),
  verdictLine: z.string().max(400).optional(),
  brief: z
    .object({
      sections: z
        .array(
          z.object({
            id: z.string().max(64),
            title: z.string().max(160),
            facts: z
              .array(
                z.object({
                  label: z.string().max(160),
                  value: z.string().max(400).optional(),
                  source: z.string().max(240).optional(),
                  vintage: z.string().max(80).optional(),
                }),
              )
              .max(60),
          }),
        )
        .max(16),
    })
    .optional(),
  chatSummary: z
    .object({
      summary: z.string().max(12000),
      savedAt: z.string().max(64),
      disclaimer: z.string().max(600).optional(),
    })
    .optional(),
  notes: z.string().max(4000).optional(),
});

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

/**
 * Site-plan / terrain export must read property atoms from Postgres in
 * production. Defaulting to InMemoryStorage made every parcel look like
 * setback_rule_missing (false refusal) even when atoms were on file.
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StoragePort {
  // Vitest / unit tests inject storage explicitly; never open a live pool from
  // a developer shell's DATABASE_URL during buildApp() smoke tests.
  if (env.VITEST === "true" || env.NODE_ENV === "test") {
    return new InMemoryStorage();
  }
  const url = resolveSubstrateDatabaseUrl(env.SUBSTRATE_DATABASE_URL ?? env.DATABASE_URL);
  if (!url) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "engine-api",
        event: "parcel_terrain.storage.in_memory",
        reason: "SUBSTRATE_DATABASE_URL / DATABASE_URL unset",
        ts: new Date().toISOString(),
      }),
    );
    return new InMemoryStorage();
  }
  return createPgStorage({ databaseUrl: url, maxConnections: 3 }).storage;
}

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
  storage: StoragePort = storageFromEnv(),
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

  // Site-plan export (2026-07-25 sprint; 2026-07-27 no-setback relaxation):
  // export SUCCEEDS whether or not a setback-rule atom exists. When present,
  // setbacks are drawn as before. When ABSENT, the sheet still exports with
  // parcel + envelope + contours + provenance, and the setback layer is drawn
  // honest-absent ("setbacks not specified — no rule on file, not verified") —
  // NEVER a fabricated front/side/rear value (commitment #1). Axes marked
  // not_specified (code silent / build-to-line) remain a valid drawn state.
  app.post("/:parcelNodeId/site-plan-export/refresh", async (c) => {
    const parsed = sitePlanRefreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    const parcelNodeId = c.req.param("parcelNodeId");
    const setbackCandidate = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
      (candidate) => candidate.entityType === "setback-rule",
    );
    // Optional: absent setback is an honest-absent layer, not a refusal.
    const setback =
      setbackCandidate && setbackCandidate.entityType === "setback-rule"
        ? setbackCandidate
        : undefined;
    try {
      const result = await authorParcelSitePlanExport({
        parcelNodeId,
        bboxOverride: parsed.data.bboxOverride,
        ringOverride: parsed.data.ringOverride,
        resolutionMeters: parsed.data.resolutionMeters,
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        frontEdgeIndex: parsed.data.frontEdgeIndex,
        skirtDepthFeet: parsed.data.skirtDepthFeet,
        streetAnchors: parsed.data.streetAnchors,
        descriptor:
          parsed.data.address || parsed.data.countyName
            ? { address: parsed.data.address, countyName: parsed.data.countyName }
            : undefined,
        resolver,
        setback,
        storage,
        artifactStore,
      });
      return c.json({
        atom: result.atom,
        artifacts: {
          "dxf-site-plan": result.atom.artifacts["dxf-site-plan"],
          "ifc-site-plan": result.atom.artifacts["ifc-site-plan"],
          "pdf-site-plan": result.atom.artifacts["pdf-site-plan"],
        },
        setbackDegenerate: result.setbackDegenerate,
        setbackDegenerateReason: result.setbackDegenerateReason,
        setbackHonestAbsence: result.setbackHonestAbsence,
        setbackHonestAbsenceReason: result.setbackHonestAbsenceReason,
        streetHonestAbsence: result.streetHonestAbsence,
        zoningHonestAbsence: result.zoningHonestAbsence,
        floodZoneHonestUnavailable: result.floodZoneHonestUnavailable,
      }, 201);
    } catch (error) {
      return c.json({
        error: "site_plan_export_failed",
        message: error instanceof Error ? error.message : String(error),
      }, 422);
    }
  });
  app.get("/:parcelNodeId/site-plan-export", async (c) => {
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    return c.json({
      atom,
      artifacts: {
        "dxf-site-plan": atom.artifacts["dxf-site-plan"],
        "ifc-site-plan": atom.artifacts["ifc-site-plan"],
        "pdf-site-plan": atom.artifacts["pdf-site-plan"],
      },
    });
  });
  app.get("/:parcelNodeId/site-plan-export/download", async (c) => {
    const format = c.req.query("format");
    if (!isSitePlanDownloadableFormat(format)) {
      return c.json({
        error: "invalid_format",
        message: `format must be one of ${SITE_PLAN_DOWNLOADABLE_FORMATS.join(", ")}`,
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
        message: "Artifact bytes are no longer on this instance; call site-plan-export/refresh again",
      }, 410);
    }
    const safeNodeId = c.req.param("parcelNodeId").replace(/[^a-zA-Z0-9._-]/g, "_");
    c.header("Content-Type", SITE_PLAN_CONTENT_TYPES[format]);
    c.header(
      "Content-Disposition",
      `attachment; filename="${safeNodeId}.${format}.${SITE_PLAN_EXTENSIONS[format]}"`,
    );
    return c.body(Buffer.from(bytes));
  });

  // Property-dossier export (2026-07-29): ONE hand-to-client PDF — cover
  // (verdict) + cited brief facts + AI chat summary + owner notes in the
  // Sheet Standard's design language, with the parcel's site-plan sheets
  // APPENDED and renumbered. Honest-degrade throughout: absent content takes
  // honest chips, a missing site-plan capability never fails the export.
  app.post("/:parcelNodeId/dossier-export/refresh", async (c) => {
    const parsed = dossierRefreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    const parcelNodeId = c.req.param("parcelNodeId");
    const setbackCandidate = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
      (candidate) => candidate.entityType === "setback-rule",
    );
    const setback =
      setbackCandidate && setbackCandidate.entityType === "setback-rule"
        ? setbackCandidate
        : undefined;
    try {
      const result = await authorParcelPropertyDossierExport({
        parcelNodeId,
        bboxOverride: parsed.data.bboxOverride,
        ringOverride: parsed.data.ringOverride,
        resolutionMeters: parsed.data.resolutionMeters,
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        frontEdgeIndex: parsed.data.frontEdgeIndex,
        skirtDepthFeet: parsed.data.skirtDepthFeet,
        streetAnchors: parsed.data.streetAnchors,
        content: {
          address: parsed.data.address,
          countyName: parsed.data.countyName,
          verdictLine: parsed.data.verdictLine,
          brief: parsed.data.brief,
          chatSummary: parsed.data.chatSummary,
          notes: parsed.data.notes,
        },
        resolver,
        setback,
        storage,
        artifactStore,
      });
      return c.json({
        atom: result.atom,
        artifacts: { "pdf-dossier": result.atom.artifacts["pdf-dossier"] },
        pageCount: result.pageCount,
        dossierPageCount: result.dossierPageCount,
        sitePlanAppended: result.sitePlanAppended,
        sitePlanUnavailableReason: result.sitePlanUnavailableReason,
        verdictIncluded: result.verdictIncluded,
        briefSectionCount: result.briefSectionCount,
        briefFactCount: result.briefFactCount,
        chatSummaryIncluded: result.chatSummaryIncluded,
        notesIncluded: result.notesIncluded,
        setbackDegenerate: result.setbackDegenerate,
        setbackHonestAbsence: result.setbackHonestAbsence,
        streetHonestAbsence: result.streetHonestAbsence,
        zoningHonestAbsence: result.zoningHonestAbsence,
        floodZoneHonestUnavailable: result.floodZoneHonestUnavailable,
      }, 201);
    } catch (error) {
      return c.json({
        error: "dossier_export_failed",
        message: error instanceof Error ? error.message : String(error),
      }, 422);
    }
  });
  app.get("/:parcelNodeId/dossier-export", async (c) => {
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    return c.json({ atom, artifacts: { "pdf-dossier": atom.artifacts["pdf-dossier"] } });
  });
  app.get("/:parcelNodeId/dossier-export/download", async (c) => {
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    const artifact = atom.artifacts["pdf-dossier"];
    if (!artifact || artifact.deferred) {
      return c.json({
        error: "artifact_unavailable",
        message: artifact?.deferredReason ?? "No pdf-dossier artifact for this parcel",
      }, 404);
    }
    const bytes = await artifactStore.get(artifact.ref);
    if (!bytes) {
      return c.json({
        error: "artifact_evicted",
        message: "Artifact bytes are no longer on this instance; call dossier-export/refresh again",
      }, 410);
    }
    const safeNodeId = c.req.param("parcelNodeId").replace(/[^a-zA-Z0-9._-]/g, "_");
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${safeNodeId}.pdf-dossier.pdf"`);
    return c.body(Buffer.from(bytes));
  });

  return app;
}
