import { describe, expect, it } from "vitest";

import {
  bastropPlanningAgendaFeed,
  InMemoryCaptureRunMonitor,
  persistCapturedEvents,
  runEventFeedCapture,
} from "../index.js";
import { InMemoryTceStore } from "@hauska-engine/storage";

describe("TCE capture — bastrop planning agenda feed", () => {
  it("writes atoms with knowledge_time ≠ valid_from and dedupes on re-run", async () => {
    const store = new InMemoryTceStore();
    const knowledgeTime = "2026-06-30T12:00:00.000Z";

    const first = await runEventFeedCapture({
      feed: bastropPlanningAgendaFeed,
      store,
      graph: store,
      knowledgeTime,
    });

    expect(first.display.items).toHaveLength(2);
    expect(first.persist?.written).toBe(2);
    expect(await store.countEventCaptureAtoms()).toBe(2);

    const atoms = await store.listEventCaptureAtoms();
    for (const atom of atoms) {
      expect(atom.knowledge_time).toBe(knowledgeTime);
      expect(atom.valid_from).not.toBe(atom.knowledge_time);
      expect(atom.accessPolicy).toBe("platform-internal");
    }

    const second = await runEventFeedCapture({
      feed: bastropPlanningAgendaFeed,
      store,
      graph: store,
      knowledgeTime: "2026-06-30T13:00:00.000Z",
    });
    expect(second.persist?.written).toBe(0);
    expect(second.persist?.skippedDuplicate).toBe(2);
    expect(await store.countEventCaptureAtoms()).toBe(2);
  });

  it("does not break display when persist fails", async () => {
    const store = {
      async writeEventCaptureAtom() {
        throw new Error("disk full");
      },
      async countEventCaptureAtoms() {
        return 0;
      },
      async listEventCaptureAtoms() {
        return [];
      },
    };
    const monitor = new InMemoryCaptureRunMonitor();
    const display = await bastropPlanningAgendaFeed.fetch({});
    const result = await persistCapturedEvents({
      feedName: bastropPlanningAgendaFeed.feedName,
      source: bastropPlanningAgendaFeed.registry.source,
      knowledgeTime: new Date().toISOString(),
      items: display.items.map((item) => ({
        family: "event" as const,
        claim_type: item.claim_type,
        valid_from: item.stated_date,
        knowledge_time: "2026-06-30T12:00:00.000Z",
        provenance: {
          source: bastropPlanningAgendaFeed.registry.source,
          retrieved_at: "2026-06-30T12:00:00.000Z",
          license: "public-record",
          derived_ok: true,
        },
        accessPolicy: "platform-internal" as const,
        content: {
          event_type: item.event_type,
          stated_date: item.stated_date,
          subject_ids: [...item.subject_ids],
          summary: item.summary,
          raw_url: item.raw_url,
        },
        stable_external_id: item.stable_external_id,
      })),
      store,
      monitor,
    });
    expect(display.items.length).toBeGreaterThan(0);
    expect(result.failed).toBe(display.items.length);
    expect(
      monitor.getCapturePersistFailureCount(bastropPlanningAgendaFeed.feedName),
    ).toBe(display.items.length);
  });
});
