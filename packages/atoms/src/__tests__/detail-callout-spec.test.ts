/**
 * Conformance suite for the L4 `detail-callout-spec` atom.
 *
 * Per the 2026-05-19 Lane A.2 dispatch Phase D test plan: schema
 * validation (one arm per detail type), register() → contextSummary()
 * round-trip, @ts-expect-error widening rejection, push-state
 * transition tests, render-mode coverage.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  DETAIL_CALLOUT_PUSH_STATES,
  DETAIL_CALLOUT_SPEC_SCHEMA,
  DETAIL_CALLOUT_TYPES,
  isLegalPushTransition,
  LEGAL_PUSH_TRANSITIONS,
  type DetailCalloutPushState,
  type DetailCalloutSpec,
  type DetailCalloutSpecAtomInstance,
} from "../instances.js";

const SPEC_BY_TYPE: Record<string, DetailCalloutSpec> = {
  "door-schedule": {
    detailType: "door-schedule",
    rows: [
      {
        doorMark: "101A",
        doorType: "Single Flush",
        width: "3'-0\"",
        height: "7'-0\"",
        material: "Solid Core Wood",
        fireRating: "20 min",
        hardwareSet: "HW-3",
      },
    ],
  },
  "wall-section": {
    detailType: "wall-section",
    sectionMark: "A/A-501",
    cutLocation: "Through exterior wall at grid line 3",
    assemblyLayers: [
      { material: "Brick veneer", thickness: "3 5/8\"", function: "finish" },
      { material: "Air gap", thickness: "1\"", function: "drainage" },
      { material: "CMU", thickness: "8\"", function: "structure" },
    ],
    baseDatum: "T.O. Slab",
    topDatum: "T.O. Parapet",
  },
  "wall-type": {
    detailType: "wall-type",
    typeMark: "W1",
    assemblyLayers: [
      { material: "Gypsum board", thickness: "5/8\"", function: "finish" },
      { material: "Metal stud", thickness: "3 5/8\"", function: "structure" },
      { material: "Gypsum board", thickness: "5/8\"", function: "finish" },
    ],
    fireRating: "1 hr",
    stcRating: "STC 45",
  },
  "room-finish": {
    detailType: "room-finish",
    roomName: "Kitchen",
    roomNumber: "104",
    floorFinish: "Porcelain tile",
    baseFinish: "Tile base",
    wallFinish: "Painted gypsum",
    ceilingFinish: "Suspended ACT",
    ceilingHeight: "9'-0\"",
  },
};

function makeCallout(
  overrides: Partial<DetailCalloutSpecAtomInstance> = {},
): DetailCalloutSpecAtomInstance {
  return {
    entityType: "detail-callout-spec",
    entityId: "engagement-42/callout-001",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-revit-flow",
    sourceUrl: "",
    contentHash: "callouthash1",
    engagementId: "engagement-42",
    spec: SPEC_BY_TYPE["wall-type"]!,
    pushState: "pending",
    apsTaskRef: null,
    findingId: "engagement-42/finding-101",
    responseTaskId: "engagement-42/task-001",
    createdAt: "2026-05-19T00:00:00Z",
    pushedAt: null,
    actorId: "actor/architect-jane",
    principalActorId: "actor/principal-bob",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

function lookupFor(inst: DetailCalloutSpecAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (entityType === "detail-callout-spec" && entityId === inst.entityId) {
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

describe("detail-callout-spec — Zod schema (one arm per detail type)", () => {
  it("accepts a well-formed instance of every detail type", () => {
    for (const detailType of DETAIL_CALLOUT_TYPES) {
      const inst = makeCallout({ spec: SPEC_BY_TYPE[detailType]! });
      const result = DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(inst);
      expect(result.success, `${detailType} should validate`).toBe(true);
    }
  });

  it("accepts every push state", () => {
    for (const pushState of DETAIL_CALLOUT_PUSH_STATES) {
      expect(
        DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(makeCallout({ pushState })).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown detail type", () => {
    const bad = {
      ...makeCallout(),
      spec: { detailType: "stair-section", treads: 12 },
    };
    expect(DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects a payload that doesn't match its detailType arm", () => {
    // Claims door-schedule but carries wall-type fields.
    const bad = {
      ...makeCallout(),
      spec: { detailType: "door-schedule", typeMark: "W1", assemblyLayers: [] },
    };
    expect(DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown push state", () => {
    const bad = { ...makeCallout(), pushState: "in-review" };
    expect(DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty engagementId", () => {
    expect(
      DETAIL_CALLOUT_SPEC_SCHEMA.safeParse({
        ...makeCallout(),
        engagementId: "",
      }).success,
    ).toBe(false);
  });

  it("allows nullable apsTaskRef / findingId / responseTaskId / pushedAt", () => {
    const result = DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(
      makeCallout({
        apsTaskRef: null,
        findingId: null,
        responseTaskId: null,
        pushedAt: null,
        actorId: null,
        principalActorId: null,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a populated apsTaskRef for a pushed spec", () => {
    const result = DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(
      makeCallout({
        pushState: "pushed",
        apsTaskRef: "aps-workitem-abc123",
        pushedAt: "2026-05-20T00:00:00Z",
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("detail-callout-spec — @ts-expect-error widening rejection", () => {
  it("rejects widened literals at compile time", () => {
    // @ts-expect-error — pushState is a fixed literal union
    const badState: DetailCalloutSpecAtomInstance["pushState"] = "in-review";
    void badState;
    // @ts-expect-error — detailType discriminant is a fixed literal union
    const badType: DetailCalloutSpec["detailType"] = "stair-section";
    void badType;
    expect(true).toBe(true);
  });
});

describe("detail-callout-spec — push-state transitions", () => {
  it("permits the forward lifecycle pending → pushed → applied", () => {
    expect(isLegalPushTransition("pending", "pushed")).toBe(true);
    expect(isLegalPushTransition("pushed", "applied")).toBe(true);
  });

  it("permits pushed → rejected-by-user and rejected-by-user → pending re-attempt", () => {
    expect(isLegalPushTransition("pushed", "rejected-by-user")).toBe(true);
    expect(isLegalPushTransition("rejected-by-user", "pending")).toBe(true);
  });

  it("treats applied as terminal", () => {
    expect(LEGAL_PUSH_TRANSITIONS.applied).toEqual([]);
    for (const to of DETAIL_CALLOUT_PUSH_STATES) {
      expect(isLegalPushTransition("applied", to)).toBe(false);
    }
  });

  it("rejects skipping pending → applied (must pass through pushed)", () => {
    expect(isLegalPushTransition("pending", "applied")).toBe(false);
  });

  it("rejects pending → rejected-by-user (nothing pushed to reject)", () => {
    expect(isLegalPushTransition("pending", "rejected-by-user")).toBe(false);
  });
});

describe("detail-callout-spec — registry registration", () => {
  it("registers under domain cortex with five render modes", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "detail-callout-spec");
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
    const reg = resolveOrThrow(registry, "detail-callout-spec");
    expect(reg.accessPolicy).toBe("tenant-private");
    expect(reg.eventTypes).toEqual([
      "detail-callout-spec.created",
      "detail-callout-spec.pushed",
      "detail-callout-spec.applied",
      "detail-callout-spec.rejected",
    ]);
    expect(reg.composition).toEqual([]);
  });
});

describe("detail-callout-spec — contextSummary round-trip", () => {
  it("resolves a pending wall-type callout to a four-layer summary", async () => {
    const inst = makeCallout();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "detail-callout-spec");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("wall-type");
    expect(summary.prose).toContain("pending");
    expect(summary.typed.detailType).toBe("wall-type");
    expect(summary.typed.pushState).toBe("pending");
    expect(summary.keyMetrics.some((m) => m.value === "wall-type")).toBe(true);
  });

  it("a pushed callout surfaces the APS task ref + pushedAt provenance", async () => {
    const inst = makeCallout({
      spec: SPEC_BY_TYPE["door-schedule"]!,
      pushState: "pushed",
      apsTaskRef: "aps-workitem-abc123",
      pushedAt: "2026-05-20T08:00:00Z",
    });
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "detail-callout-spec");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.prose).toContain("aps-workitem-abc123");
    expect(summary.typed.detailType).toBe("door-schedule");
    expect(summary.historyProvenance.latestEventAt).toBe("2026-05-20T08:00:00Z");
  });

  it("user-audience prose is compact (scopeFiltered)", async () => {
    const inst = makeCallout();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "detail-callout-spec");
    const summary = await reg.contextSummary(inst.entityId, { audience: "user" });
    expect(summary.scopeFiltered).toBe(true);
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeCallout();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "detail-callout-spec");
    const summary = await reg.contextSummary("engagement-42/callout-999", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });
});
