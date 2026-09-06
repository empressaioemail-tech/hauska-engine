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
  readonly geomBbox = new Map<
    string,
    {
      entity_type: string;
      county_fips: string | null;
      west_lng: number;
      south_lat: number;
      east_lng: number;
      north_lat: number;
    }
  >();

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

      if (text.startsWith("INSERT INTO atoms (")) {
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

      if (text.startsWith("INSERT INTO atoms_geom_bbox")) {
        const [dids, entityTypes, countyFipsArr, west, south, east, north] =
          params as [
            string[],
            string[],
            (string | null)[],
            number[],
            number[],
            number[],
            number[],
          ];
        for (let i = 0; i < dids.length; i++) {
          backend.geomBbox.set(dids[i]!, {
            entity_type: entityTypes[i]!,
            county_fips: countyFipsArr[i] ?? null,
            west_lng: west[i]!,
            south_lat: south[i]!,
            east_lng: east[i]!,
            north_lat: north[i]!,
          });
        }
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

  it("writePropertyAtom upserts atoms_geom_bbox for a road-node write (migration 012)", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const roadNodeId = "48055:road:1";
    const roadAtom = {
      entityType: "road-node" as const,
      atomDid: `did:hauska:road-node:${roadNodeId}`,
      entityId: roadNodeId,
      roadNodeId,
      countyFips: "48055",
      jurisdictionTenant: "tx_48055",
      fetchedAt: "2026-09-06T00:00:00.000Z",
      extractedAt: "2026-09-06T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "https://example.invalid/road",
      contentHash: "road-hash",
      accessPolicy: "public-free" as const,
      atomTier: "data" as const,
      status: "active" as const,
      versionStamp: "v1",
      centerline: {
        type: "LineString" as const,
        coordinates: [
          [-97.72, 29.9],
          [-97.6, 29.95],
        ] as const,
      },
      // Minimal stand-ins for the rest of RoadNodeAtomInstance's contract
      // fields — this test only exercises the geom_bbox write-path hook,
      // not full road-node semantics.
    };
    await storage.writePropertyAtom(roadAtom as never);
    const row = backend.geomBbox.get(roadAtom.atomDid);
    expect(row).toEqual({
      entity_type: "road-node",
      county_fips: "48055",
      west_lng: -97.72,
      east_lng: -97.6,
      south_lat: 29.9,
      north_lat: 29.95,
    });
  });

  it("writePropertyAtom upserts atoms_geom_bbox for a building-footprint write (migration 012)", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const parcelNodeId = "48021:1";
    const footprintAtom = {
      entityType: "building-footprint" as const,
      atomDid: `did:hauska:building-footprint:${parcelNodeId}`,
      entityId: parcelNodeId,
      parcelNodeId,
      jurisdictionTenant: "tx_48021",
      fetchedAt: "2026-09-06T00:00:00.000Z",
      extractedAt: "2026-09-06T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "https://example.invalid/footprint",
      contentHash: "footprint-hash",
      accessPolicy: "public-free" as const,
      atomTier: "data" as const,
      status: "active" as const,
      versionStamp: "v1",
      footprintGeometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [-97.38, 30.1],
            [-97.37, 30.11],
            [-97.375, 30.105],
          ],
        ],
      },
    };
    await storage.writePropertyAtom(footprintAtom as never);
    const row = backend.geomBbox.get(footprintAtom.atomDid);
    expect(row).toEqual({
      entity_type: "building-footprint",
      county_fips: "48021",
      west_lng: -97.38,
      east_lng: -97.37,
      south_lat: 30.1,
      north_lat: 30.11,
    });
  });

  it("writePropertyAtom does NOT touch atoms_geom_bbox for an unrelated entity type (falsifier)", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const parcelNodeId = "48021:2";
    const zoningAtom = {
      entityType: "zoning-fact" as const,
      atomDid: `did:hauska:zoning-fact:${parcelNodeId}`,
      entityId: parcelNodeId,
      jurisdictionTenant: "tx_48021",
      parcelNodeId,
      fetchedAt: "2026-09-06T00:00:00.000Z",
      extractedAt: "2026-09-06T00:00:00.000Z",
      sourceAdapter: "test",
      sourceUrl: "https://example.invalid/zoning",
      sourceCitation: "stub",
      contentHash: "abc124",
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
            assertedAt: "2026-09-06T00:00:00.000Z",
          },
        },
        assembledAt: "2026-09-06T00:00:00.000Z",
      },
    };
    await storage.writePropertyAtom(zoningAtom);
    expect(backend.geomBbox.size).toBe(0);
  });

  it("listRoadAtomsNearBbox falls back to the legacy jsonb scan when atoms_geom_bbox doesn't exist (no regression for pre-012 databases)", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const roadNodeId = "48055:road:1";
    const roadBody = {
      entityType: "road-node",
      atomDid: `did:hauska:road-node:${roadNodeId}`,
      entityId: roadNodeId,
      roadNodeId,
      countyFips: "48055",
      status: "active",
      centerline: { type: "LineString", coordinates: [[-97.72, 29.9], [-97.6, 29.95]] },
    };
    backend.atoms.set(roadBody.atomDid, {
      atom_did: roadBody.atomDid,
      cid: "cid-road",
      content_hash: "hash-road",
      entity_type: "road-node",
      entity_id: roadNodeId,
      jurisdiction_tenant: "tx_48055",
      section_number: null,
      subsection_path: null,
      source_adapter: "test",
      source_url: "https://example.invalid/road",
      fetched_at: "2026-09-06T00:00:00.000Z",
      body: roadBody,
      access_policy: "public-free",
    });
    const result = await storage.listRoadAtomsNearBbox("48055", {
      westLng: -97.8,
      southLat: 29.8,
      eastLng: -97.5,
      northLat: 30.0,
    });
    expect(result.map((r) => r.roadNodeId)).toContain(roadNodeId);
  });

  it("listBuildingFootprintsNearBbox falls back to the legacy jsonb scan when atoms_geom_bbox doesn't exist (no regression for pre-012 databases)", async () => {
    const backend = new FakePgBackend();
    const storage = new PgStorage(backend.makeSql() as never);
    const parcelNodeId = "48021:1";
    const footprintBody = {
      entityType: "building-footprint",
      atomDid: `did:hauska:building-footprint:${parcelNodeId}`,
      entityId: parcelNodeId,
      parcelNodeId,
      status: "active",
      footprintGeometry: {
        type: "Polygon",
        coordinates: [[[-97.38, 30.1], [-97.37, 30.11], [-97.375, 30.105]]],
      },
    };
    backend.atoms.set(footprintBody.atomDid, {
      atom_did: footprintBody.atomDid,
      cid: "cid-footprint",
      content_hash: "hash-footprint",
      entity_type: "building-footprint",
      entity_id: parcelNodeId,
      jurisdiction_tenant: "tx_48021",
      section_number: null,
      subsection_path: null,
      source_adapter: "test",
      source_url: "https://example.invalid/footprint",
      fetched_at: "2026-09-06T00:00:00.000Z",
      body: footprintBody,
      access_policy: "public-free",
    });
    const result = await storage.listBuildingFootprintsNearBbox("48021", {
      westLng: -97.5,
      southLat: 30.0,
      eastLng: -97.3,
      northLat: 30.2,
    });
    expect(result.map((r) => (r as { parcelNodeId?: string }).parcelNodeId)).toContain(
      parcelNodeId,
    );
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
