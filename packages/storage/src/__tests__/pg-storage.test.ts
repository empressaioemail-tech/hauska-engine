/**
 * PgStorage unit tests with a shared in-memory postgres.Sql fake.
 */

import { describe, expect, it } from "vitest";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { PgStorage } from "../pg-storage.js";
import {
  STORAGE_PORT_PROOF_ATOM_DID,
  buildStoragePortProofAtom,
} from "../storage-port-proof.js";

interface AtomRow {
  atom_did: string;
  cid: string;
  content_hash: string;
  entity_type: string;
  entity_id: string;
  jurisdiction_tenant: string;
  section_number: string | null;
  subsection_path: string | null;
  source_adapter: string;
  source_url: string;
  fetched_at: string;
  body: unknown;
  access_policy: string;
}

class FakePgBackend {
  readonly atoms = new Map<string, AtomRow>();
  readonly links = new Map<string, unknown>();
  readonly jurisdictionStatus = new Map<string, unknown>();

  makeSql() {
    const backend = this;
    const jsonMarker = Symbol("json");

    const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();

      if (text.startsWith("INSERT INTO atoms")) {
        const paramsCopy = [...params];
        const rawBody = paramsCopy[11];
        const body =
          typeof rawBody === "object" &&
          rawBody !== null &&
          jsonMarker in (rawBody as object)
            ? (rawBody as Record<symbol, unknown>)[jsonMarker]
            : rawBody;
        paramsCopy[11] = body;
        const [
          atom_did,
          cid,
          content_hash,
          entity_type,
          entity_id,
          jurisdiction_tenant,
          section_number,
          subsection_path,
          source_adapter,
          source_url,
          fetched_at,
          storedBody,
          access_policy,
        ] = paramsCopy as [
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string,
          unknown,
          string,
        ];
        backend.atoms.set(atom_did, {
          atom_did,
          cid,
          content_hash,
          entity_type,
          entity_id,
          jurisdiction_tenant,
          section_number,
          subsection_path,
          source_adapter,
          source_url,
          fetched_at,
          body: storedBody,
          access_policy,
        });
        return Promise.resolve([]);
      }

      if (text.startsWith("SELECT body FROM atoms WHERE atom_did")) {
        const atomDid = params[0] as string;
        const row = backend.atoms.get(atomDid);
        return Promise.resolve(row ? [{ body: row.body }] : []);
      }

      if (text.startsWith("SELECT body FROM atoms ORDER BY updated_at")) {
        return Promise.resolve(
          [...backend.atoms.values()].map((row) => ({ body: row.body })),
        );
      }

      if (
        text.startsWith(
          "SELECT body FROM atoms WHERE entity_type = 'code-section'",
        )
      ) {
        const [jurisdictionTenant, sectionNumber] = params as [string, string];
        return Promise.resolve(
          [...backend.atoms.values()]
            .filter(
              (row) =>
                row.entity_type === "code-section" &&
                row.jurisdiction_tenant === jurisdictionTenant &&
                row.section_number === sectionNumber,
            )
            .map((row) => ({ body: row.body })),
        );
      }

      if (text.startsWith("SELECT COUNT(*)::text AS count FROM atoms")) {
        return Promise.resolve([{ count: String(backend.atoms.size) }]);
      }

      if (text.startsWith("SELECT atom_did FROM atoms ORDER BY atom_did")) {
        return Promise.resolve(
          [...backend.atoms.keys()].map((atom_did) => ({ atom_did })),
        );
      }

      if (text.startsWith("SELECT jurisdiction_tenant")) {
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    };

    sql.unsafe = async () => [];
    sql.json = (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      (value as { [jsonMarker]?: unknown })[jsonMarker] !== undefined
        ? value
        : { [jsonMarker]: value };
    sql.end = async () => undefined;

    return sql;
  }
}

describe("PgStorage", () => {
  it("writes and reads a code-section atom by DID", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const proof = buildStoragePortProofAtom();
    const { atomDid } = await storage.writeAtom(proof);
    expect(atomDid).toBe(STORAGE_PORT_PROOF_ATOM_DID);

    const roundTrip = await storage.getAtomByDid(STORAGE_PORT_PROOF_ATOM_DID);
    expect(roundTrip?.entityId).toBe(proof.entityId);
  });

  it("finds the proof atom via search token", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    const results = await storage.search({
      q: "storage-port-proof",
      limit: 5,
    });
    expect(results[0]?.atomDid).toBe(STORAGE_PORT_PROOF_ATOM_DID);
  });

  it("getSectionsBySectionNumber returns exact section hits", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const section: CodeSectionAtomInstance = buildStoragePortProofAtom();
    await storage.writeAtom(section);
    const hits = await storage.getSectionsBySectionNumber(
      section.jurisdictionTenant,
      section.sectionNumber,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entityId).toBe(section.entityId);
  });
});
