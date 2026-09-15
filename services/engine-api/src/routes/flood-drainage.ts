import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import {
  createParcelGeometryResolverFromEnv,
  type ParcelGeometryResolver,
} from "@hauska-engine/engine-core/parcel-terrain";
import { authorParcelFloodDrainageReport } from "@hauska-engine/engine-core/site-plan";
import type { FloodDrainageRefreshJob, StoragePort } from "@hauska-engine/storage";

import {
  artifactStoreFromEnv,
  storageFromEnv,
  type ReadableArtifactStore,
} from "./parcel-terrain.js";

/**
 * FLOOD & DRAINAGE routes (2026-07-29, R3 — the first PAID report; v2
 * adds the WATER GRADIENT to the study payload).
 *
 * P-240 (OPS-24, 2026-09-15): REFRESH IS ASYNCHRONOUS, ported onto P-155's
 * feasibility-export pattern (services/engine-api/src/routes/parcel-terrain.ts).
 * F7/P-240 measured 56-75s on Travis with 6 of 11 calls over both clients'
 * 55,000ms abort while the engine itself returned 201 on all 11 — the
 * engine never failed; the client gave up and reported the wrong mechanism.
 * Refresh now records a job (packages/storage/migrations/016_flood_drainage_refresh_jobs.sql)
 * and returns 202 without waiting for the study to finish; the actual
 * `authorParcelFloodDrainageReport` call runs detached (not awaited).
 *
 * PINNED CONTRACT (verbatim; the MCP/PE legs build against this):
 *
 *   POST /v1/property-nodes/:parcelNodeId/flood-drainage/refresh
 *     body: { address?, countyName?, rainfallDepthInches? }
 *     202 → { state: "queued" | "running", jobRef, pollAfterMs, statusUrl,
 *       downloadUrl } — a second refresh while a job is running returns the
 *       SAME job reference rather than starting a second run.
 *
 *   GET  /v1/property-nodes/:parcelNodeId/flood-drainage
 *     → job status: { state: "never-requested" } | { state, jobRef,
 *       queuedAt, startedAt, completedAt, failedAt, errorClass, errorMessage,
 *       pollAfterMs? }. `never-requested` is its own answer, never `deferred`.
 *
 *   GET  /v1/property-nodes/:parcelNodeId/flood-drainage/study
 *     → the cached study JSON (the PE dock viz; written at refresh). A
 *       DECLARED 404 wait while queued/running (never a stale prior study),
 *       422 with an errorClass once failed, else the study: { catchmentGeoJson,
 *       drainageZonesGeoJson, rainfallResultGeoJson, flowLinesGeoJson,
 *       rainfallDepthInches, rainfallSource, demProvenance, briefing,
 *       gradient?: { pngBase64: string, bbox: { westLng, southLat,
 *         eastLng, northLat }, note: string }, honestEmpty? }
 *
 *   The gradient is the transparent-background water-ramp PNG (longest
 *   axis <= 640 px) the PE leg drapes on the map by its WGS84 bbox —
 *   absent only when the drainage field is degenerate or honest-empty.
 *
 *   v3 additive study fields (PE feature-detects; absent-safe):
 *     flowPaths?: [{ coordinates: [[lng,lat],...], strength: 0..1,
 *       kind: "interior" | "exit" }]      — top D8 accumulation ridgelines,
 *       ordered downstream, strength = normalized log flow accumulation
 *     catchmentSwaths?: [{ coordinates: [ring], strength, kind }]
 *       — index-aligned contributing-corridor polygon per flow path
 *     flowPathsNote?: string              — derivation provenance
 *   GET  /v1/property-nodes/:parcelNodeId/flood-drainage/download
 *     ?format=pdf-flood-drainage → application/pdf. Same declared
 *     404/422 wait/failure treatment as /study.
 *
 * Gate/auth: same as site-plan-export — engine-api only accepts
 * gate-proxied calls (gate-front headers enforced in server.ts); the
 * public-paid enforcement rides the MCP/PE legs.
 */

const bbox = z.object({
  westLng: z.number(),
  southLat: z.number(),
  eastLng: z.number(),
  northLat: z.number(),
});

const refreshBody = z.object({
  // Pinned contract fields.
  address: z.string().max(200).optional(),
  countyName: z.string().max(120).optional(),
  rainfallDepthInches: z.number().positive().max(60).optional(),
  // Live Smart Site deep link (P-90 item 5) — caller-forwarded only, printed
  // verbatim when present, silently omitted (no chip) when absent.
  liveViewUrl: z.string().max(500).optional(),
  // Test/operator seams — same as the sibling terrain/site-plan routes;
  // explicit, never a hidden county-specific fallback.
  bboxOverride: bbox.optional(),
  ringOverride: z.array(z.tuple([z.number(), z.number()])).optional(),
  resolutionMeters: z.number().positive().optional(),
});

const DOWNLOAD_FORMAT = "pdf-flood-drainage" as const;

// P-240: 5 min ~= 4x the observed 75s Travis max (F7/P-240 measured
// 56-75s), mirroring feasibility-export's "~4x the observed max" reasoning
// for its own 10-minute ceiling (that route's compose times run longer).
const FLOOD_DRAINAGE_POLL_AFTER_MS = 5_000;
const FLOOD_DRAINAGE_JOB_STALL_CEILING_MS = 5 * 60_000;

function classifyFloodDrainageJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/geometry|boundary ring/i.test(message)) return "geometry_unavailable";
  if (/timed out|timeout/i.test(message)) return "compose_timeout";
  return "compose_failed";
}

export function buildFloodDrainageRoutes(
  resolver: ParcelGeometryResolver = createParcelGeometryResolverFromEnv(),
  storage: StoragePort = storageFromEnv(),
  artifactStore: ReadableArtifactStore = artifactStoreFromEnv(),
): Hono {
  const app = new Hono();

  function statusUrl(parcelNodeId: string): string {
    return `/v1/property-nodes/${encodeURIComponent(parcelNodeId)}/flood-drainage`;
  }
  function downloadUrl(parcelNodeId: string): string {
    return `/v1/property-nodes/${encodeURIComponent(parcelNodeId)}/flood-drainage/download`;
  }

  /** Read the job row and apply the staleness reclassification. Never
   * mutates a job that isn't actually stale. Mirrors describeFeasibilityJob
   * in parcel-terrain.ts exactly. */
  async function describeFloodDrainageJob(parcelNodeId: string): Promise<FloodDrainageRefreshJob | null> {
    if (!storage.getFloodDrainageRefreshJob) return null;
    const job = await storage.getFloodDrainageRefreshJob(parcelNodeId);
    if (!job) return null;
    if (job.state === "running" && job.startedAt) {
      const ageMs = Date.now() - Date.parse(job.startedAt);
      if (Number.isFinite(ageMs) && ageMs > FLOOD_DRAINAGE_JOB_STALL_CEILING_MS) {
        if (!storage.upsertFloodDrainageRefreshJob) return job;
        return storage.upsertFloodDrainageRefreshJob(parcelNodeId, {
          jobRef: job.jobRef,
          state: "failed",
          failedAt: new Date().toISOString(),
          errorClass: "stalled",
          errorMessage: `No completion observed within ${FLOOD_DRAINAGE_JOB_STALL_CEILING_MS}ms of starting.`,
        });
      }
    }
    return job;
  }

  /** Runs the SAME composition the old synchronous route ran, then writes
   * the job to ready/failed. Never throws to its caller — refresh has
   * already responded by the time this settles. */
  async function runFloodDrainageJob(
    parcelNodeId: string,
    jobRef: string,
    body: z.infer<typeof refreshBody>,
  ): Promise<void> {
    if (!storage.upsertFloodDrainageRefreshJob) return;
    try {
      await authorParcelFloodDrainageReport({
        parcelNodeId,
        resolver,
        storage,
        artifactStore,
        bboxOverride: body.bboxOverride,
        ringOverride: body.ringOverride,
        resolutionMeters: body.resolutionMeters,
        rainfallDepthInches: body.rainfallDepthInches,
        descriptor:
          body.address || body.countyName || body.liveViewUrl
            ? { address: body.address, countyName: body.countyName, liveViewUrl: body.liveViewUrl }
            : undefined,
      });
      await storage.upsertFloodDrainageRefreshJob(parcelNodeId, {
        jobRef,
        state: "ready",
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.log(JSON.stringify({
        level: "error",
        service: "engine-api",
        event: "flood_drainage_refresh.job_failed",
        parcelNodeId,
        jobRef,
        message: error instanceof Error ? error.message : String(error),
        ts: new Date().toISOString(),
      }));
      await storage.upsertFloodDrainageRefreshJob(parcelNodeId, {
        jobRef,
        state: "failed",
        failedAt: new Date().toISOString(),
        errorClass: classifyFloodDrainageJobError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  app.post("/:parcelNodeId/flood-drainage/refresh", async (c) => {
    const parsed = refreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }
    const parcelNodeId = c.req.param("parcelNodeId");

    // Feature-detect: an older/test StoragePort without the P-240 methods
    // keeps the pre-P-240 behavior it always had (used by
    // __tests__/*.test.ts doubles that construct routes directly) rather
    // than silently losing the response shape those tests assert on.
    if (!storage.getFloodDrainageRefreshJob || !storage.upsertFloodDrainageRefreshJob) {
      return c.json({
        error: "flood_drainage_refresh_failed",
        message: "Storage backend does not support async flood-drainage job state (P-240).",
      }, 500);
    }

    const existingJob = await describeFloodDrainageJob(parcelNodeId);
    if (existingJob && existingJob.state === "running") {
      // Never starts a second job while one is in flight for this parcel —
      // hands back the SAME job's reference (mirrors P-155 item 2).
      return c.json({
        state: "running",
        jobRef: existingJob.jobRef,
        pollAfterMs: FLOOD_DRAINAGE_POLL_AFTER_MS,
        statusUrl: statusUrl(parcelNodeId),
        downloadUrl: downloadUrl(parcelNodeId),
      }, 202);
    }

    const jobRef = randomUUID();
    await storage.upsertFloodDrainageRefreshJob(parcelNodeId, {
      jobRef,
      state: "queued",
      queuedAt: new Date().toISOString(),
    });
    // Marked `running` BEFORE responding so a poll landing immediately
    // after this 202 never reads a stale `queued` for a job already
    // authoring.
    await storage.upsertFloodDrainageRefreshJob(parcelNodeId, {
      jobRef,
      state: "running",
      startedAt: new Date().toISOString(),
    });

    // Deliberately not awaited — same CPU-throttling reasoning as
    // runFeasibilityJob in parcel-terrain.ts (see that function's CP1 note).
    void runFloodDrainageJob(parcelNodeId, jobRef, parsed.data);

    return c.json({
      state: "queued",
      jobRef,
      pollAfterMs: FLOOD_DRAINAGE_POLL_AFTER_MS,
      statusUrl: statusUrl(parcelNodeId),
      downloadUrl: downloadUrl(parcelNodeId),
    }, 202);
  });

  app.get("/:parcelNodeId/flood-drainage", async (c) => {
    const parcelNodeId = c.req.param("parcelNodeId");
    const job = await describeFloodDrainageJob(parcelNodeId);
    if (!job) {
      // `never-requested` is its own answer — never reported as `deferred`.
      // A pre-P-240 atom with a study already on file (from before this
      // deploy) still reports ready via the existing /study and /download
      // routes even with no job row; this status route simply has nothing
      // to say about IT specifically, per P-155 item 1's precedent.
      const atom = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId))
        .find((candidate) => candidate.entityType === "parcel-terrain-model");
      if (atom && atom.entityType === "parcel-terrain-model" && atom.artifacts["pdf-flood-drainage"]) {
        return c.json({
          state: atom.artifacts["pdf-flood-drainage"]?.deferred ? "failed" : "ready",
        });
      }
      return c.json({ state: "never-requested" }, 200);
    }
    return c.json({
      state: job.state,
      jobRef: job.jobRef,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
      errorClass: job.errorClass,
      errorMessage: job.errorMessage,
      pollAfterMs: (job.state === "queued" || job.state === "running") ? FLOOD_DRAINAGE_POLL_AFTER_MS : undefined,
    });
  });

  app.get("/:parcelNodeId/flood-drainage/study", async (c) => {
    const parcelNodeId = c.req.param("parcelNodeId");
    const job = await describeFloodDrainageJob(parcelNodeId);
    if (job && (job.state === "queued" || job.state === "running")) {
      // A DECLARED wait, never a stale prior study served silently
      // (P-155 item 1's "never a silent fallback" precedent).
      return c.json(
        {
          error: "flood_drainage_in_progress",
          state: job.state,
          jobRef: job.jobRef,
          pollAfterMs: FLOOD_DRAINAGE_POLL_AFTER_MS,
          message: "Flood & Drainage study is still being generated for this parcel.",
        },
        404,
      );
    }
    if (job && job.state === "failed") {
      return c.json(
        {
          error: "flood_drainage_refresh_failed",
          errorClass: job.errorClass ?? "compose_failed",
          message: job.errorMessage ?? "Flood & Drainage study could not be produced for this parcel.",
        },
        422,
      );
    }
    const atom = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
      (candidate) => candidate.entityType === "parcel-terrain-model",
    );
    if (!atom || atom.entityType !== "parcel-terrain-model") {
      return c.json({ error: "not_found" }, 404);
    }
    const artifact = atom.artifacts["json-flood-drainage-study"];
    if (!artifact || artifact.deferred) {
      return c.json(
        {
          error: "study_unavailable",
          message: artifact?.deferredReason ?? "No flood-drainage study for this parcel; call flood-drainage/refresh",
        },
        404,
      );
    }
    const bytes = await artifactStore.get(artifact.ref);
    if (!bytes) {
      return c.json(
        {
          error: "artifact_evicted",
          message: "Study payload is no longer on this instance; call flood-drainage/refresh again",
        },
        410,
      );
    }
    const study = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return c.json({ data: { parcelNodeId, study } });
  });

  app.get("/:parcelNodeId/flood-drainage/download", async (c) => {
    const format = c.req.query("format");
    if (format !== DOWNLOAD_FORMAT) {
      return c.json(
        { error: "invalid_format", message: `format must be ${DOWNLOAD_FORMAT}` },
        400,
      );
    }
    const parcelNodeId = c.req.param("parcelNodeId");
    const job = await describeFloodDrainageJob(parcelNodeId);
    if (job && (job.state === "queued" || job.state === "running")) {
      return c.json(
        {
          error: "flood_drainage_in_progress",
          state: job.state,
          jobRef: job.jobRef,
          pollAfterMs: FLOOD_DRAINAGE_POLL_AFTER_MS,
          message: "Flood & Drainage study is still being generated for this parcel.",
        },
        404,
      );
    }
    if (job && job.state === "failed") {
      return c.json(
        {
          error: "flood_drainage_refresh_failed",
          errorClass: job.errorClass ?? "compose_failed",
          message: job.errorMessage ?? "Flood & Drainage study could not be produced for this parcel.",
        },
        422,
      );
    }
    const atom = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
      (candidate) => candidate.entityType === "parcel-terrain-model",
    );
    if (!atom || atom.entityType !== "parcel-terrain-model") {
      return c.json({ error: "not_found" }, 404);
    }
    const artifact = atom.artifacts[DOWNLOAD_FORMAT];
    if (!artifact || artifact.deferred) {
      return c.json(
        {
          error: "artifact_unavailable",
          message: artifact?.deferredReason ?? `No ${DOWNLOAD_FORMAT} artifact for this parcel`,
        },
        404,
      );
    }
    const bytes = await artifactStore.get(artifact.ref);
    if (!bytes) {
      return c.json(
        {
          error: "artifact_evicted",
          message: "Artifact bytes are no longer on this instance; call flood-drainage/refresh again",
        },
        410,
      );
    }
    const safeNodeId = parcelNodeId.replace(/[^a-zA-Z0-9._-]/g, "_");
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `attachment; filename="${safeNodeId}.flood-drainage.pdf"`);
    if (job?.completedAt) {
      c.header("X-Flood-Drainage-Generated-At", job.completedAt);
    }
    return c.body(Buffer.from(bytes));
  });

  return app;
}
