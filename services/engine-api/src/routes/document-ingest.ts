/**
 * POST /v1/document-ingest — the unstructured-to-atom ingestion endpoint.
 *
 * The Dataroom tile and other surfaces call this with a document (inline
 * bytes or a pinned-blob reference) + context; it pins the blob, extracts
 * provenanced point-to atoms, and returns their ids, types, provenance,
 * confidence, and accessPolicy.
 *
 * Firewall (critical): the extracted-atom `accessPolicy` is a PARAMETER.
 * It defaults to `tenant-private` and is NEVER auto-published. A caller
 * may request `public-paid` ONLY when the gate has resolved a
 * marketplace-ingest access tier (`accessTier === "public-paid"`); a
 * private-tier / tenant-private caller cannot escalate its extracted
 * atoms to public. The source BLOB is always `tenant-private`.
 *
 * Commitment #1: a malformed/unreadable document returns an honest
 * degraded envelope (blob pinned, extraction degraded with reason), never
 * a 500.
 */

import { Hono } from "hono";
import { z } from "zod";

import {
  DocumentIngestService,
  defaultDocumentAdapters,
  resolveDocumentIngestStore,
  type DocumentIngestStore,
  type AccessPolicy,
} from "@hauska-engine/document-ingest";
import {
  degradedCoverage,
  okCoverage,
  resolveReadPathConfidence,
} from "@hauska-engine/engine-core/envelope";

import { envelopeJson } from "../lib/envelopeResponse.js";

const inlineDocumentSchema = z.object({
  kind: z.literal("inline"),
  body: z.string().min(1),
  encoding: z.enum(["base64", "utf8"]),
  contentType: z.string().min(1),
  sourceRef: z.string().optional(),
});

const blobRefDocumentSchema = z.object({
  kind: z.literal("blob-ref"),
  cid: z.string().min(1),
  contentType: z.string().min(1),
  sourceRef: z.string().optional(),
});

const contextRefsSchema = z.object({
  nodeId: z.string().optional(),
  apn: z.string().optional(),
  engagementId: z.string().optional(),
  jurisdiction: z.string().optional(),
});

const ingestBodySchema = z.object({
  document: z.discriminatedUnion("kind", [
    inlineDocumentSchema,
    blobRefDocumentSchema,
  ]),
  /**
   * Requested accessPolicy for EXTRACTED atoms. Optional; the endpoint
   * clamps it against the gate-resolved access tier and defaults to
   * `tenant-private`. `public-free` / `platform-internal` are also
   * accepted when the gate authorizes them.
   */
  accessPolicy: z
    .enum([
      "public-free",
      "public-paid",
      "platform-internal",
      "tenant-private",
      "tenant-shared",
    ])
    .optional(),
  verificationStatus: z
    .enum(["extracted-unverified", "unverified-web-source", "human-verified"])
    .optional(),
  contextRefs: contextRefsSchema.optional(),
});

/**
 * Resolve the extracted-atom accessPolicy against the gate tier — the
 * firewall. Default tenant-private. A caller may only reach a public
 * (marketplace) tier when the gate itself resolved a public tier; a
 * private-tier caller is clamped back to tenant-private no matter what it
 * requests. This is what stops a user's private-doc-derived atoms from
 * being auto-published.
 */
export function resolveExtractedAccessPolicy(
  requested: AccessPolicy | undefined,
  gateAccessTier: string,
): AccessPolicy {
  const gateIsPublic =
    gateAccessTier === "public-paid" || gateAccessTier === "public-free";
  if (!requested) {
    // No request → mirror the gate tier when it is a public marketplace
    // ingest, otherwise the safe default.
    return gateIsPublic ? (gateAccessTier as AccessPolicy) : "tenant-private";
  }
  // A public request is only honored under a public gate tier.
  if (requested === "public-paid" || requested === "public-free") {
    return gateIsPublic ? requested : "tenant-private";
  }
  // platform-internal only under a platform/public gate tier.
  if (requested === "platform-internal") {
    return gateAccessTier === "platform-internal" || gateIsPublic
      ? "platform-internal"
      : "tenant-private";
  }
  // tenant-private / tenant-shared pass through.
  return requested;
}

export interface DocumentIngestRouteOptions {
  /** Injected store (tests). Defaults to an in-memory store. */
  store?: DocumentIngestStore;
}

export function buildDocumentIngestRoutes(
  options: DocumentIngestRouteOptions = {},
): Hono {
  const app = new Hono();
  // Injected store (tests) wins; otherwise pick durable-vs-in-memory from
  // the environment. resolveDocumentIngestStore returns the honest fallback:
  // durable when a Postgres URL + blob bucket are configured, else in-memory.
  const store =
    options.store ?? resolveDocumentIngestStore(process.env).store;
  const service = new DocumentIngestService({
    store,
    adapters: defaultDocumentAdapters(),
  });

  app.post("/", async (c) => {
    const gateFront = c.get("gateFront");

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "body must be JSON" }, 400);
    }

    const parsed = ingestBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        400,
      );
    }

    const accessPolicy = resolveExtractedAccessPolicy(
      parsed.data.accessPolicy,
      gateFront.accessTier,
    );

    // The orchestrator never throws; a guard here is belt-and-suspenders
    // so a runtime fault still degrades honestly rather than 500ing.
    let result;
    try {
      result = await service.ingest({
        document: parsed.data.document,
        tenant: gateFront.tenantId,
        accessPolicy,
        ...(parsed.data.verificationStatus
          ? { verificationStatus: parsed.data.verificationStatus }
          : {}),
        ...(parsed.data.contextRefs
          ? { contextRefs: parsed.data.contextRefs }
          : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return envelopeJson(
        c,
        {
          status: "degraded",
          sourceDocument: null,
          classification: { documentType: "unknown", adapter: "none", score: 0 },
          atoms: [],
          reason: `ingest fault (guarded): ${reason}`,
        },
        {
          confidence: resolveReadPathConfidence({ assertedBaseline: 0 }),
          dataVintage: null,
          coverage: degradedCoverage("ingest fault"),
          source: { adapter: "document-ingest" },
        },
      );
    }

    const degraded = result.status !== "ok";
    // Envelope-level asserted confidence = min atom confidence (honest
    // aggregate). Empty/degraded → 0. Never a calibrated envelope number.
    const minConfidence =
      result.atoms.length === 0
        ? 0
        : Math.min(...result.atoms.map((a) => a.confidence.value));

    return envelopeJson(
      c,
      {
        status: result.status,
        sourceDocument: result.sourceDocument,
        classification: result.classification,
        atoms: result.atoms,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      {
        confidence: resolveReadPathConfidence({ assertedBaseline: minConfidence }),
        dataVintage: null,
        coverage: degraded
          ? degradedCoverage(result.reason ?? "extraction degraded")
          : okCoverage(),
        source: {
          adapter: result.classification.adapter,
          citationIds: result.atoms.map((a) => a.atomDid),
        },
      },
    );
  });

  return app;
}
