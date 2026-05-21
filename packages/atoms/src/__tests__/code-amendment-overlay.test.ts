/**
 * Conformance suite for the ADR-019 `code-amendment` extension — the
 * Layer 2 jurisdictional-overlay discriminant.
 *
 * Covers: discriminated-union schema validation (both scopes), the
 * temporal/overlay type guards, @ts-expect-error widening rejection on
 * the new enums, and a register() -> contextSummary() round-trip that
 * proves the registry surfaces the discriminant for both scopes.
 *
 * This is E1.A of the Lane E ADR-019 layered-substrate pipeline. The
 * temporal arm is the original Bump 1 semantics, unchanged in shape;
 * the overlay arm is new.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  AMENDMENT_SCOPES,
  CODE_AMENDMENT_SCHEMA,
  isJurisdictionalOverlay,
  isTemporalAmendment,
  OVERLAY_OPERATIONS,
  type CodeAmendmentAtomInstance,
  type JurisdictionalOverlayAmendmentInstance,
  type OverlayOperation,
  type TemporalCodeAmendmentInstance,
} from "../instances.js";

function makeTemporal(
  overrides: Partial<TemporalCodeAmendmentInstance> = {},
): TemporalCodeAmendmentInstance {
  return {
    entityType: "code-amendment",
    entityId: "bastrop_tx/ord-2025-14",
    jurisdictionTenant: "bastrop_tx",
    amendmentScope: "temporal",
    ordinanceId: "O-2025-14",
    effectiveDate: "2025-06-01",
    authority: "Bastrop City Council",
    affectedSectionIds: ["bastrop_tx/bastrop-udc/5-04"],
    amendmentText: "Section 5.04 is amended to revise the front setback.",
    replacesSectionContentHash: null,
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "municode-html",
    sourceUrl: "https://library.municode.com/tx/bastrop",
    contentHash: "temphash1",
    ...overrides,
  };
}

function makeOverlay(
  overrides: Partial<JurisdictionalOverlayAmendmentInstance> = {},
): JurisdictionalOverlayAmendmentInstance {
  return {
    entityType: "code-amendment",
    entityId: "hutto_tx/overlay/irc-2021/r301-2",
    jurisdictionTenant: "hutto_tx",
    amendmentScope: "jurisdictional-overlay",
    ordinanceId: "O-2022-031",
    effectiveDate: "2022-09-15",
    authority: "Hutto City Council",
    affectedSectionIds: ["icc/irc-2021/r301-2"],
    amendmentText:
      "Section R301.2 is amended to adopt the local ground snow load and wind speed.",
    baseEditionId: "icc/irc-2021",
    overlayOperation: "modify",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "ecode360-html",
    sourceUrl: "https://ecode360.com/HU6354",
    contentHash: "overlayhash1",
    ...overrides,
  };
}

function lookupFor(inst: CodeAmendmentAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (entityType === "code-amendment" && entityId === inst.entityId) {
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

describe("code-amendment — discriminated-union schema", () => {
  it("accepts a well-formed temporal amendment", () => {
    expect(CODE_AMENDMENT_SCHEMA.safeParse(makeTemporal()).success).toBe(true);
  });

  it("accepts a well-formed jurisdictional overlay", () => {
    expect(CODE_AMENDMENT_SCHEMA.safeParse(makeOverlay()).success).toBe(true);
  });

  it("accepts every overlay operation", () => {
    for (const overlayOperation of OVERLAY_OPERATIONS) {
      expect(
        CODE_AMENDMENT_SCHEMA.safeParse(makeOverlay({ overlayOperation }))
          .success,
        `${overlayOperation} should validate`,
      ).toBe(true);
    }
  });

  it("parses a temporal payload to the temporal arm", () => {
    const result = CODE_AMENDMENT_SCHEMA.safeParse(makeTemporal());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amendmentScope).toBe("temporal");
    }
  });

  it("rejects an overlay missing baseEditionId", () => {
    const bad: Record<string, unknown> = { ...makeOverlay() };
    delete bad.baseEditionId;
    expect(CODE_AMENDMENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects an overlay missing overlayOperation", () => {
    const bad: Record<string, unknown> = { ...makeOverlay() };
    delete bad.overlayOperation;
    expect(CODE_AMENDMENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects a temporal amendment missing replacesSectionContentHash", () => {
    const bad: Record<string, unknown> = { ...makeTemporal() };
    delete bad.replacesSectionContentHash;
    expect(CODE_AMENDMENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown amendmentScope", () => {
    const bad = { ...makeTemporal(), amendmentScope: "permanent" };
    expect(CODE_AMENDMENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown overlayOperation", () => {
    const bad = { ...makeOverlay(), overlayOperation: "supersede" };
    expect(CODE_AMENDMENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty ordinanceId on both scopes", () => {
    expect(
      CODE_AMENDMENT_SCHEMA.safeParse(makeTemporal({ ordinanceId: "" }))
        .success,
    ).toBe(false);
    expect(
      CODE_AMENDMENT_SCHEMA.safeParse(makeOverlay({ ordinanceId: "" }))
        .success,
    ).toBe(false);
  });

  it("AMENDMENT_SCOPES and OVERLAY_OPERATIONS enumerate the unions", () => {
    expect([...AMENDMENT_SCOPES].sort()).toEqual([
      "jurisdictional-overlay",
      "temporal",
    ]);
    expect([...OVERLAY_OPERATIONS].sort()).toEqual([
      "add",
      "delete",
      "modify",
      "replace",
    ]);
  });
});

describe("code-amendment — type guards", () => {
  it("isJurisdictionalOverlay narrows the overlay arm", () => {
    const a: CodeAmendmentAtomInstance = makeOverlay();
    expect(isJurisdictionalOverlay(a)).toBe(true);
    expect(isTemporalAmendment(a)).toBe(false);
    if (isJurisdictionalOverlay(a)) {
      // Type narrowing: overlay fields are reachable without a cast.
      expect(a.baseEditionId).toBe("icc/irc-2021");
      expect(a.overlayOperation).toBe("modify");
    }
  });

  it("isTemporalAmendment narrows the temporal arm", () => {
    const a: CodeAmendmentAtomInstance = makeTemporal();
    expect(isTemporalAmendment(a)).toBe(true);
    expect(isJurisdictionalOverlay(a)).toBe(false);
    if (isTemporalAmendment(a)) {
      expect(a.replacesSectionContentHash).toBeNull();
    }
  });
});

describe("code-amendment — @ts-expect-error widening rejection", () => {
  it("rejects widened literals at compile time", () => {
    // @ts-expect-error — amendmentScope is a fixed literal union
    const badScope: CodeAmendmentAtomInstance["amendmentScope"] = "permanent";
    void badScope;
    // @ts-expect-error — overlayOperation is a fixed literal union
    const badOp: OverlayOperation = "supersede";
    void badOp;
    expect(true).toBe(true);
  });
});

describe("code-amendment — registry registration", () => {
  it("registers under domain code-corpus as a single entityType", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "code-amendment");
    expect(reg.entityType).toBe("code-amendment");
    expect(reg.domain).toBe("code-corpus");
  });

  it("resolves a temporal amendment, surfacing the scope", async () => {
    const inst = makeTemporal();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "code-amendment");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("temporal amendment");
    expect(summary.typed.amendmentScope).toBe("temporal");
    expect(summary.keyMetrics.some((m) => m.value === "temporal")).toBe(true);
  });

  it("resolves a jurisdictional overlay, surfacing operation + base edition", async () => {
    const inst = makeOverlay();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "code-amendment");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("jurisdictional overlay");
    expect(summary.prose).toContain("modify");
    expect(summary.typed.amendmentScope).toBe("jurisdictional-overlay");
    expect(summary.typed.baseEditionId).toBe("icc/irc-2021");
    expect(summary.typed.overlayOperation).toBe("modify");
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeTemporal();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "code-amendment");
    const summary = await reg.contextSummary("bastrop_tx/ord-missing", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });
});
