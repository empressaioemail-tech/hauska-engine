/**
 * Known-late LEASE_REQUIRED guard. Planning marker is emitted first.
 * The early-refuse predicate must FAIL this process. Not a writer.
 */
import { refuseApplyWithoutRunId } from "./writer-apply-lease.mjs";

console.log("PLANNING_STARTED");
const apply = process.argv.includes("--apply");
const hasRunId = process.argv.some((a) => a === "--run-id" || a.startsWith("--run-id="));
if (refuseApplyWithoutRunId("late-guard.refused", apply, hasRunId ? "x" : null)) {
  process.exit(2);
}
