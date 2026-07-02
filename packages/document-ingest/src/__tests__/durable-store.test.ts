/**
 * Restart-durable idempotency test for the DurableDocumentIngestStore.
 *
 * The invariant (PR #78 + Phase 2): two SEPARATE store instances over the
 * SAME Postgres + GCS backend, re-ingesting the same content, return the
 * same blob cid and the same atom DIDs with created:false on the second
 * pass. This is what makes idempotency survive a process restart — the
 * dedup state lives in Postgres/GCS, not in a process-local Map.
 *
 * We do NOT hit real cloud. We inject:
 *   - a light in-memory fake of the `postgres.Sql` query surface the stores
 *     actually use (a tagged-template recognizer over shared Maps), and
 *   - a stub GCS `Storage` (in-memory bucket/file).
 * Both fakes are shared between the two freshly-constructed store objects,
 * standing in for one durable backend two processes connect to.
 */

import { describe, it, expect } from "vitest";

import {
  createDurableDocumentIngestStore,
  GcsDocumentBlobStore,
  PgBlobIndex,
  PgDocumentAtomStore,
  DurableDocumentIngestStore,
} from "../index.js";
import type {
  DocumentDerivedAtomInstance,
  SurveyRecordAtomInstance,
} from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";

// ---------------------------------------------------------------------------
// Shared in-memory backend fakes (stand in for one durable Postgres + GCS).
// ---------------------------------------------------------------------------

interface BlobRow {
  cid: string;
  content_hash: string;
  content_type: string;
  size: number;
  tenant: string;
  access_policy: string;
}
interface AtomStoredRow {
  atom_did: string;
  entity_type: string;
  entity_id: string;
  jurisdiction_tenant: string;
  source_document_cid: string;
  access_policy: string;
  storage_relation: string;
  verification_status: string;
  confidence_value: number;
  atom_json: unknown;
  created_at: number;
}

/** One shared Postgres-ish backend both store instances query through. */
class FakePgBackend {
  readonly blobs = new Map<string, BlobRow>(); // content_hash -> row
  readonly atoms = new Map<string, AtomStoredRow>(); // atom_did -> row
  private seq = 0;

  /**
   * A minimal `postgres.Sql`-shaped tag. It recognizes the exact queries
   * PgBlobIndex + PgDocumentAtomStore issue by matching the static template
   * text, and executes them against the shared Maps. `.json(x)` is a marker
   * that passes the value through (like postgres's json helper).
   */
  makeSql() {
    const backend = this;
    const jsonMarker = Symbol("json");

    const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();

      // PgBlobIndex.lookupCidByContentHash
      if (text.startsWith("SELECT cid FROM document_blobs WHERE content_hash")) {
        const hash = params[0] as string;
        const row = backend.blobs.get(hash);
        return Promise.resolve(row ? [{ cid: row.cid }] : []);
      }

      // PgBlobIndex.recordBlob
      if (text.startsWith("INSERT INTO document_blobs")) {
        const [cid, content_hash, content_type, size, tenant] = params as [
          string,
          string,
          string,
          number,
          string,
        ];
        if (!backend.blobs.has(content_hash)) {
          backend.blobs.set(content_hash, {
            cid,
            content_hash,
            content_type,
            size,
            tenant,
            access_policy: "tenant-private",
          });
        }
        return Promise.resolve([]);
      }

      // PgDocumentAtomStore.writeDocumentAtom
      if (text.startsWith("INSERT INTO document_ingest_atoms")) {
        const [
          atom_did,
          entity_type,
          entity_id,
          jurisdiction_tenant,
          source_document_cid,
          access_policy,
          storage_relation,
          verification_status,
          confidence_value,
          atomJsonParam,
        ] = params as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          unknown,
        ];
        if (backend.atoms.has(atom_did)) {
          return Promise.resolve([]); // ON CONFLICT DO NOTHING -> no row
        }
        const atom_json =
          atomJsonParam && (atomJsonParam as Record<symbol, unknown>)[jsonMarker]
            ? (atomJsonParam as Record<symbol | string, unknown>).value
            : atomJsonParam;
        backend.atoms.set(atom_did, {
          atom_did,
          entity_type,
          entity_id,
          jurisdiction_tenant,
          source_document_cid,
          access_policy,
          storage_relation,
          verification_status,
          confidence_value,
          atom_json,
          created_at: backend.seq++,
        });
        return Promise.resolve([{ atom_did }]); // RETURNING -> created
      }

      // PgDocumentAtomStore.getDocumentAtomByDid
      if (
        text.startsWith("SELECT atom_json FROM document_ingest_atoms WHERE atom_did")
      ) {
        const did = params[0] as string;
        const row = backend.atoms.get(did);
        return Promise.resolve(row ? [{ atom_json: row.atom_json }] : []);
      }

      // PgDocumentAtomStore.listAtomsBySourceDocumentCid
      if (
        text.startsWith(
          "SELECT atom_json FROM document_ingest_atoms WHERE source_document_cid",
        )
      ) {
        const cid = params[0] as string;
        const rows = [...backend.atoms.values()]
          .filter((r) => r.source_document_cid === cid)
          .sort((a, b) => a.created_at - b.created_at)
          .map((r) => ({ atom_json: r.atom_json }));
        return Promise.resolve(rows);
      }

      throw new Error(`FakePgBackend: unrecognized query: ${text}`);
    };

    // postgres().json(x) marker helper
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({
      [jsonMarker]: true,
      value: v,
    });

    // Cast to the injected handle type; the fake implements only the query
    // surface the stores use (tag call + .json), which is all they touch.
    return sql as unknown as ConstructorParameters<typeof PgBlobIndex>[0];
  }
}

/** One shared GCS-ish backend both store instances upload/download through. */
class FakeGcsBackend {
  readonly objects = new Map<string, string>(); // `${bucket}/${key}` -> body

  makeStorage() {
    const objects = this.objects;
    return {
      bucket(bucketName: string) {
        return {
          file(key: string) {
            const full = `${bucketName}/${key}`;
            return {
              async save(data: string) {
                objects.set(full, data);
              },
              async download(): Promise<[Buffer]> {
                const body = objects.get(full);
                if (body === undefined) {
                  const err = new Error("Not Found") as Error & { code: number };
                  err.code = 404;
                  throw err;
                }
                return [Buffer.from(body, "utf8")];
              },
            };
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------

const BUCKET = "test-doc-ingest-blobs";

function surveyAtom(
  overrides: Partial<SurveyRecordAtomInstance> = {},
): SurveyRecordAtomInstance {
  return {
    entityType: "survey-record",
    entityId: "parcel-42",
    jurisdictionTenant: "tenant-acme",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    sourceAdapter: "survey",
    sourceUrl: "survey.pdf",
    contentHash: "atomhash-1",
    sourceDocumentCid: "bafydoc-doc-hash-1",
    storageRelation: "point-to",
    extractedAt: "2026-07-02T00:00:00.000Z",
    verificationStatus: "extracted-unverified",
    confidence: { kind: "asserted", value: 0.6, intervalWidth: 0.3, n: 0 },
    accessPolicy: "tenant-private",
    parcelDescriptor: "Lot 4, Block B",
    acreage: 2.35,
    boundaryCalls: ["N 45°30'10\" E 210.5 feet"],
    surveyor: "John Smith, R.P.L.S.",
    recordingReference: "Vol 12 Pg 88",
    ...overrides,
  };
}

/** Build a fresh DurableDocumentIngestStore over the shared fakes. */
function freshStore(
  pg: FakePgBackend,
  gcs: FakeGcsBackend,
): DurableDocumentIngestStore {
  const sql = pg.makeSql();
  const index = new PgBlobIndex(sql);
  const blob = new GcsDocumentBlobStore({
    bucket: BUCKET,
    index,
    storage: gcs.makeStorage() as never,
  });
  const atoms = new PgDocumentAtomStore(sql);
  return new DurableDocumentIngestStore({ blob, atoms });
}

describe("DurableDocumentIngestStore — restart-durable idempotency", () => {
  it("two fresh store instances over ONE shared Postgres+GCS: second ingest returns created:false with the same cid + DIDs", async () => {
    const pg = new FakePgBackend();
    const gcs = new FakeGcsBackend();

    // Process A: first store instance pins a blob + writes an atom.
    const storeA = freshStore(pg, gcs);
    const pinA = await storeA.pinBlob({
      contentHash: "doc-hash-1",
      body: "RECORD OF SURVEY ... Lot 4 Block B ... 2.35 acres",
      contentType: "text/plain",
      size: 48,
    });
    expect(pinA.created).toBe(true);
    expect(pinA.cid).toBe("bafydoc-doc-hash-1");

    const atom = surveyAtom({ sourceDocumentCid: pinA.cid });
    const writeA = await storeA.writeDocumentAtom(atom);
    expect(writeA.created).toBe(true);
    expect(writeA.atomDid).toBe(
      buildAtomDid(atom.entityType, atom.entityId).raw,
    );

    // Process B: a SEPARATE, freshly-constructed store instance over the
    // SAME backend re-ingests the same content. No process-local state is
    // shared — only the Postgres + GCS backend is.
    const storeB = freshStore(pg, gcs);

    const pinB = await storeB.pinBlob({
      contentHash: "doc-hash-1",
      body: "RECORD OF SURVEY ... Lot 4 Block B ... 2.35 acres",
      contentType: "text/plain",
      size: 48,
    });
    // Same cid, and created:false — dedup survived the "restart".
    expect(pinB.cid).toBe(pinA.cid);
    expect(pinB.created).toBe(false);

    const writeB = await storeB.writeDocumentAtom(atom);
    expect(writeB.atomDid).toBe(writeA.atomDid);
    expect(writeB.created).toBe(false); // idempotent no-op from Postgres

    // And the atom reads back through the second instance.
    const readBack = await storeB.getDocumentAtomByDid(writeB.atomDid);
    expect(readBack).not.toBeNull();
    expect(readBack?.entityType).toBe("survey-record");
    if (readBack?.entityType === "survey-record") {
      expect(readBack.acreage).toBe(2.35);
    }

    // Listing by source cid returns the single atom (no duplicate).
    const listed = await storeB.listAtomsBySourceDocumentCid(pinA.cid);
    expect(listed.length).toBe(1);
    expect(listed[0]?.entityType).toBe("survey-record");
  });

  it("fetchBlob returns the pinned body, and null for a missing cid (never throws)", async () => {
    const pg = new FakePgBackend();
    const gcs = new FakeGcsBackend();
    const store = freshStore(pg, gcs);

    const pin = await store.pinBlob({
      contentHash: "h2",
      body: "hello world",
      contentType: "text/plain",
      size: 11,
    });
    const body = await store.fetchBlob(pin.cid);
    expect(body).toBe("hello world");

    const missing = await store.fetchBlob("bafydoc-does-not-exist");
    expect(missing).toBeNull();
  });

  it("factory createDurableDocumentIngestStore wires the same durable composition", async () => {
    const pg = new FakePgBackend();
    const gcs = new FakeGcsBackend();
    const store = createDurableDocumentIngestStore({
      sql: pg.makeSql() as never,
      bucket: BUCKET,
      storage: gcs.makeStorage() as never,
    });
    const atom: DocumentDerivedAtomInstance = surveyAtom();
    const w1 = await store.writeDocumentAtom(atom);
    const w2 = await store.writeDocumentAtom(atom);
    expect(w1.created).toBe(true);
    expect(w2.created).toBe(false);
  });
});
