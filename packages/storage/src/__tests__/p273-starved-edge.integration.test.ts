/**
 * P-273 control 4 on a REAL Postgres: `assertEdgesNotStarved` compared a
 * computation against itself and could not fire.
 *
 * The hermetic twin (`p273-starved-edge.test.ts`) proves the comparison was
 * degenerate and that a store which drops edges now fails the write. This file
 * proves the same thing where the defect actually lived -- inside
 * `PgStorage.writePropertyAtomsBatch`'s transaction -- against a real
 * `atom_links` table, by installing a BEFORE INSERT trigger that silently drops
 * every `applies-to` row. That is the failure mode the control exists for: the
 * writer derived the edges, the rows never landed, and the county is served a
 * parcel with no relationship to the fact that was written about it.
 *
 * Requires DATABASE_URL (direct host, not pooler). Creates a throwaway schema
 * and drops it on exit. Skips when unset.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import {
  STARVED_EDGE,
  appliesToLinksFromPropertyAtoms,
  assertEdgesNotStarved,
  buildPresentFloodHazardFactAtom,
  expectedAppliesToCount,
  type PropertyAtomInstance,
} from "@hauska-engine/atoms";

import { PgStorage, resolveSubstrateDatabaseUrl } from "../pg-storage.js";
import { releaseScopedLease, takeScopedLease } from "../atoms-writer-lease.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const SCHEMA = "p273_starved_edge";
const COUNTY = "48021";

const provenanceBase = {
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceCitation: "P-273 integration fixture",
  sourceUrl: "https://example.test/nfhl",
  observedAt: "2026-08-21T00:00:00.000Z",
  jurisdictionTenant: `tx_${COUNTY}`,
};

function floodFacts(parcelNodeId: string): PropertyAtomInstance[] {
  return [
    buildPresentFloodHazardFactAtom(
      { parcelNodeId, inSpecialFloodHazardArea: false, floodZone: null },
      { ...provenanceBase, contentHash: `fnv1a64:p273-int-${parcelNodeId}` },
    ),
  ];
}

/** Count the `applies-to` rows that name this parcel, straight from the table. */
async function storedEdgesFor(sql: postgres.Sql, parcelNodeId: string): Promise<number> {
  const rows = await sql.unsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
      FROM ${SCHEMA}.atom_links
     WHERE link_type = 'applies-to'
       AND to_atom_did = 'did:hauska:parcel-node:${parcelNodeId}'
  `);
  return Number(rows[0]?.n ?? 0);
}

describe.skipIf(!resolveSubstrateDatabaseUrl())("P-273 starved edge (live Postgres)", () => {
  const rawUrl = resolveSubstrateDatabaseUrl();
  let sql: postgres.Sql;
  let storage: PgStorage;
  let lease: Awaited<ReturnType<typeof takeScopedLease>>;

  beforeAll(async () => {
    const direct = (rawUrl as string).replace("-pooler.", ".");
    sql = postgres(direct, { ssl: direct.includes("localhost") ? false : "require", max: 1 });
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`SET search_path TO ${SCHEMA}, public`);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    storage = new PgStorage(sql);
    lease = await takeScopedLease(sql, {
      scope: { scope_type: "write", entity_type: "flood-hazard-fact", county_fips: COUNTY },
      holder_label: "p273-integration",
      run_id: "p273-starved-edge",
    });
  }, 180_000);

  afterAll(async () => {
    if (!sql) return;
    try {
      await releaseScopedLease(sql, lease);
    } catch {
      // release is best-effort; the schema is about to be dropped
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it("THE DEFECT AND THE FIX on one broken store: the old shape passes while the table is empty; the new shape refuses", async () => {
    // A healthy store first, so that "refuses" below cannot be a control that
    // refuses everything.
    const healthy = floodFacts("48021:90001");
    await storage.writePropertyAtomsBatch(healthy, lease);
    expect(await storedEdgesFor(sql, "48021:90001")).toBe(1);

    // Now break the store the way the control exists to catch: every applies-to
    // row is silently discarded by the table itself. No error, no row.
    await sql.unsafe(`
      CREATE FUNCTION ${SCHEMA}.p273_drop_applies_to() RETURNS trigger AS $$
      BEGIN
        IF NEW.link_type = 'applies-to' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await sql.unsafe(`
      CREATE TRIGGER p273_drop_applies_to
      BEFORE INSERT ON ${SCHEMA}.atom_links
      FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.p273_drop_applies_to()
    `);

    const starved = floodFacts("48021:90002");

    // PRE-CHANGE SHAPE, evaluated verbatim against the starved store: the second
    // argument is derived from the SAME array the expectation is derived from,
    // so it is equal by construction and the check reports success...
    const preFixLinksWritten = appliesToLinksFromPropertyAtoms(starved).length;
    expect(preFixLinksWritten).toBe(expectedAppliesToCount(starved));
    expect(preFixLinksWritten).toBe(1);
    expect(() => assertEdgesNotStarved(starved, preFixLinksWritten)).not.toThrow();

    // ...while the store holds none of the edge the writer just claimed. That is
    // the recorded defect: a passing control over an empty relationship graph.
    expect(await storedEdgesFor(sql, "48021:90002")).toBe(0);

    // POST-CHANGE: the same batch, the same broken store, refused.
    await expect(storage.writePropertyAtomsBatch(starved, lease)).rejects.toMatchObject({
      code: STARVED_EDGE,
    });
    expect(await storedEdgesFor(sql, "48021:90002")).toBe(0);

    // Repair the store and the batch goes through: the control is a gate, not a
    // permanently-red wall.
    await sql.unsafe(`DROP TRIGGER p273_drop_applies_to ON ${SCHEMA}.atom_links`);
    await storage.writePropertyAtomsBatch(starved, lease);
    expect(await storedEdgesFor(sql, "48021:90002")).toBe(1);
  }, 180_000);

  it("an idempotent re-run of a batch whose edges already exist is NOT starvation", async () => {
    const atoms = floodFacts("48021:90003");
    await storage.writePropertyAtomsBatch(atoms, lease);
    // Every derived edge is present already, and `writeAtomLinks` is
    // ON CONFLICT ... DO NOTHING, so it inserts zero rows on this second pass.
    // Asserting on rows INSERTED would make this a permanently-red gate; the
    // control must be presence-shaped.
    await expect(storage.writePropertyAtomsBatch(atoms, lease)).resolves.toBeDefined();
    expect(await storedEdgesFor(sql, "48021:90003")).toBe(1);
  }, 180_000);
});
