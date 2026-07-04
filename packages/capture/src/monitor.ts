/**
 * E5 run-monitor counter surface for capture persist failures.
 */
export interface CaptureRunMonitor {
  /** Increment on each persist failure (structured ERROR already logged). */
  incrementCapturePersistFailure(feedName: string): void;
  /** Read current failure count for a feed (visible in E5). */
  getCapturePersistFailureCount(feedName: string): number;
}

export class InMemoryCaptureRunMonitor implements CaptureRunMonitor {
  private readonly counts = new Map<string, number>();

  incrementCapturePersistFailure(feedName: string): void {
    this.counts.set(feedName, (this.counts.get(feedName) ?? 0) + 1);
  }

  getCapturePersistFailureCount(feedName: string): number {
    return this.counts.get(feedName) ?? 0;
  }
}

/** Counter name surfaced to E5 operators. */
export const CAPTURE_PERSIST_FAILURE_COUNTER = "capture_persist_failure_total" as const;
