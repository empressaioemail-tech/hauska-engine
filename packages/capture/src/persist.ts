import type { EventCaptureAtom } from "@hauska-engine/atom-contract-pin/tce";
import type { EventCaptureStore } from "@hauska-engine/storage";

import {
  CAPTURE_PERSIST_FAILURE_COUNTER,
  type CaptureRunMonitor,
} from "./monitor.js";

export interface CapturePersistLogger {
  error(payload: Record<string, unknown>): void;
}

const defaultLogger: CapturePersistLogger = {
  error(payload) {
    console.error(JSON.stringify({ level: "ERROR", ...payload }));
  },
};

export interface PersistCapturedEventsInput {
  feedName: string;
  source: string;
  knowledgeTime: string;
  items: ReadonlyArray<EventCaptureAtom>;
  store: EventCaptureStore;
  monitor?: CaptureRunMonitor;
  logger?: CapturePersistLogger;
}

export interface PersistCapturedEventsResult {
  written: number;
  skippedDuplicate: number;
  failed: number;
}

/**
 * Idempotent persist on (source, stable_external_id, valid_from).
 * Fire-and-forget callers should `.catch` only for catastrophic throws;
 * per-item failures are logged + counted, never thrown.
 */
export async function persistCapturedEvents(
  input: PersistCapturedEventsInput,
): Promise<PersistCapturedEventsResult> {
  const logger = input.logger ?? defaultLogger;
  let written = 0;
  let skippedDuplicate = 0;
  let failed = 0;

  for (const atom of input.items) {
    try {
      const outcome = await input.store.writeEventCaptureAtom(atom);
      if (outcome === "written") written += 1;
      else skippedDuplicate += 1;
    } catch (err) {
      failed += 1;
      input.monitor?.incrementCapturePersistFailure(input.feedName);
      logger.error({
        event: "capture.persist_failed",
        counter: CAPTURE_PERSIST_FAILURE_COUNTER,
        feedName: input.feedName,
        source: input.source,
        stable_external_id: atom.stable_external_id,
        valid_from: atom.valid_from,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { written, skippedDuplicate, failed };
}

/**
 * Fire-and-forget wrapper — display fetch must not await or fail on persist.
 * knowledgeTime is stamped at fetch time in the ingest layer and passed through.
 */
export function persistCapturedEventsFireAndForget(
  input: PersistCapturedEventsInput,
): void {
  void persistCapturedEvents(input).catch((err) => {
    const logger = input.logger ?? defaultLogger;
    input.monitor?.incrementCapturePersistFailure(input.feedName);
    logger.error({
      event: "capture.persist_batch_failed",
      counter: CAPTURE_PERSIST_FAILURE_COUNTER,
      feedName: input.feedName,
      source: input.source,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
