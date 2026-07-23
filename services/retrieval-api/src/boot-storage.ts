/**
 * Boot-time storage resolver for retrieval-api.
 *
 * When SUBSTRATE_DATABASE_URL is set alongside a corpus snapshot, returns
 * LayeredStorage(PgStorage, snapshot). Snapshot-only when no DB URL.
 */

import {
  createPgStorage,
  InMemoryStorage,
  LayeredStorage,
  resolveSubstrateDatabaseUrl,
  type StoragePort,
} from "@hauska-engine/storage";

export interface BootStorageHandle {
  storage: StoragePort;
  close: () => Promise<void>;
}

export interface BootStorageOptions {
  snapshot: InMemoryStorage;
  substrateDatabaseUrl?: string;
}

/**
 * Build the production storage stack. Opens a Postgres pool when configured;
 * caller must call `close()` on process shutdown.
 */
export function bootRetrievalStorage(
  options: BootStorageOptions,
): BootStorageHandle {
  const databaseUrl = resolveSubstrateDatabaseUrl(options.substrateDatabaseUrl);
  if (!databaseUrl) {
    return {
      storage: options.snapshot,
      close: async () => {},
    };
  }

  const pg = createPgStorage({ databaseUrl });
  return {
    storage: new LayeredStorage({
      primary: pg.storage,
      snapshot: options.snapshot,
    }),
    close: pg.close,
  };
}
