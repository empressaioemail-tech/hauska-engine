/**
 * Boot-time storage resolver for retrieval-api.
 *
 * G2 (F1 Phase 0): when SUBSTRATE_DATABASE_URL / DATABASE_URL is set, serve
 * from Postgres (PgStorage) ONLY. The in-memory snapshot hydrate path is
 * retired for production — JSON.parse of the corpus into a 1Gi heap is what
 * OOM-crash-looped retrieval after the Central-TX breadth bakes.
 *
 * Snapshot-only remains for local/dev when no substrate URL is configured.
 * ALLOW_SNAPSHOT_OVERLAY=1 re-enables legacy LayeredStorage (explicit opt-in;
 * still subject to the resource-headroom check at the call site).
 */

import {
  createPgStorage,
  InMemoryStorage,
  LayeredStorage,
  resolveSubstrateDatabaseUrl,
  type StoragePort,
} from "@hauska-engine/storage";

export type BootStorageMode = "postgres" | "layered" | "snapshot" | "empty";

export interface BootStorageHandle {
  storage: StoragePort;
  mode: BootStorageMode;
  close: () => Promise<void>;
}

export interface BootStorageOptions {
  /** Snapshot corpus. Ignored for postgres-only boot unless overlay is allowed. */
  snapshot?: InMemoryStorage;
  substrateDatabaseUrl?: string;
  /**
   * Explicit opt-in to LayeredStorage(Pg, snapshot). Production must leave
   * this false — overlay still hydrates the full snapshot into the heap.
   */
  allowSnapshotOverlay?: boolean;
}

/**
 * Build the production storage stack. Opens a Postgres pool when configured;
 * caller must call `close()` on process shutdown.
 */
export function bootRetrievalStorage(
  options: BootStorageOptions,
): BootStorageHandle {
  const databaseUrl = resolveSubstrateDatabaseUrl(options.substrateDatabaseUrl);
  const snapshot = options.snapshot ?? new InMemoryStorage();

  if (databaseUrl) {
    const pg = createPgStorage({ databaseUrl });
    if (options.allowSnapshotOverlay) {
      return {
        storage: new LayeredStorage({
          primary: pg.storage,
          snapshot,
        }),
        mode: "layered",
        close: pg.close,
      };
    }
    return {
      storage: pg.storage,
      mode: "postgres",
      close: pg.close,
    };
  }

  if (options.snapshot) {
    return {
      storage: options.snapshot,
      mode: "snapshot",
      close: async () => {},
    };
  }

  return {
    storage: new InMemoryStorage(),
    mode: "empty",
    close: async () => {},
  };
}
