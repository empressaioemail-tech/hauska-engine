/**
 * PgDocumentAtomStore — the restart-durable `DocumentAtomStore` impl.
 *
 * Atoms are persisted to Postgres (`document_ingest_atoms`), keyed by atom
 * DID. The full instance is stored as jsonb; projected columns support the
 * source-document listing + policy/verification queries.
 *
 * Idempotency is durable across process restarts: `writeDocumentAtom` does
 * `INSERT ... ON CONFLICT (atom_did) DO NOTHING RETURNING atom_did`. A row
 * returned means the atom was created this call; no row means it already
 * existed (re-ingest of the same document → `created: false`), read straight
 * from Postgres rather than a process-local map.
 *
 * The `postgres.Sql` handle is INJECTED. This class never opens a connection
 * of its own — connection lifecycle is owned by the composing store
 * (`DurableDocumentIngestStore` / `resolveDocumentIngestStore`).
 */

import type postgres from "postgres";

import {
  buildAtomDid,
  DOCUMENT_DERIVED_CLAIM_SCHEMA,
  SURVEY_RECORD_SCHEMA,
  UTILITY_BILL_RECORD_SCHEMA,
  type DocumentDerivedAtomInstance,
} from "@hauska-engine/atoms";

import type { DocumentAtomStore } from "./port.js";

/** entityType → the matching per-type Zod schema used to parse `atom_json`. */
const SCHEMA_BY_ENTITY_TYPE = {
  "document-derived-claim": DOCUMENT_DERIVED_CLAIM_SCHEMA,
  "survey-record": SURVEY_RECORD_SCHEMA,
  "utility-bill-record": UTILITY_BILL_RECORD_SCHEMA,
} as const;

/**
 * Parse a jsonb-stored atom back into a typed instance via the matching
 * per-entityType schema. Returns null on an unknown entityType or a parse
 * failure (a corrupt / schema-drifted row degrades to "not found" rather
 * than throwing — the read path stays honest).
 */
function parseStoredAtom(atomJson: unknown): DocumentDerivedAtomInstance | null {
  if (
    typeof atomJson !== "object" ||
    atomJson === null ||
    !("entityType" in atomJson)
  ) {
    return null;
  }
  const entityType = (atomJson as { entityType?: unknown }).entityType;
  if (typeof entityType !== "string") return null;
  const schema =
    SCHEMA_BY_ENTITY_TYPE[entityType as keyof typeof SCHEMA_BY_ENTITY_TYPE];
  if (!schema) return null;
  const parsed = schema.safeParse(atomJson);
  if (!parsed.success) return null;
  return parsed.data as DocumentDerivedAtomInstance;
}

interface AtomRow {
  atom_did: string;
}

interface AtomJsonRow {
  atom_json: unknown;
}

export class PgDocumentAtomStore implements DocumentAtomStore {
  constructor(private readonly sql: postgres.Sql) {}

  async writeDocumentAtom(
    instance: DocumentDerivedAtomInstance,
  ): Promise<{ atomDid: string; created: boolean }> {
    const atomDid = buildAtomDid(instance.entityType, instance.entityId).raw;

    // INSERT ... ON CONFLICT DO NOTHING RETURNING atom_did. A returned row
    // means this call created the atom; no row means it already existed
    // (restart-durable idempotency — re-ingest returns created: false).
    const rows = await this.sql<AtomRow[]>`
      INSERT INTO document_ingest_atoms (
        atom_did,
        entity_type,
        entity_id,
        jurisdiction_tenant,
        source_document_cid,
        access_policy,
        storage_relation,
        verification_status,
        confidence_value,
        atom_json
      ) VALUES (
        ${atomDid},
        ${instance.entityType},
        ${instance.entityId},
        ${instance.jurisdictionTenant},
        ${instance.sourceDocumentCid},
        ${instance.accessPolicy},
        ${instance.storageRelation},
        ${instance.verificationStatus},
        ${instance.confidence.value},
        ${this.sql.json(instance as unknown as Parameters<typeof this.sql.json>[0])}
      )
      ON CONFLICT (atom_did) DO NOTHING
      RETURNING atom_did
    `;

    return { atomDid, created: rows.length > 0 };
  }

  async getDocumentAtomByDid(
    atomDid: string,
  ): Promise<DocumentDerivedAtomInstance | null> {
    const rows = await this.sql<AtomJsonRow[]>`
      SELECT atom_json
      FROM document_ingest_atoms
      WHERE atom_did = ${atomDid}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return parseStoredAtom(row.atom_json);
  }

  async listAtomsBySourceDocumentCid(
    sourceDocumentCid: string,
  ): Promise<ReadonlyArray<DocumentDerivedAtomInstance>> {
    const rows = await this.sql<AtomJsonRow[]>`
      SELECT atom_json
      FROM document_ingest_atoms
      WHERE source_document_cid = ${sourceDocumentCid}
      ORDER BY created_at ASC, atom_did ASC
    `;
    const out: DocumentDerivedAtomInstance[] = [];
    for (const row of rows) {
      const atom = parseStoredAtom(row.atom_json);
      if (atom) out.push(atom);
    }
    return out;
  }
}
