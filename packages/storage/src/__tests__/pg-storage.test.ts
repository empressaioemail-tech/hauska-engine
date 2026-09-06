/**
 * PgStorage unit tests with a shared in-memory postgres.Sql fake.
 */

import { describe, expect, it } from "vitest";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";

import {
  AccessPolicyRequiredError,
} from "../access-policy-write.js";
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

    const sql = ((
      strings: TemplateStringsArray | readonly unknown[],
      ...params: unknown[]
    ) => {
      // postgres.sql(array) helper used for IN (...entity types...).
      if (Array.isArray(strings) && !("raw" in strings)) {
        return { __sqlIn: strings };
      }

      const text = (strings as TemplateStringsArray)
        .join("?")
        .replace(/\s+/g, " ")
        .trim();

      // Nested fragment builders (AND jurisdiction..., AND entity_type..., OR ILIKE...)
      // are invoked as tagged templates too; only top-level awaits need rows.
      if (
        text.startsWith("AND ") ||
        text.startsWith("OR ") ||
        text.startsWith("(") ||
        text === ""
      ) {
        return { __sqlFrag: text, params };
      }

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

      // Bounded search (and any other body SELECT). Fake returns the small
      // in-memory set; production SQL pushes jurisdiction/entityType/q + LIMIT.
      if (
        text.includes("entity_type IN") &&
        (text.includes("entity_id =") || text.includes("body->>'parcelNodeId'"))
      ) {
        let allowed: string[] | null = null;
        let parcelNodeId: string | null = null;
        for (const param of params) {
          if (
            param &&
            typeof param === "object" &&
            "__sqlIn" in (param as object)
          ) {
            allowed = (param as { __sqlIn: string[] }).__sqlIn;
          } else if (
            typeof param === "string" &&
            /^\d{5}:/.test(param) &&
            !param.endsWith(":%")
          ) {
            // Prefer bare parcelNodeId over the LIKE pattern param.
            parcelNodeId = param;
          }
        }
        return Promise.resolve(
          [...backend.atoms.values()]
            .filter((row) => {
              if (allowed && !allowed.includes(row.entity_type)) return false;
              const body = row.body as { parcelNodeId?: string; status?: string };
              if (parcelNodeId) {
                const entityId = String(row.entity_id ?? "");
                const matchesEntity =
                  entityId === parcelNodeId ||
                  entityId.startsWith(`${parcelNodeId}:`);
                const matchesBody = body.parcelNodeId === parcelNodeId;
                if (!matchesEntity && !matchesBody) return false;
              }
              const status = body.status ?? "active";
              return status === "active";
            })
            .map((row) => ({ body: row.body })),
        );
      }

      if (text.startsWith("SELECT body FROM atoms")) {
        return Promise.resolve(
          [...backend.atoms.values()].map((row) => ({ body: row.body })),
        );
      }

      if (text.startsWith("SELECT COUNT(*)::text AS count FROM atoms")) {
        return Promise.resolve([{ count: String(backend.atoms.size) }]);
      }

      if (text.startsWith("SELECT EXISTS (SELECT 1 FROM atoms LIMIT 1)")) {
        return Promise.resolve([{ present: backend.atoms.size > 0 }]);
      }

      if (text.startsWith("SELECT n_live_tup FROM pg_stat_user_tables")) {
        return Promise.resolve([{ n_live_tup: String(backend.atoms.size) }]);
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
    }) as ((
      strings: TemplateStringsArray,
      ...params: unknown[]
    ) => Promise<unknown[]>) & {
      unsafe: () => Promise<unknown[]>;
      json: (value: unknown) => unknown;
      end: () => Promise<void>;
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

describe("PgStorage accessPolicy fail-closed", () => {
  it("refuses writeAtom when accessPolicy is absent and issues no INSERT", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const proof = buildStoragePortProofAtom();
    const { accessPolicy: _removed, ...withoutPolicy } = proof as CodeSectionAtomInstance & {
      accessPolicy?: string;
    };
    await expect(storage.writeAtom(withoutPolicy as CodeSectionAtomInstance)).rejects.toBeInstanceOf(
      AccessPolicyRequiredError,
    );
    expect(backend.atoms.size).toBe(0);
  });
});

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

  it("hasAtoms() reflects presence via EXISTS, true after a write and false on an empty backend", async () => {
    const emptyBackend = new FakePgBackend();
    const emptyStorage = new PgStorage(emptyBackend.makeSql() as never);
    expect(await emptyStorage.hasAtoms()).toBe(false);

    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    expect(await storage.hasAtoms()).toBe(true);
  });

  it("estimateAtomCount() reads pg_stat_user_tables, not a scan", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    expect(await storage.estimateAtomCount()).toBe(1);
  });

  it("estimateAtomCount() issues pg_stat_user_tables, never SELECT COUNT(*) FROM atoms", async () => {
    const backend = new FakePgBackend();
    const calls: string[] = [];
    const baseSql = backend.makeSql();
    const spySql = ((
      strings: TemplateStringsArray | readonly unknown[],
      ...params: unknown[]
    ) => {
      if (Array.isArray(strings) && "raw" in strings) {
        const text = (strings as TemplateStringsArray)
          .join("?")
          .replace(/\s+/g, " ")
          .trim();
        calls.push(text);
      }
      return (baseSql as unknown as (...args: unknown[]) => unknown)(
        strings,
        ...params,
      );
    }) as unknown as typeof baseSql;
    Object.assign(spySql, baseSql);

    const storage = new PgStorage(spySql as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    calls.length = 0;

    await storage.estimateAtomCount();

    expect(
      calls.some((c) => c.startsWith("SELECT n_live_tup FROM pg_stat_user_tables")),
    ).toBe(true);
    expect(calls.some((c) => c.includes("COUNT(*)"))).toBe(false);
  });

  it("hasAtoms() issues EXISTS + LIMIT 1, never SELECT COUNT(*) FROM atoms", async () => {
    const backend = new FakePgBackend();
    const calls: string[] = [];
    const baseSql = backend.makeSql();
    const spySql = ((
      strings: TemplateStringsArray | readonly unknown[],
      ...params: unknown[]
    ) => {
      if (Array.isArray(strings) && "raw" in strings) {
        const text = (strings as TemplateStringsArray)
          .join("?")
          .replace(/\s+/g, " ")
          .trim();
        calls.push(text);
      }
      return (baseSql as unknown as (...args: unknown[]) => unknown)(
        strings,
        ...params,
      );
    }) as unknown as typeof baseSql;
    Object.assign(spySql, baseSql);

    const storage = new PgStorage(spySql as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    calls.length = 0;

    await storage.hasAtoms();

    expect(calls.some((c) => c.startsWith("SELECT EXISTS (SELECT 1 FROM atoms LIMIT 1)"))).toBe(
      true,
    );
    expect(calls.some((c) => c.includes("COUNT(*)"))).toBe(false);
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

  it("search SQL is bounded (WHERE + LIMIT) — never SELECT body FROM atoms alone", async () => {
    const backend = new FakePgBackend();
    const calls: string[] = [];
    const baseSql = backend.makeSql();
    const spySql = ((
      strings: TemplateStringsArray | readonly unknown[],
      ...params: unknown[]
    ) => {
      if (Array.isArray(strings) && "raw" in strings) {
        const text = (strings as TemplateStringsArray)
          .join("?")
          .replace(/\s+/g, " ")
          .trim();
        if (text.startsWith("SELECT body FROM atoms")) calls.push(text);
      }
      return (baseSql as unknown as (...args: unknown[]) => unknown)(
        strings,
        ...params,
      );
    }) as unknown as typeof baseSql;
    Object.assign(spySql, baseSql);

    const storage = new PgStorage(spySql as never);
    await storage.writeAtom(buildStoragePortProofAtom());
    await storage.search({
      q: "storage-port-proof",
      jurisdiction: "storage-port-proof",
      limit: 5,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const text of calls) {
      expect(text).toMatch(/WHERE/i);
      expect(text).toMatch(/LIMIT/i);
      // The pathological full-table form that OOM'd Cloud Run.
      expect(text).not.toBe("SELECT body FROM atoms ORDER BY updated_at DESC");
    }
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

  it("writePropertyAtom persists zoning-fact jsonb and serves via getAtomByDid", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const parcelNodeId = "17031:1";
    const propertyAtom = {
      entityType: "zoning-fact" as const,
      atomDid: `did:hauska:zoning-fact:${parcelNodeId}`,
      entityId: parcelNodeId,
      jurisdictionTenant: "cook_county_il_stub",
      parcelNodeId,
      fetchedAt: "2026-07-23T12:00:00.000Z",
      extractedAt: "2026-07-23T12:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "https://example.invalid/zoning",
      sourceCitation: "stub",
      contentHash: "abc123",
      accessPolicy: "public-free" as const,
      atomTier: "data" as const,
      status: "active" as const,
      versionStamp: "v1",
      district: "RS-1",
      matchBasis: "exact" as const,
      reasoningChain: { reasoningKind: "observed" as const },
      readContract: {
        axes: {
          assertedConfidence: createWidthedConfidence({
            estimate: 0.9,
            n: 0,
            intervalWidth: 0.12,
            provenance: "asserted",
          }),
          calibratedConfidence: createWidthedConfidence({
            estimate: 0.9,
            n: 0,
            intervalWidth: 0.12,
            provenance: "asserted",
          }),
          consequence: {
            kind: "not-applicable" as const,
            reason: "test",
            assertedAt: "2026-07-23T12:00:00.000Z",
          },
        },
        assembledAt: "2026-07-23T12:00:00.000Z",
      },
    };
    const { atomDid } = await storage.writePropertyAtom(propertyAtom);
    expect(atomDid).toBe(`did:hauska:zoning-fact:${parcelNodeId}`);
    const roundTrip = await storage.getAtomByDid(atomDid);
    expect(roundTrip).toMatchObject({
      entityType: "zoning-fact",
      district: "RS-1",
      parcelNodeId,
    });
  });

  it("listPropertyAtomsByParcelNodeId returns parcel-keyed families including flood-hazard-fact and owner-fact", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const parcelNodeId = "48021:CHAIN-WIDEN";
    const floodBody = {
      entityType: "flood-hazard-fact",
      entityId: parcelNodeId,
      parcelNodeId,
      accessPolicy: "public-free",
      status: "active",
      inFloodplain: false,
    };
    const ownerBody = {
      entityType: "owner-fact",
      entityId: `${parcelNodeId}:2025`,
      parcelNodeId,
      accessPolicy: "public-paid",
      status: "active",
      taxYear: 2025,
      ownerName: "Chain Widen Stub",
    };
    backend.atoms.set("did:hauska:flood-hazard-fact:" + parcelNodeId, {
      atom_did: "did:hauska:flood-hazard-fact:" + parcelNodeId,
      cid: "cid-flood",
      content_hash: "hash-flood",
      entity_type: "flood-hazard-fact",
      entity_id: parcelNodeId,
      jurisdiction_tenant: "bastrop_tx",
      section_number: null,
      subsection_path: null,
      source_adapter: "test",
      source_url: "https://example.invalid/flood",
      fetched_at: "2026-08-12T00:00:00.000Z",
      body: floodBody,
      access_policy: "public-free",
    });
    backend.atoms.set("did:hauska:owner-fact:" + parcelNodeId + ":2025", {
      atom_did: "did:hauska:owner-fact:" + parcelNodeId + ":2025",
      cid: "cid-owner",
      content_hash: "hash-owner",
      entity_type: "owner-fact",
      entity_id: `${parcelNodeId}:2025`,
      jurisdiction_tenant: "bastrop_tx",
      section_number: null,
      subsection_path: null,
      source_adapter: "test",
      source_url: "https://example.invalid/owner",
      fetched_at: "2026-08-12T00:00:00.000Z",
      body: ownerBody,
      access_policy: "public-paid",
    });
    backend.atoms.set("did:hauska:code-section:stub", {
      atom_did: "did:hauska:code-section:stub",
      cid: "cid-code",
      content_hash: "hash-code",
      entity_type: "code-section",
      entity_id: "stub",
      jurisdiction_tenant: "bastrop_tx",
      section_number: "1",
      subsection_path: null,
      source_adapter: "test",
      source_url: "https://example.invalid/code",
      fetched_at: "2026-08-12T00:00:00.000Z",
      body: { entityType: "code-section", parcelNodeId },
      access_policy: "public-free",
    });

    const listed = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    const types = listed.map((r) => r.entityType).sort();
    expect(types).toEqual(["flood-hazard-fact", "owner-fact"]);
  });

});
