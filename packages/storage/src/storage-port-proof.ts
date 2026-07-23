/**
 * Phase 1a proof atom — a unique code-section NOT present in snapshot.json.
 *
 * entityId: storage-port-proof/phase-1a
 * DID: did:hauska:code-section:storage-port-proof/phase-1a
 * searchable token: storage-port-proof
 */

import { sha256Hex } from "./content-hash.js";
import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

export const STORAGE_PORT_PROOF_ENTITY_ID = "storage-port-proof/phase-1a";
export const STORAGE_PORT_PROOF_ATOM_DID =
  "did:hauska:code-section:storage-port-proof/phase-1a";
export const STORAGE_PORT_PROOF_SEARCH_TOKEN = "storage-port-proof";

export function buildStoragePortProofAtom(
  fetchedAt = new Date().toISOString(),
): CodeSectionAtomInstance {
  const bodyText =
    "Phase 1a StoragePort proof section. Search token storage-port-proof confirms durable Postgres write and retrieval-api serve.";
  const instance: CodeSectionAtomInstance = {
    entityType: "code-section",
    entityId: STORAGE_PORT_PROOF_ENTITY_ID,
    jurisdictionTenant: "storage_port_proof_tx",
    fetchedAt,
    sourceAdapter: "storage-port-proof",
    sourceUrl: "https://hauska.dev/internal/storage-port-proof/phase-1a",
    contentHash: sha256Hex(bodyText),
    codeEditionId: "storage_port_proof_tx/edition-1a",
    sectionNumber: "SP-1a",
    title: "StoragePort Phase 1a proof section",
    subsectionPath: null,
    bodyText,
  };
  return instance;
}
