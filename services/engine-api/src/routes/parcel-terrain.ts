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
  authorParcelFeasibilityExport,
  LIVE_PARCEL_REPORT_FACT_RESOLVERS,
  authorParcelPropertyDossierExport,
  authorParcelSitePlanExport,
  createCountyHydrographyDischargeResolver,
  createElectricOnlyWhoServesResolver,
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
  // Live Smart Site deep link (P-90 item 5) — caller-forwarded only, printed
  // verbatim when present, silently omitted (no chip) when absent.
  liveViewUrl: z.string().max(500).optional(),
});

const feasibilityRefreshBody = z.object({
  // Same geometry seams as dossier-export/refresh — one composition path.
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
  address: z.string().max(200).optional(),
  countyName: z.string().max(120).optional(),
  centroidOverride: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  // item 19 — a flood-drainage-study flow exit the caller already has on
  // file for this parcel. Absent = the discharge-point section ships
  // honest-absent; the engine never runs its own D8 pass here.
  dischargeExitPoint: z.object({ lat: z.number(), lng: z.number() }).optional(),
  liveViewUrl: z.string().max(500).optional(),
  /** Let the narrative run live web search. Off by default: it adds latency
   * and per-call cost on a synchronous customer path. Anything found renders
   * on its own sheet, labelled unverified, never in the fact tables. */
  webSearch: z.boolean().optional(),
  /** Generate the narrative with the LLM. Off by default: measured 63s
   * without search and 95s with, against PE's 55s whole-compose budget. */
  narrative: z.boolean().optional(),
  // Caller-supplied, already-generated narrative. NOTE: the engine DOES now
  // generate a narrative itself when this is absent (see
  // `generateFeasibilityNarrative`); the older comment claiming it never
  // calls an LLM described the pre-2026-09-08 behaviour.
  narrativeOverride: z
    .object({
      text: z.string().max(20000),
      generatedBy: z.string().max(120),
      generatedAt: z.string().max(64),
    })
    .optional(),
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
 * OPS-16 P-120 item 6. Config for the Feasibility narrative generator
 * (`POST /research/narrative-section` on legacy-design-tools).
 *
 * Returns undefined unless BOTH the base URL and the service key are set, so
 * an unconfigured deployment stays on the deterministic skeleton rather than
 * issuing unauthenticated calls. The report never fails for want of this.
 */
export function narrativeSectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; apiKey: string } | undefined {
  const baseUrl = env.BROKERAGE_API_BASE_URL?.trim();
  const apiKey = env.SERVICE_API_KEY?.trim();
  if (!baseUrl || !apiKey) return undefined;
  return { baseUrl, apiKey };
}

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
          liveViewUrl: parsed.data.liveViewUrl,
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
    // P-90 item 7: a stored artifact CAN be present and still hollow (no
    // verdict, no cited brief facts) — refuse the download instead of
    // streaming a hollow PDF, the same fail-closed shape MCP's
    // isStoredDossierArtifactHollow enforces on its own leg.
    if (artifact.verdictIncluded === false || (artifact.briefFactCount ?? 0) === 0) {
      return c.json({
        error: "pipeline_output_absent",
        message:
          "Stored X-ray artifact is hollow (missing verdict or brief facts) and cannot be downloaded. Refresh with a resolved brief first.",
      }, 422);
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

  // P-32 wave 1 — Feasibility Study. Same shape as dossier-export above;
  // engine-side atom composition (feasibility-model.ts) replaces the
  // caller-supplied brief. No PE (hauska-map) wiring in this wave — this
  // route exists so the report is genuinely invokable and live-verifiable
  // end to end within this repo; the PE gating leg is wave 2.
  app.post("/:parcelNodeId/feasibility-export/refresh", async (c) => {
    const parsed = feasibilityRefreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    const parcelNodeId = c.req.param("parcelNodeId");
    const setbackCandidate = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
      (candidate) => candidate.entityType === "setback-rule",
    );
    const setback =
      setbackCandidate && setbackCandidate.entityType === "setback-rule" ? setbackCandidate : undefined;
    try {
      const result = await authorParcelFeasibilityExport({
        parcelNodeId,
        bboxOverride: parsed.data.bboxOverride,
        ringOverride: parsed.data.ringOverride,
        resolutionMeters: parsed.data.resolutionMeters,
        contourIntervalMeters: parsed.data.contourIntervalMeters,
        frontEdgeIndex: parsed.data.frontEdgeIndex,
        skirtDepthFeet: parsed.data.skirtDepthFeet,
        streetAnchors: parsed.data.streetAnchors,
        descriptor: { address: parsed.data.address, countyName: parsed.data.countyName },
        centroidOverride: parsed.data.centroidOverride,
        // R3/R5 (2026-09-07): the real parcel-scoped drainage study, read
        // fresh when the persisted one is stale or missing — replaces the
        // caller-supplied floodStudyAvailable boolean nothing ever checked.
        // Same resolver/storage/artifactStore this route already uses for
        // the site-plan geometry; fetchDem/runWorker/fetchRainfall default
        // to the real adapters, same as the Flood-Drainage report's own
        // route does today.
        drainage: { runWhenStale: true },
        // P-120 R-06 (2026-09-09 CTX-FAMILIES): the resolver is always
        // constructed -- construction does no network IO, only .resolve()
        // does. dischargeExitPoint is passed through when the caller
        // supplied one; composeParcelReport now derives one from the D8
        // drainage study's own first flow exit when the caller did not,
        // which is the actual production shape (no real caller has ever
        // been observed to supply an exit point in advance).
        dischargeExitPoint: parsed.data.dischargeExitPoint,
        dischargeResolver: createCountyHydrographyDischargeResolver(),
        // P-120 R-06: real electric-territory who-serves read (water/sewer/
        // water-district have no acquisition path yet -- see CP1 and
        // who-serves-electric-only.ts's module doc). Armed here so
        // `utilities` reaches a real partial answer instead of never
        // running at all.
        whoServes: createElectricOnlyWhoServesResolver(),
        liveViewUrl: parsed.data.liveViewUrl,
        narrativeOverride: parsed.data.narrativeOverride,
        narrativeSection: narrativeSectionFromEnv(),
        // P-120: the narrative now generates IN THIS SERVICE against the
        // XAI_API_KEY already mounted here, so it no longer waits on a secret
        // from another GCP project. Web search is opt-in per request:
        // `webSearch: true` in the body. It costs latency and money on a
        // synchronous customer path, so it is not on by default.
        narrativeWebSearch: parsed.data.webSearch === true,
        // PASSED THROUGH, not coerced. `=== true` turned an absent field into
        // an explicit `false`, which defeated the author's own default and
        // meant in-process generation never ran in production while the LDT
        // fallback quietly served every request. A default in one layer is
        // worthless if a caller hard-codes the value.
        narrativeGenerate: parsed.data.narrative,
        // P-120 R-04: run the floodplain-acreage, FIRM-panel, soil and
        // electric/gas families. Injected rather than defaulted because they
        // are live network reads; armed HERE so production actually gets them
        // instead of three merged-but-unreached modules.
        factResolvers: LIVE_PARCEL_REPORT_FACT_RESOLVERS,
        resolver,
        setback,
        storage,
        artifactStore,
      });
      return c.json({
        atom: result.atom,
        artifacts: { "pdf-feasibility": result.atom.artifacts["pdf-feasibility"] },
        pageCount: result.pageCount,
        feasibilityPageCount: result.feasibilityPageCount,
        sitePlanAppended: result.sitePlanAppended,
        sitePlanUnavailableReason: result.sitePlanUnavailableReason,
        sectionCount: result.sectionCount,
        openItemCount: result.openItemCount,
        // P-120: the backfill worklist. `kind` separates "the source ran and
        // found nothing" from "nobody asked" and "the read broke"; only the
        // latter two are jobs.
        absentFields: result.absentFields,
        suggestedFileBaseName: result.suggestedFileBaseName,
        webFindings: result.webFindings,
        ...(result.narrativeUsage ? { narrativeUsage: result.narrativeUsage } : {}),
        narrativeIsDeterministicSkeleton: result.narrativeIsDeterministicSkeleton,
        // Declared degradation: WHY the skeleton was used, and what the
        // generated narrative actually cited. A bare boolean does not say
        // whether the feature is off, misconfigured, or refused this run.
        ...(result.narrativeFallbackReason
          ? { narrativeFallbackReason: result.narrativeFallbackReason }
          : {}),
        ...(result.narrativeCitedSections
          ? { narrativeCitedSections: result.narrativeCitedSections }
          : {}),
      }, 201);
    } catch (error) {
      return c.json({
        error: "feasibility_export_failed",
        message: error instanceof Error ? error.message : String(error),
      }, 422);
    }
  });
  app.get("/:parcelNodeId/feasibility-export", async (c) => {
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    return c.json({ atom, artifacts: { "pdf-feasibility": atom.artifacts["pdf-feasibility"] } });
  });
  app.get("/:parcelNodeId/feasibility-export/download", async (c) => {
    const atom = (await storage.listPropertyAtomsByParcelNodeId(c.req.param("parcelNodeId")))
      .find((candidate) => candidate.entityType === "parcel-terrain-model");
    if (!atom || atom.entityType !== "parcel-terrain-model") return c.json({ error: "not_found" }, 404);
    const artifact = atom.artifacts["pdf-feasibility"];
    if (!artifact || artifact.deferred) {
      return c.json({
        error: "artifact_unavailable",
        message: artifact?.deferredReason ?? "No pdf-feasibility artifact for this parcel",
      }, 404);
    }
    const bytes = await artifactStore.get(artifact.ref);
    if (!bytes) {
      return c.json({
        error: "artifact_evicted",
        message: "Artifact bytes are no longer on this instance; call feasibility-export/refresh again",
      }, 410);
    }
    const safeNodeId = c.req.param("parcelNodeId").replace(/[^a-zA-Z0-9._-]/g, "_");
    // Named by parcel id here on purpose. The address-first name is computed
    // at render time and returned on the REFRESH response as
    // `suggestedFileBaseName`; the atom's artifact record is a closed type and
    // cannot carry it, so this route has no address to read at download time.
    // The customer-visible name is set by Property Explorer's BFF anyway
    // (`feasibilityFilename` in hauska-map), which re-serves these bytes and
    // writes its own Content-Disposition — so renaming the download for a
    // customer is a hauska-map change, not this one.
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${safeNodeId}_feasibility_study.pdf"`);
    return c.body(Buffer.from(bytes));
  });

  return app;
}
