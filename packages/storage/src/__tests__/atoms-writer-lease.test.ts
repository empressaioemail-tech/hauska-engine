import { afterEach, describe, expect, it } from "vitest";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";

import {
  ATOMS_WRITER_LEASE_HELD_BY_OTHER,
  ATOMS_WRITER_LEASE_NOT_HELD,
  AtomsWriterLeaseHeldByOtherError,
  AtomsWriterLeaseNotHeldError,
  WRITER_LEASE_HOLDER_ENV,
  assertAndHeartbeatWriterLease,
  takeWriterLease,
} from "../atoms-writer-lease.js";
import { PgStorage } from "../pg-storage.js";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";

const HOLDER_ENV_PREV = process.env[WRITER_LEASE_HOLDER_ENV];

afterEach(() => {
  if (HOLDER_ENV_PREV == null) delete process.env[WRITER_LEASE_HOLDER_ENV];
  else process.env[WRITER_LEASE_HOLDER_ENV] = HOLDER_ENV_PREV;
});

function zoningStub(): PropertyAtomInstance {
  return {
    entityType: "zoning-fact",
    atomDid: "did:hauska:zoning-fact:48021:1",
    entityId: "48021:1",
    jurisdictionTenant: "bastrop_tx",
    parcelNodeId: "48021:1",
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

function makeSqlFake(handler: (text: string, params: unknown[]) => Promise<unknown[]>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = (strings as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, params });
    return handler(text, params);
  }) as unknown as ConstructorParameters<typeof PgStorage>[0];
  (sql as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql, calls };
}

describe("atoms bulk-writer lease", () => {
  it("assertAndHeartbeat throws ATOMS_WRITER_LEASE_NOT_HELD when holder env is unset", async () => {
    delete process.env[WRITER_LEASE_HOLDER_ENV];
    const { sql, calls } = makeSqlFake(async () => []);
    await expect(assertAndHeartbeatWriterLease(sql as never)).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_NOT_HELD,
    });
    expect(calls).toHaveLength(0);
  });

  it("assertAndHeartbeat throws ATOMS_WRITER_LEASE_NOT_HELD when UPDATE matches zero rows", async () => {
    const { sql } = makeSqlFake(async () => []);
    await expect(
      assertAndHeartbeatWriterLease(sql as never, { holder: "L16" }),
    ).rejects.toBeInstanceOf(AtomsWriterLeaseNotHeldError);
  });

  it("assertAndHeartbeat returns the live row when UPDATE matches", async () => {
    const now = new Date("2026-08-13T18:00:00.000Z");
    const { sql } = makeSqlFake(async () => [
      {
        holder: "L16",
        taken_at: "2026-08-13T17:00:00.000Z",
        heartbeat: "2026-08-13T18:00:00.000Z",
        expires: "2026-08-13T19:00:00.000Z",
      },
    ]);
    const view = await assertAndHeartbeatWriterLease(sql as never, {
      holder: "L16",
      now,
    });
    expect(view.holder).toBe("L16");
    expect(view.expires).toBe("2026-08-13T19:00:00.000Z");
  });

  it("take throws ATOMS_WRITER_LEASE_HELD_BY_OTHER when conflict UPDATE matches zero rows", async () => {
    const { sql } = makeSqlFake(async (text) => {
      if (text.startsWith("INSERT INTO atoms_bulk_writer_lease")) return [];
      if (text.startsWith("SELECT holder")) {
        return [
          {
            holder: "A2",
            taken_at: "2026-08-12T19:00:00.000Z",
            heartbeat: "2026-08-13T18:00:00.000Z",
            expires: "2026-08-13T19:00:00.000Z",
          },
        ];
      }
      return [];
    });
    await expect(
      takeWriterLease(sql as never, { holder: "L16" }),
    ).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_HELD_BY_OTHER,
      name: AtomsWriterLeaseHeldByOtherError.name,
    });
  });

  it("writePropertyAtomsBatch fails closed without a live lease and never INSERTs atoms", async () => {
    process.env[WRITER_LEASE_HOLDER_ENV] = "L16";
    const { sql, calls } = makeSqlFake(async (text) => {
      if (text.includes("INSERT INTO atoms")) {
        throw new Error("INSERT INTO atoms must not run without a live lease");
      }
      return [];
    });
    const storage = new PgStorage(sql as never);
    await expect(storage.writePropertyAtomsBatch([zoningStub()])).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_NOT_HELD,
      message: expect.stringContaining(ATOMS_WRITER_LEASE_NOT_HELD),
    });
    expect(calls.some((c) => c.text.includes("INSERT INTO atoms"))).toBe(false);
    expect(calls.some((c) => c.text.includes("atoms_bulk_writer_lease"))).toBe(true);
  });

  it("writePropertyAtomsBatch fails closed when ATOMS_WRITER_LEASE_HOLDER is unset", async () => {
    delete process.env[WRITER_LEASE_HOLDER_ENV];
    const { sql, calls } = makeSqlFake(async () => {
      throw new Error("SQL must not run when holder env is unset");
    });
    const storage = new PgStorage(sql as never);
    await expect(storage.writePropertyAtomsBatch([zoningStub()])).rejects.toMatchObject({
      code: ATOMS_WRITER_LEASE_NOT_HELD,
    });
    expect(calls).toHaveLength(0);
  });
});
