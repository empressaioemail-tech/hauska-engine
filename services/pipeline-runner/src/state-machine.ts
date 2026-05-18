/**
 * Pipeline job state machine.
 *
 * Each transition is explicit; the runner asserts the FROM state
 * before transitioning. Terminal states are `loaded` and `failed`.
 */

export type JobState =
  | "queued"
  | "fetching"
  | "extracted"
  | "atomized"
  | "indexed"
  | "eval-running"
  | "loaded"
  | "failed";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "loaded",
  "failed",
]);

const TRANSITIONS: Record<JobState, ReadonlyArray<JobState>> = {
  queued: ["fetching", "failed"],
  fetching: ["extracted", "failed"],
  extracted: ["atomized", "failed"],
  atomized: ["indexed", "failed"],
  indexed: ["eval-running", "failed"],
  "eval-running": ["loaded", "failed"],
  loaded: [],
  failed: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid pipeline transition: ${from} -> ${to} (allowed from ${from}: ${TRANSITIONS[from].join(", ") || "none"})`,
    );
  }
}
