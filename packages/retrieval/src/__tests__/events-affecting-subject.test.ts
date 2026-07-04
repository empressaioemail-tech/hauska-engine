import { describe, expect, it } from "vitest";

import { resolveEvtId } from "@hauska-engine/identity";
import { writeWouldAffectEdge } from "../events-affecting-subject.js";
import { InMemoryStructuralGraphStore } from "@hauska-engine/storage";

describe("would_affect edges", () => {
  it("writes edges and queries by target subject", async () => {
    const store = new InMemoryStructuralGraphStore();
    const source = "https://example.gov/agenda";
    const evtId = resolveEvtId(source, "item-1");

    await writeWouldAffectEdge(store, {
      type: "would_affect",
      sourceNodeId: evtId,
      targetSubjectId: "parcel_a",
      effectiveDate: "2026-07-01T00:00:00Z",
      immutable: true,
    });
    await writeWouldAffectEdge(store, {
      type: "would_affect",
      sourceNodeId: evtId,
      targetSubjectId: "parcel_b",
      effectiveDate: "2026-07-01T00:00:00Z",
      immutable: true,
    });

    const forA = await store.queryEventsAffectingSubject("parcel_a");
    expect(forA).toHaveLength(1);
    expect(forA[0]?.evtNodeId).toBe(evtId);

    const forJurisdiction = await store.queryEventsAffectingSubject("parcel_b");
    expect(forJurisdiction).toHaveLength(1);
  });

  it("rejects missing effectiveDate", async () => {
    const store = new InMemoryStructuralGraphStore();
    await expect(
      writeWouldAffectEdge(store, {
        type: "would_affect",
        sourceNodeId: "evt_abcabcabcabcabcabcabcabcabcabc",
        targetSubjectId: "parcel_a",
        effectiveDate: "not-a-date",
        immutable: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects non-evt_ sourceNodeId", async () => {
    const store = new InMemoryStructuralGraphStore();
    await expect(
      writeWouldAffectEdge(store, {
        type: "would_affect",
        sourceNodeId: "parcel_fake",
        targetSubjectId: "parcel_a",
        effectiveDate: "2026-07-01T00:00:00Z",
        immutable: true,
      }),
    ).rejects.toThrow(/evt_ prefix/);
  });
});
