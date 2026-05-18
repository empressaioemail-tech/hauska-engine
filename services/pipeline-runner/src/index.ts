/**
 * services/pipeline-runner — Stream 1A.
 *
 * Orchestrates the multi-stage ingest pipeline:
 *
 *   queued -> fetching -> extracted -> atomized -> indexed -> eval-running -> loaded / failed
 *
 * The state machine is driven by `runJob(jobId)` which moves a single
 * job from its current state through to terminal `loaded` or `failed`.
 * Cloud Run jobs invoke this as `npm start <jobId>` (or via a small
 * dispatcher loop pulling queued jobs); retry policy is enforced at
 * the job-port layer (attempt count + DLQ).
 *
 * The runner deliberately stays storage-port-agnostic — `JobPort`
 * + `StoragePort` are dependency-injected so tests run against
 * in-memory ports.
 */

export * from "./state-machine.js";
export * from "./job-port.js";
export * from "./runner.js";
