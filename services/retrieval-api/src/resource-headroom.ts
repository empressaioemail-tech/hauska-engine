/**
 * G2 resource-headroom gate for retrieval-api.
 *
 * The in-memory snapshot path JSON.parses the whole corpus into the heap.
 * Breadth-era Postgres growth + LayeredStorage.countAtoms already OOMd a
 * 1Gi Cloud Run revision. This module fails closed when a projected heap
 * load would exceed the configured memory limit.
 */

import { stat } from "node:fs/promises";

/** Observed inflation: ~73MB snapshot → ~240MB+ heap; leave headroom for V8/runtime. */
export const SNAPSHOT_HEAP_INFLATION = 8;
/** Keep 30% of the container for runtime, pools, and request handling. */
export const HEADROOM_FRACTION = 0.7;

export interface HeadroomCheckInput {
  snapshotPath: string;
  /** Container memory limit in MiB (Cloud Run `memory` / MEMORY_LIMIT_MIB). */
  memoryLimitMib: number;
  /** Optional override for tests. */
  fileSizeBytes?: number;
}

export interface HeadroomCheckResult {
  ok: boolean;
  fileSizeBytes: number;
  projectedHeapBytes: number;
  budgetBytes: number;
  memoryLimitMib: number;
  reason?: string;
}

export function resolveMemoryLimitMib(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    env.MEMORY_LIMIT_MIB ??
    env.CLOUD_RUN_MEMORY_MIB ??
    env.RETRIEVAL_MEMORY_LIMIT_MIB;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  // Cloud Run default for this service historically: 1Gi.
  return 1024;
}

export function projectSnapshotHeapBytes(fileSizeBytes: number): number {
  return fileSizeBytes * SNAPSHOT_HEAP_INFLATION;
}

export function evaluateSnapshotHeadroom(
  input: Omit<HeadroomCheckInput, "snapshotPath"> & { fileSizeBytes: number },
): HeadroomCheckResult {
  const projectedHeapBytes = projectSnapshotHeapBytes(input.fileSizeBytes);
  const budgetBytes = Math.floor(
    input.memoryLimitMib * 1024 * 1024 * HEADROOM_FRACTION,
  );
  if (projectedHeapBytes > budgetBytes) {
    return {
      ok: false,
      fileSizeBytes: input.fileSizeBytes,
      projectedHeapBytes,
      budgetBytes,
      memoryLimitMib: input.memoryLimitMib,
      reason: `projected snapshot heap ${projectedHeapBytes}B exceeds ${HEADROOM_FRACTION * 100}% of ${input.memoryLimitMib}MiB budget (${budgetBytes}B)`,
    };
  }
  return {
    ok: true,
    fileSizeBytes: input.fileSizeBytes,
    projectedHeapBytes,
    budgetBytes,
    memoryLimitMib: input.memoryLimitMib,
  };
}

/**
 * Fail closed when loading `snapshotPath` into memory would exceed headroom.
 * Throws so a Cloud Run revision never boots into the OOM crash-loop.
 */
export async function assertSnapshotHeadroom(
  snapshotPath: string,
  memoryLimitMib: number = resolveMemoryLimitMib(),
): Promise<HeadroomCheckResult> {
  const info = await stat(snapshotPath);
  const result = evaluateSnapshotHeadroom({
    fileSizeBytes: info.size,
    memoryLimitMib,
  });
  if (!result.ok) {
    throw new Error(
      `G2 resource-headroom check failed for ${snapshotPath}: ${result.reason}`,
    );
  }
  return result;
}
