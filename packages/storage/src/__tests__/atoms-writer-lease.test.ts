import { afterEach, describe, expect, it } from "vitest";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";

import {
  ATOMS_WRITER_LEASE_HELD_BY_OTHER,
  ATOMS_WRITER_LEASE_V1_RETIRED,
  LEASE_EXPIRED,
  LEASE_REQUIRED,
  NO_GLOBAL,
  SCOPE_MISMATCH,
  WRITER_LEASE_HOLDER_ENV,
  assertAndHeartbeatWriterLease,
  assertScopeOnAtoms,
  lockAndHeartbeatLease,
  takeScopedLease,
  takeWriterLease,
  type HeldLease,
} from "../atoms-writer-lease.js";
import { PgStorage } from "../pg-storage.js";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

const HOLDER_ENV_PREV = process.env[WRITER_LEASE_HOLDER_ENV];

afterEach(() => {
  if (HOLDER_ENV_PREV == null) delete process.env[WRITER_LEASE_HOLDER_ENV];
  else process.env[WRITER_LEASE_HOLDER_ENV] = HOLDER_ENV_PREV;
});

function zoningStub(entityId = "48021:1"): PropertyAtomInstance {
  return {
    entityType: "zoning-fact",
    atomDid: `did:hauska:zoning-fact:${entityId}`,
    entityId,
    jurisdictionTenant: "bastrop_tx",
    parcelNodeId: entityId,
    fetchedAt: "2026-08-13T00:00:00.000Z",
    extractedAt: "2026-08-13T00:00:00.000Z",
    sourceAdapter: "lease-test",
    sourceUrl: "https://example.invalid/lease",
    sourceCitation: "stub",
    contentHash: "lease-test-hash",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: "v1",
    district: "SF-1",
    matchBasis: "exact",
    reasoningChain: { reasoningKind: "observed" },
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
          kind: "not-applicable",
          reason: "test",
          assertedAt: "2026-08-13T00:00:00.000Z",
        },
      },
      assembledAt: "2026-08-13T00:00:00.000Z",
    },
  };
}

function bexarCadStub(): PropertyAtomInstance {
  return {
    ...zoningStub("48029:1"),
    entityType: "cad-parcel-roll",
    atomDid: "did:hauska:cad-parcel-roll:48029:1:2026",
    entityId: "48029:1:2026",
    parcelNodeId: "48029:1",
    jurisdictionTenant: "tx_48029",
  } as PropertyAtomInstance;
}

function heldWrite(overrides?: Partial<HeldLease>): HeldLease {
  return {
    holder_token: "00000000-0000-4000-8000-000000000001",
    holder_label: "test-writer",
    run_id: "run-1",
    scope: { scope_type: "write", entity_type: "zoning-fact", county_fips: "48021" },
    expires: "2026-08-13T18:15:00.000Z",
    stolen_from: null,
    ...overrides,
  };
}

function makeSqlFake(handler: (text: string, params: unknown[]) => Promise<unknown[]>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = (strings as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, params });
    return handler(text, params);
  }) as unknown as ConstructorParameters<typeof PgStorage>[0];
  (sql as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (sql as { begin: (fn: (txn: unknown) => Promise<unknown>) => Promise<unknown> }).begin =
    async (fn) => fn(sql);
  return { sql, calls };
}

describe("atoms writer lease v2", () => {
  it("v1 takeWriterLease throws ATOMS_WRITER_LEASE_V1_RETIRED", async () => {
    await expect(takeWriterLease()).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_V1_RETIRED,
    });
  });

  it("v1 assertAndHeartbeat throws ATOMS_WRITER_LEASE_V1_RETIRED even when env is set", async () => {
    process.env[WRITER_LEASE_HOLDER_ENV] = "L16";
    await expect(assertAndHeartbeatWriterLease()).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_V1_RETIRED,
    });
  });

  it("a v1 take cannot satisfy a v2 write", async () => {
    process.env[WRITER_LEASE_HOLDER_ENV] = "L16";
    await expect(takeWriterLease()).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_V1_RETIRED,
    });
    const { sql, calls } = makeSqlFake(async (text) => {
      if (text.includes("INSERT INTO atoms")) {
        throw new Error("INSERT INTO atoms must not run without a HeldLease");
      }
      return [];
    });
    const storage = new PgStorage(sql as never);
    await expect(storage.writePropertyAtomsBatch([zoningStub()])).rejects.toMatchObject({
      code: LEASE_REQUIRED,
    });
    expect(calls.some((c) => c.text.includes("INSERT INTO atoms"))).toBe(false);
  });

  it("writePropertyAtomsBatch without HeldLease never INSERTs atoms", async () => {
    const { sql, calls } = makeSqlFake(async () => []);
    const storage = new PgStorage(sql as never);
    await expect(storage.writePropertyAtomsBatch([zoningStub()])).rejects.toMatchObject({
      code: LEASE_REQUIRED,
    });
    expect(calls.some((c) => c.text.includes("INSERT INTO atoms"))).toBe(false);
    expect(calls.some((c) => c.text.includes("atoms_bulk_writer_lease"))).toBe(false);
  });

  it("GLOBAL scope refuses NO_GLOBAL", async () => {
    const { sql } = makeSqlFake(async () => []);
    await expect(
      takeScopedLease(sql as never, {
        scope: { scope_type: "write", entity_type: "GLOBAL", county_fips: "48029" },
        holder_label: "x",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: NO_GLOBAL });
    await expect(
      takeScopedLease(sql as never, {
        scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "GLOBAL" },
        holder_label: "x",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: NO_GLOBAL });
  });

  it("take on a live same scope refuses HELD_BY_OTHER", async () => {
    const { sql } = makeSqlFake(async (text) => {
      if (text.includes("INSERT INTO atoms_writer_lease_v2")) return [];
      if (text.includes("SELECT") && text.includes("atoms_writer_lease_v2")) {
        return [
          {
            scope_type: "write",
            scope_id: "cad-parcel-roll:48029",
            holder_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            holder_label: "other",
            run_id: "run-other",
            taken_at: "2026-08-13T17:00:00.000Z",
            heartbeat: "2026-08-13T18:00:00.000Z",
            expires: "2026-08-13T18:15:00.000Z",
            stolen_from: null,
          },
        ];
      }
      return [];
    });
    await expect(
      takeScopedLease(sql as never, {
        scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "48029" },
        holder_label: "me",
        run_id: "run-1",
      }),
    ).rejects.toMatchObject({ code: ATOMS_WRITER_LEASE_HELD_BY_OTHER });
  });

  it("take on an expired row records stolen_from", async () => {
    const { sql } = makeSqlFake(async (text) => {
      if (text.includes("INSERT INTO atoms_writer_lease_v2")) {
        return [
          {
            scope_type: "write",
            scope_id: "cad-parcel-roll:48029",
            holder_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            holder_label: "me",
            run_id: "run-2",
            taken_at: "2026-08-13T18:00:00.000Z",
            heartbeat: "2026-08-13T18:00:00.000Z",
            expires: "2026-08-13T18:15:00.000Z",
            stolen_from: "dead-writer",
          },
        ];
      }
      return [];
    });
    const lease = await takeScopedLease(sql as never, {
      scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "48029" },
      holder_label: "me",
      run_id: "run-2",
    });
    expect(lease.stolen_from).toBe("dead-writer");
    expect(lease.run_id).toBe("run-2");
  });

  it("assertScopeOnAtoms refuses a foreign county before INSERT", () => {
    expect(() =>
      assertScopeOnAtoms(heldWrite(), [zoningStub("48029:1")]),
    ).toThrow(
      expect.objectContaining({ code: SCOPE_MISMATCH }),
    );
  });

  it("assertScopeOnAtoms refuses a foreign entityType before INSERT", () => {
    expect(() => assertScopeOnAtoms(heldWrite(), [bexarCadStub()])).toThrow(
      expect.objectContaining({ code: SCOPE_MISMATCH }),
    );
  });

  it("Bexar cad keys pass a matching write scope", () => {
    expect(() =>
      assertScopeOnAtoms(
        heldWrite({
          scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "48029" },
        }),
        [bexarCadStub()],
      ),
    ).not.toThrow();
  });

  it("lock on an expired token refuses LEASE_EXPIRED and never INSERTs", async () => {
    const { sql, calls } = makeSqlFake(async (text) => {
      if (text.includes("FOR UPDATE")) return [];
      if (text.includes("INSERT INTO atoms")) {
        throw new Error("INSERT must not run after expiry");
      }
      return [];
    });
    await expect(
      lockAndHeartbeatLease(sql as never, heldWrite()),
    ).rejects.toMatchObject({ code: LEASE_EXPIRED });
    const storage = new PgStorage(sql as never);
    await expect(
      storage.writePropertyAtomsBatch([zoningStub()], heldWrite()),
    ).rejects.toMatchObject({ code: LEASE_EXPIRED });
    expect(calls.some((c) => c.text.includes("INSERT INTO atoms"))).toBe(false);
  });

  it("writePropertyAtomsBatch locks FOR UPDATE then upserts on a live lease", async () => {
    const { sql, calls } = makeSqlFake(async (text) => {
      if (text.includes("FOR UPDATE")) {
        return [
          {
            scope_type: "write",
            scope_id: "zoning-fact:48021",
            holder_token: "00000000-0000-4000-8000-000000000001",
            holder_label: "test-writer",
            run_id: "run-1",
            taken_at: "2026-08-13T18:00:00.000Z",
            heartbeat: "2026-08-13T18:00:00.000Z",
            expires: "2026-08-13T18:15:00.000Z",
            stolen_from: null,
          },
        ];
      }
      if (text.includes("UPDATE atoms_writer_lease_v2")) {
        return [
          {
            scope_type: "write",
            scope_id: "zoning-fact:48021",
            holder_token: "00000000-0000-4000-8000-000000000001",
            holder_label: "test-writer",
            run_id: "run-1",
            taken_at: "2026-08-13T18:00:00.000Z",
            heartbeat: "2026-08-13T18:01:00.000Z",
            expires: "2026-08-13T18:16:00.000Z",
            stolen_from: null,
          },
        ];
      }
      return [];
    });
    const storage = new PgStorage(sql as never);
    await storage.writePropertyAtomsBatch([zoningStub()], heldWrite());
    expect(calls.some((c) => c.text.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some((c) => c.text.includes("INSERT INTO atoms"))).toBe(true);
  });

  it("disjoint scopes are different primary keys", () => {
    const a = heldWrite({
      scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "48029" },
    });
    const b = heldWrite({
      scope: { scope_type: "write", entity_type: "cad-parcel-roll", county_fips: "48201" },
    });
    if (a.scope.scope_type !== "write" || b.scope.scope_type !== "write") {
      throw new Error("expected write scopes");
    }
    expect(`${a.scope.entity_type}:${a.scope.county_fips}`).not.toBe(
      `${b.scope.entity_type}:${b.scope.county_fips}`,
    );
    expect(() => assertScopeOnAtoms(a, [bexarCadStub()])).not.toThrow();
    expect(() => assertScopeOnAtoms(b, [bexarCadStub()])).toThrow(
      expect.objectContaining({ code: SCOPE_MISMATCH }),
    );
  });
});
