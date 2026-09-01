/** StoragePort PK for a well-fact atom. body.atomDid stays wlfact_<hex>. */
export function wellFactPersistDid(entityId: string): string {
  return `did:hauska:well-fact:${entityId}`;
}

/**
 * Extras are planned rows that share an entityId with an earlier row.
 * That is the persist collapse: last-wins upsert, slice.length still counted.
 */
export function countWellFactPersistCollisions(
  atoms: ReadonlyArray<{ entityId: string }>,
): {
  unique: number;
  extras: number;
  collapsedEntityIds: ReadonlyArray<string>;
} {
  const seen = new Map<string, number>();
  for (const atom of atoms) {
    seen.set(atom.entityId, (seen.get(atom.entityId) ?? 0) + 1);
  }
  const collapsedEntityIds = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();
  let extras = 0;
  for (const n of seen.values()) extras += n - 1;
  return { unique: seen.size, extras, collapsedEntityIds };
}

/**
 * Intra-chunk refuse. Two copies of the same persist PK in one slice
 * used to last-wins at upsert while atomsWritten still counted slice.length.
 * After planner wellKey dedupe this path is starved; the throw is the
 * regression door, not a cross-chunk door.
 */
export function assertNoChunkPkCollapse(
  entityIds: ReadonlyArray<string>,
): { plannedIn: string[]; writtenOut: string[] } {
  const plannedIn = [...entityIds];
  const writtenOut = [...new Set(plannedIn.map((id) => wellFactPersistDid(id)))];
  if (writtenOut.length !== plannedIn.length) {
    const collapsed = plannedIn.filter(
      (id, idx) => plannedIn.indexOf(id) !== idx,
    );
    throw new Error(
      `CHUNK_PK_COLLAPSE planned=${plannedIn.length} unique=${writtenOut.length} ` +
        `collapsedEntityIds=${JSON.stringify([...new Set(collapsed)])}`,
    );
  }
  return { plannedIn, writtenOut };
}
