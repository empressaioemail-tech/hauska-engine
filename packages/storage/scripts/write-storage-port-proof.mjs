#!/usr/bin/env node
/**
 * write-storage-port-proof.mjs — durable-write proof atom for Gate A / WDLL 3.1.
 *
 * Writes the Phase 1a code-section proof atom to Postgres via PgStorage.
 * Idempotent upsert on atom_did.
 *
 *   DATABASE_URL='postgres://...neon.tech/...?sslmode=require' \
 *     node packages/storage/scripts/write-storage-port-proof.mjs
 */

import {
  STORAGE_PORT_PROOF_ATOM_DID,
  buildStoragePortProofAtom,
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

const url = resolveSubstrateDatabaseUrl();
if (!url) {
  console.error(
    "FATAL: neither DATABASE_URL nor SUBSTRATE_DATABASE_URL is set.",
  );
  process.exit(1);
}

const handle = createPgStorage({ databaseUrl: url, maxConnections: 1 });

try {
  const proof = buildStoragePortProofAtom();
  const { atomDid, cid } = await handle.storage.writeAtom(proof);
  const roundTrip = await handle.storage.getAtomByDid(atomDid);

  console.log(
    JSON.stringify(
      {
        event: "storage-port-proof.written",
        atomDid,
        expectedDid: STORAGE_PORT_PROOF_ATOM_DID,
        cid,
        entityId: proof.entityId,
        roundTripOk: roundTrip?.entityId === proof.entityId,
      },
      null,
      2,
    ),
  );

  if (atomDid !== STORAGE_PORT_PROOF_ATOM_DID) {
    throw new Error(`unexpected atomDid ${atomDid}`);
  }
  if (!roundTrip) {
    throw new Error("round-trip read failed");
  }

  await handle.close();
  process.exit(0);
} catch (err) {
  console.error("Write FAILED:", err instanceof Error ? err.message : err);
  await handle.close().catch(() => {});
  process.exit(1);
}
