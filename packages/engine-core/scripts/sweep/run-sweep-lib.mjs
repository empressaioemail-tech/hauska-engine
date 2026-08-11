/**
 * Pure helpers for run_sweep.mjs — extracted for unit tests only.
 */

/** Strip UTF-8 BOM prefix when reading progress.json (and similar JSON text). */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

/** Skip set = landed county FIPS only; halted is NOT an exclusion. */
export function buildSkipSet(progress) {
  return new Set(progress.landed.map((x) => x.countyFips));
}

/**
 * Build the sweep queue from sizing.queueSmallestFirst, excluding landed counties.
 * If progress.halted?.countyFips exists and that county is not landed, move it to
 * the front (resume pointer semantics).
 */
export function buildQueue(queueSmallestFirst, progress) {
  const skip = buildSkipSet(progress);
  const queue = queueSmallestFirst.filter((c) => !skip.has(c.countyFips));

  const haltedFips = progress.halted?.countyFips;
  if (haltedFips && !skip.has(haltedFips)) {
    const idx = queue.findIndex((c) => c.countyFips === haltedFips);
    if (idx > 0) {
      const [entry] = queue.splice(idx, 1);
      queue.unshift(entry);
    }
  }

  return queue;
}
