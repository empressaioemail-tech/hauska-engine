/**
 * Conformance suite for the L5 `product-spec-reference` atom.
 *
 * Per the 2026-05-19 Lane A.2 dispatch Phase E test plan: schema +
 * ESR-format validation, register() → contextSummary() round-trip,
 * @ts-expect-error widening rejection on the status enum, and a
 * status-change history test (an `active` atom → a `withdrawn` version
 * → the version preserves the transition per ADR-011).
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildAtomDid } from "../did.js";
import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  ESR_NUMBER_RE,
  PRODUCT_SPEC_REFERENCE_SCHEMA,
  PRODUCT_SPEC_STATUSES,
  type ProductSpecReferenceAtomInstance,
  type ProductSpecStatus,
} from "../instances.js";

function makeProductRef(
  overrides: Partial<ProductSpecReferenceAtomInstance> = {},
): ProductSpecReferenceAtomInstance {
  return {
    entityType: "product-spec-reference",
    entityId: "engagement-42/product-esr-1234",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-icc-es-poller",
    sourceUrl: "https://icc-es.org/report-listing/esr-1234/",
    contentHash: "psrhash1",
    product: {
      name: "Strong-Drive SDWS Timber Screw",
      manufacturer: "Simpson Strong-Tie",
    },
    esrNumber: "ESR-1234",
    status: "active",
    lastVerifiedAt: "2026-05-19T00:00:00Z",
    statusHistory: [
      {
        status: "active",
        changedAt: "2026-05-19T00:00:00Z",
        sourceUrl: "https://icc-es.org/report-listing/esr-1234/",
      },
    ],
    engagementId: "engagement-42",
    findingId: "engagement-42/finding-101",
    responseTaskId: null,
    createdAt: "2026-05-19T00:00:00Z",
    actorId: "actor/architect-jane",
    principalActorId: "actor/principal-bob",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function lookupFor(inst: ProductSpecReferenceAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (
        entityType === "product-spec-reference" &&
        entityId === inst.entityId
      ) {
        return inst as never;
      }
      return null;
    },
  };
}

function resolveOrThrow(
  registry: ReturnType<typeof bootstrapEngineAtomRegistry>,
  entityType: string,
) {
  const result = registry.resolve(entityType);
  if (!result.ok) throw result.error;
  return result.registration;
}

/** Mirrors the engine's content-hash construction for version testing. */
function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

describe("product-spec-reference — Zod schema + ESR format", () => {
  it("accepts a well-formed instance", () => {
    expect(
      PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(makeProductRef()).success,
    ).toBe(true);
  });

  it("accepts every status value", () => {
    for (const status of PRODUCT_SPEC_STATUSES) {
      const inst = makeProductRef({
        status,
        statusHistory: [
          {
            status,
            changedAt: "2026-05-19T00:00:00Z",
            sourceUrl: "https://icc-es.org/x",
          },
        ],
      });
      expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(inst).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    const bad = { ...makeProductRef(), status: "suspended" };
    expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("ESR_NUMBER_RE matches well-formed ESR numbers", () => {
    expect(ESR_NUMBER_RE.test("ESR-1234")).toBe(true);
    expect(ESR_NUMBER_RE.test("ESR-2929")).toBe(true);
    expect(ESR_NUMBER_RE.test("ESR-1")).toBe(true);
  });

  it("rejects malformed ESR numbers", () => {
    for (const bad of ["esr-1234", "ESR1234", "ESR-", "ESR-12A", "1234", ""]) {
      const result = PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(
        makeProductRef({ esrNumber: bad }),
      );
      expect(result.success, `${bad || "(empty)"} should reject`).toBe(false);
    }
  });

  it("rejects a free-text-collapsed product (name + manufacturer required)", () => {
    const bad = { ...makeProductRef(), product: { name: "", manufacturer: "" } };
    expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("accepts an empty statusHistory (no verification recorded yet)", () => {
    expect(
      PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(
        makeProductRef({ statusHistory: [] }),
      ).success,
    ).toBe(true);
  });

  it("allows nullable engagement / finding / response-task / actor links", () => {
    const result = PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(
      makeProductRef({
        engagementId: null,
        findingId: null,
        responseTaskId: null,
        actorId: null,
        principalActorId: null,
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("product-spec-reference — @ts-expect-error widening rejection", () => {
  it("rejects a widened status literal at compile time", () => {
    // @ts-expect-error — status is the literal union active|withdrawn|expired
    const badStatus: ProductSpecStatus = "suspended";
    void badStatus;
    expect(true).toBe(true);
  });
});

describe("product-spec-reference — status-change history (ADR-011)", () => {
  it("an active atom → a withdrawn version preserves the transition", () => {
    // v1: the product reference at first verification — status active.
    const v1 = makeProductRef();
    // The poller later detects ICC-ES withdrew the report. It writes a
    // NEW atom VERSION: same entityId (→ same DID per ADR-011), new
    // content (→ new contentHash → new CID), status flipped, and the
    // status-change appended to the inline history chain.
    const v2: ProductSpecReferenceAtomInstance = {
      ...v1,
      status: "withdrawn",
      lastVerifiedAt: "2026-08-01T00:00:00Z",
      statusHistory: [
        ...v1.statusHistory,
        {
          status: "withdrawn",
          changedAt: "2026-08-01T00:00:00Z",
          sourceUrl: "https://icc-es.org/report-listing/esr-1234/",
        },
      ],
      contentHash: hashContent(
        "product-spec-reference",
        v1.entityId,
        "withdrawn",
        "2026-08-01T00:00:00Z",
      ),
    };

    // ADR-011: identity (DID) is durable across versions; the CID
    // (content hash) is per-version.
    expect(buildAtomDid(v1.entityType, v1.entityId).raw).toBe(
      buildAtomDid(v2.entityType, v2.entityId).raw,
    );
    expect(v1.contentHash).not.toBe(v2.contentHash);

    // The withdrawn version's inline chain preserves the full
    // transition history active → withdrawn.
    expect(v2.statusHistory.map((h) => h.status)).toEqual([
      "active",
      "withdrawn",
    ]);
    // The newest history entry mirrors the atom's current status.
    expect(v2.statusHistory[v2.statusHistory.length - 1]?.status).toBe(
      v2.status,
    );
    // Both schema-validate.
    expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(v1).success).toBe(true);
    expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(v2).success).toBe(true);
  });

  it("a three-step chain active → withdrawn → expired stays ordered", () => {
    const history = [
      { status: "active" as const, changedAt: "2026-01-01T00:00:00Z", sourceUrl: "u1" },
      { status: "withdrawn" as const, changedAt: "2026-06-01T00:00:00Z", sourceUrl: "u2" },
      { status: "expired" as const, changedAt: "2026-12-01T00:00:00Z", sourceUrl: "u3" },
    ];
    const inst = makeProductRef({ status: "expired", statusHistory: history });
    expect(PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(inst).success).toBe(true);
    expect(inst.statusHistory.map((h) => h.status)).toEqual([
      "active",
      "withdrawn",
      "expired",
    ]);
  });
});

describe("product-spec-reference — registry registration", () => {
  it("registers under domain cortex with five render modes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "product-spec-reference");
    expect(reg.domain).toBe("cortex");
    expect(reg.defaultMode).toBe("card");
    expect([...reg.supportedModes].sort()).toEqual([
      "card",
      "compact",
      "expanded",
      "focus",
      "inline",
    ]);
  });

  it("defaults accessPolicy to tenant-private + declares audit eventTypes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "product-spec-reference");
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.eventTypes).toEqual([
      "product-spec-reference.created",
      "product-spec-reference.verified",
      "product-spec-reference.status-changed",
    ]);
    expect(reg.composition).toEqual([]);
  });
});

describe("product-spec-reference — contextSummary round-trip", () => {
  it("resolves an active product reference to a four-layer summary", async () => {
    const inst = makeProductRef();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "product-spec-reference");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("ESR-1234");
    expect(summary.prose).toContain("active");
    expect(summary.typed.status).toBe("active");
    expect(summary.typed.esrNumber).toBe("ESR-1234");
    expect(summary.typed.manufacturer).toBe("Simpson Strong-Tie");
    expect(summary.keyMetrics.some((m) => m.value === "ESR-1234")).toBe(true);
  });

  it("surfaces the status-change count for a multi-version reference", async () => {
    const inst = makeProductRef({
      status: "withdrawn",
      statusHistory: [
        { status: "active", changedAt: "2026-01-01T00:00:00Z", sourceUrl: "u1" },
        { status: "withdrawn", changedAt: "2026-08-01T00:00:00Z", sourceUrl: "u2" },
      ],
    });
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "product-spec-reference");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.typed.statusChangeCount).toBe(2);
    expect(summary.typed.status).toBe("withdrawn");
  });

  it("user-audience prose is compact (scopeFiltered)", async () => {
    const inst = makeProductRef();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "product-spec-reference");
    const summary = await reg.contextSummary(inst.entityId, { audience: "user" });
    expect(summary.scopeFiltered).toBe(true);
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeProductRef();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "product-spec-reference");
    const summary = await reg.contextSummary("engagement-42/product-esr-999", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });
});
