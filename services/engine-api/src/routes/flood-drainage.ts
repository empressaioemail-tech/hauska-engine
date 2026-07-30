import { Hono } from "hono";
import { z } from "zod";

import {
  createParcelGeometryResolverFromEnv,
  type ParcelGeometryResolver,
} from "@hauska-engine/engine-core/parcel-terrain";
import { authorParcelFloodDrainageReport } from "@hauska-engine/engine-core/site-plan";
import type { StoragePort } from "@hauska-engine/storage";

import {
  artifactStoreFromEnv,
  storageFromEnv,
  type ReadableArtifactStore,
} from "./parcel-terrain.js";

/**
 * FLOOD & DRAINAGE routes (2026-07-29, R3 — the first PAID report; v2
 * adds the WATER GRADIENT to the study payload).
 *
 * PINNED CONTRACT (verbatim; the MCP/PE legs build against this):
 *
 *   POST /v1/property-nodes/:parcelNodeId/flood-drainage/refresh
 *     body: { address?, countyName?, rainfallDepthInches? }
 *     201 → { data: { parcelNodeId, study: { catchmentGeoJson,
 *       drainageZonesGeoJson, rainfallResultGeoJson, flowLinesGeoJson,
 *       rainfallDepthInches, rainfallSource, demProvenance, briefing,
 *       gradient?: { pngBase64: string, bbox: { westLng, southLat,
 *         eastLng, northLat }, note: string },
 *       honestEmpty? }, artifact: { format: "pdf-flood-drainage",
 *       pageCount, ... } } }
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
 *     ?format=pdf-flood-drainage → application/pdf
 *   GET  /v1/property-nodes/:parcelNodeId/flood-drainage/study
 *     → the cached study JSON (the PE dock viz; written at refresh)
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
  // Test/operator seams — same as the sibling terrain/site-plan routes;
  // explicit, never a hidden county-specific fallback.
  bboxOverride: bbox.optional(),
  ringOverride: z.array(z.tuple([z.number(), z.number()])).optional(),
  resolutionMeters: z.number().positive().optional(),
});

const DOWNLOAD_FORMAT = "pdf-flood-drainage" as const;

export function buildFloodDrainageRoutes(
  resolver: ParcelGeometryResolver = createParcelGeometryResolverFromEnv(),
  storage: StoragePort = storageFromEnv(),
  artifactStore: ReadableArtifactStore = artifactStoreFromEnv(),
): Hono {
  const app = new Hono();

  app.post("/:parcelNodeId/flood-drainage/refresh", async (c) => {
    const parsed = refreshBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
    }
    const parcelNodeId = c.req.param("parcelNodeId");
    try {
      const result = await authorParcelFloodDrainageReport({
        parcelNodeId,
        resolver,
        storage,
        artifactStore,
        bboxOverride: parsed.data.bboxOverride,
        ringOverride: parsed.data.ringOverride,
        resolutionMeters: parsed.data.resolutionMeters,
        rainfallDepthInches: parsed.data.rainfallDepthInches,
        descriptor:
          parsed.data.address || parsed.data.countyName
            ? { address: parsed.data.address, countyName: parsed.data.countyName }
            : undefined,
      });
      return c.json(
        {
          data: {
            parcelNodeId,
            study: result.study,
            artifact: result.atom.artifacts["pdf-flood-drainage"],
          },
        },
        201,
      );
    } catch (error) {
      return c.json(
        {
          error: "flood_drainage_refresh_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        422,
      );
    }
  });

  app.get("/:parcelNodeId/flood-drainage/study", async (c) => {
    const parcelNodeId = c.req.param("parcelNodeId");
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
    return c.body(Buffer.from(bytes));
  });

  return app;
}
