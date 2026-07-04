import type { EventCaptureStore, StructuralGraphStore } from "@hauska-engine/storage";
import { buildWouldAffectEdgesForCapture } from "@hauska-engine/storage";

import { bastropPlanningAgendaFeed } from "./feeds/bastrop-planning-agenda.js";
import type { EventFeed } from "./feeds/types.js";
import { toEventCaptureAtoms } from "./feeds/types.js";
import {
  persistCapturedEvents,
  persistCapturedEventsFireAndForget,
} from "./persist.js";
import type { CaptureRunMonitor } from "./monitor.js";

export * from "./feeds/types.js";
export { bastropPlanningAgendaFeed } from "./feeds/bastrop-planning-agenda.js";
export * from "./persist.js";
export * from "./monitor.js";

export const EVENT_FEEDS: ReadonlyArray<EventFeed> = [bastropPlanningAgendaFeed];

export interface RunEventFeedCaptureInput {
  feed: EventFeed;
  store: EventCaptureStore;
  graph?: StructuralGraphStore;
  monitor?: CaptureRunMonitor;
  knowledgeTime?: string;
  /** When true, persist runs fire-and-forget (production display path). */
  fireAndForget?: boolean;
}

export interface RunEventFeedCaptureResult {
  display: Awaited<ReturnType<EventFeed["fetch"]>>;
  knowledgeTime: string;
  persist?: Awaited<ReturnType<typeof persistCapturedEvents>>;
}

/**
 * Display fetch + parallel capture persist. Persist failures never reject
 * the display result.
 */
export async function runEventFeedCapture(
  input: RunEventFeedCaptureInput,
): Promise<RunEventFeedCaptureResult> {
  const knowledgeTime = input.knowledgeTime ?? new Date().toISOString();
  const display = await input.feed.fetch({});
  const atoms = toEventCaptureAtoms(input.feed, display, knowledgeTime);

  if (input.fireAndForget) {
    persistCapturedEventsFireAndForget({
      feedName: input.feed.feedName,
      source: input.feed.registry.source,
      knowledgeTime,
      items: atoms,
      store: input.store,
      monitor: input.monitor,
    });
    return { display, knowledgeTime };
  }

  const persist = await persistCapturedEvents({
    feedName: input.feed.feedName,
    source: input.feed.registry.source,
    knowledgeTime,
    items: atoms,
    store: input.store,
    monitor: input.monitor,
  });

  if (input.graph) {
    for (const atom of atoms) {
      for (const edge of buildWouldAffectEdgesForCapture(atom)) {
        await input.graph.writeWouldAffectEdge(edge);
      }
    }
  }

  return { display, knowledgeTime, persist };
}
