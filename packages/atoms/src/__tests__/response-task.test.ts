/**
 * Conformance suite for the L1 `response-task` atom.
 *
 * Per the 2026-05-19 Lane A.2 dispatch test plan: schema validation,
 * register() → contextSummary() round-trip, render-mode coverage,
 * ADR-017 access policy, ADR-015 actor linking, state-enum integrity.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  RESPONSE_TASK_SCHEMA,
  RESPONSE_TASK_STATES,
  type ResponseTaskAtomInstance,
} from "../instances.js";

function makeResponseTask(
  overrides: Partial<ResponseTaskAtomInstance> = {},
): ResponseTaskAtomInstance {
  return {
    entityType: "response-task",
    entityId: "engagement-42/task-001",
    jurisdictionTenant: "moab-ut",
    fetchedAt: "2026-05-19T00:00:00Z",
    sourceAdapter: "cortex-response-flow",
    sourceUrl: "",
    contentHash: "abc123",
    title: "Address AHJ comment on egress width",
    description: "Revise stair 2 egress to 44in clear per reviewer comment.",
    state: "open",
    createdAt: "2026-05-19T00:00:00Z",
    dueAt: "2026-05-26T00:00:00Z",
    completedAt: null,
    sourceClientCommentId: "engagement-42/comment-007",
    findingId: "engagement-42/finding-101",
    engagementId: "engagement-42",
    actorId: "actor/architect-jane",
    principalActorId: "actor/principal-bob",
    accessPolicy: "tenant-private",
    ...overrides,
  };
}

/** In-memory lookup so contextSummary can resolve without storage. */
function lookupFor(inst: ResponseTaskAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (entityType === "response-task" && entityId === inst.entityId) {
        return inst as never;
      }
      return null;
    },
  };
}

/** Unwrap the discriminated ResolveResult or throw. */
function resolveOrThrow(
  registry: ReturnType<typeof bootstrapEngineAtomRegistry>,
  entityType: string,
) {
  const result = registry.resolve(entityType);
  if (!result.ok) throw result.error;
  return result.registration;
}

describe("response-task — Zod schema validation", () => {
  it("accepts a well-formed instance", () => {
    const result = RESPONSE_TASK_SCHEMA.safeParse(makeResponseTask());
    expect(result.success).toBe(true);
  });

  it("accepts every valid state", () => {
    for (const state of RESPONSE_TASK_STATES) {
      const result = RESPONSE_TASK_SCHEMA.safeParse(makeResponseTask({ state }));
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown state with a clear error", () => {
    const bad = { ...makeResponseTask(), state: "archived" };
    const result = RESPONSE_TASK_SCHEMA.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("state");
    }
  });

  it("rejects a missing required field (title)", () => {
    const bad = { ...makeResponseTask(), title: "" };
    const result = RESPONSE_TASK_SCHEMA.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a wrong entityType", () => {
    const bad = { ...makeResponseTask(), entityType: "code-section" };
    const result = RESPONSE_TASK_SCHEMA.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("allows nullable link fields to be null", () => {
    const result = RESPONSE_TASK_SCHEMA.safeParse(
      makeResponseTask({
        dueAt: null,
        completedAt: null,
        sourceClientCommentId: null,
        findingId: null,
        engagementId: null,
        actorId: null,
        principalActorId: null,
      }),
    );
    expect(result.success).toBe(true);
  });

  it("allows accessPolicy to be omitted", () => {
    const { accessPolicy, ...withoutPolicy } = makeResponseTask();
    void accessPolicy;
    const result = RESPONSE_TASK_SCHEMA.safeParse(withoutPolicy);
    expect(result.success).toBe(true);
  });
});

describe("response-task — registry registration", () => {
  it("registers under the engine atom-registry", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "response-task");
    expect(reg.entityType).toBe("response-task");
    expect(reg.domain).toBe("cortex");
  });

  it("supports all five render modes with card as default", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "response-task");
    expect([...reg.supportedModes].sort()).toEqual([
      "card",
      "compact",
      "expanded",
      "focus",
      "inline",
    ]);
    expect(reg.defaultMode).toBe("card");
  });

  it("declares the audit-chain event types", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "response-task");
    expect(reg.eventTypes).toEqual([
      "response-task.opened",
      "response-task.progressed",
      "response-task.completed",
      "response-task.cancelled",
    ]);
  });

  it("defaults accessPolicy to tenant-private (ADR-017)", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "response-task");
    expect(reg.accessPolicy).toBe("tenant-private");
  });

  it("declares no owned children (leaf atom for v1)", () => {
    const registry = bootstrapEngineAtomRegistry();
    const reg = resolveOrThrow(registry, "response-task");
    expect(reg.composition).toEqual([]);
  });
});

describe("response-task — contextSummary round-trip", () => {
  it("resolves a registered instance to a four-layer summary", async () => {
    const inst = makeResponseTask();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "response-task");
    const summary = await reg.contextSummary(inst.entityId, {
      audience: "ai",
    });
    expect(summary.prose).toContain(inst.title);
    expect(summary.prose).toContain(inst.state);
    expect(summary.typed.state).toBe("open");
    expect(summary.typed.actorId).toBe("actor/architect-jane");
    expect(summary.typed.principalActorId).toBe("actor/principal-bob");
    expect(summary.keyMetrics.some((m) => m.value === "open")).toBe(true);
    expect(summary.historyProvenance.latestEventId).toContain(inst.entityId);
  });

  it("user-audience prose is compact (scopeFiltered)", async () => {
    const inst = makeResponseTask();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "response-task");
    const summary = await reg.contextSummary(inst.entityId, {
      audience: "user",
    });
    expect(summary.scopeFiltered).toBe(true);
    expect(summary.prose).not.toContain(inst.description);
  });

  it("returns a not-found summary for an unknown entityId", async () => {
    const inst = makeResponseTask();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "response-task");
    const summary = await reg.contextSummary("engagement-42/task-999", {
      audience: "ai",
    });
    expect(summary.prose).toContain("not found");
  });

  it("completed task surfaces completedAt as the latest-event timestamp", async () => {
    const inst = makeResponseTask({
      state: "done",
      completedAt: "2026-05-22T12:00:00Z",
    });
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "response-task");
    const summary = await reg.contextSummary(inst.entityId, {
      audience: "ai",
    });
    expect(summary.historyProvenance.latestEventAt).toBe("2026-05-22T12:00:00Z");
  });
});
