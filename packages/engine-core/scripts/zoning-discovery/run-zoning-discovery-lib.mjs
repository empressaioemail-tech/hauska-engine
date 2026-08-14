/**
 * Pure helpers for run_zoning_discovery.mjs — extracted for unit tests only.
 */

/** Strip UTF-8 BOM prefix when reading progress.json (and similar JSON text). */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

/** Skip set = landed cityKeys only; halted is NOT an exclusion. */
export function buildSkipSet(progress) {
  return new Set((progress.landed ?? []).map((x) => x.cityKey));
}

/**
 * Build discovery queue from input queue JSON, excluding landed cityKeys.
 * If progress.halted?.cityKey exists and that city is not landed, move it to front.
 */
export function buildQueue(inputQueue, progress) {
  const skip = buildSkipSet(progress);
  const queue = inputQueue.filter((item) => !skip.has(item.cityKey));

  const haltedKey = progress.halted?.cityKey;
  if (haltedKey && !skip.has(haltedKey)) {
    const idx = queue.findIndex((item) => item.cityKey === haltedKey);
    if (idx > 0) {
      const [entry] = queue.splice(idx, 1);
      queue.unshift(entry);
    }
  }

  return queue;
}

export const RUNNER_VERSION = "0.2.1";

/** Landed statuses for progress tracking (HOST-BROKEN is landed per CP1). */
export const LANDED_STATUSES = new Set([
  "NO-ZONING-AUTHORITY",
  "NO-EUCLIDEAN-REGIME",
  "ORDINANCE-NO-GIS",
  "AUTH-WALLED",
  "HOST-BROKEN",
  "LAYER-FOUND",
  // Production sweeps record NFUW as processed for this outDir so resume does
  // not re-probe the same empty-search cities forever. A later sweep can still
  // re-queue them by starting a fresh outDir.
  "NOT-FOUND-UNKNOWN-WHY",
]);

export function isLandedStatus(status) {
  return LANDED_STATUSES.has(status);
}
