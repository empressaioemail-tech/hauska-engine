/**
 * Elgin onboarding (2026-08-03) — elgin-development-code.json is a DRAFT
 * setback table (see the file's top-level "note": planner row-verification
 * + operator ratification required before serve). It is intentionally NOT
 * registered in SETBACK_TABLES (index.ts) yet — see the commented
 * TODO(elgin-review) entry there — so this test suite covers only:
 *
 *   1. the raw JSON file's shape (8 districts, all required scalar fields);
 *   2. every cited atom_did actually exists as a code-section entityId in
 *      the frozen corpus snapshot (mechanical grep/load test, per dispatch);
 *   3. the table is NOT reachable through getSetbackTable/getSetbackTableForZoning
 *      yet (proves the review gate is honored — registering it is a separate,
 *      planner-gated step).
 *
 * DID existence is checked against services/retrieval-api/corpus/snapshot.json
 * directly (not through the retrieval-api service) — this is a static,
 * frozen-corpus check, not a live-service probe.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import elginDevelopmentCode from "../elgin-development-code.json" with { type: "json" };
import type { SetbackTable } from "../table-types.js";
import { getSetbackTable, getSetbackTableForZoning, SETBACK_JURISDICTION_KEYS } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED_DISTRICT_CODES = ["R-1", "R-2", "R-3", "R-4", "C-1", "C-2", "C-3", "I"];

const REQUIRED_SCALAR_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_height_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

function leadingToken(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

describe("elgin-development-code.json — DRAFT shape (planner row-verification required before serve)", () => {
  const table = elginDevelopmentCode as SetbackTable;

  it("carries the DRAFT provenance note", () => {
    expect(table.note).toMatch(/DRAFT authored 2026-08-03/);
    expect(table.note).toMatch(/planner row-verification \+ operator ratification required before serve/);
  });

  it("has exactly 8 districts, one per Sec. 46-203 roster entry (R-1..R-4, C-1..C-3, I)", () => {
    expect(table.districts).toHaveLength(8);
    const codes = table.districts.map((d) => leadingToken(d.district_name)).sort();
    expect(codes).toEqual([...EXPECTED_DISTRICT_CODES].sort());
  });

  it("excludes PDD / Downtown Overlay (not in Elgin's Chapter 46 district roster)", () => {
    const codes = table.districts.map((d) => leadingToken(d.district_name));
    expect(codes).not.toContain("PDD");
    expect(codes.some((c) => c.includes("OVERLAY"))).toBe(false);
  });

  it("every district row carries every required scalar field and a provenance entry per field", () => {
    for (const d of table.districts) {
      for (const field of REQUIRED_SCALAR_FIELDS) {
        expect(typeof (d as unknown as Record<string, unknown>)[field]).toBe("number");
        expect(d.provenance).toBeDefined();
        expect((d.provenance as Record<string, unknown>)[field]).toBeDefined();
      }
      expect(typeof d.citation_url).toBe("string");
    }
  });

  it("R-4 row's genuinely non-extractable cells (lot-coverage schedule, formula-based side/rear yard) are marked not_specified with verbatim source text, never a guessed number", () => {
    const r4 = table.districts.find((d) => leadingToken(d.district_name) === "R-4")!;
    const prov = r4.provenance as Record<string, { not_specified?: boolean; quote: string }>;
    expect(prov.max_lot_coverage_pct.not_specified).toBe(true);
    expect(prov.max_lot_coverage_pct.quote).toMatch(/following schedule/);
    expect(prov.rear_ft.not_specified).toBe(true);
    expect(prov.side_ft.quote).toMatch(/D = 12 \+ L\/15/);
  });

  it("is NOT yet registered in SETBACK_TABLES (review gate honored — registration is a separate, planner-gated step)", () => {
    expect(SETBACK_JURISDICTION_KEYS).not.toContain("elgin-development-code");
    expect(getSetbackTable("elgin-development-code")).toBeNull();
    expect(getSetbackTableForZoning("elgin-development-code", "R-1")).toBeNull();
  });
});

describe("elgin-development-code.json — every cited atom_did exists in the frozen corpus snapshot", () => {
  // Mechanical load test: read the frozen snapshot once, build the set of
  // code-section entityIds, and assert every atom_did cited by the elgin
  // draft table resolves to a real entry. Uses entityId directly (the
  // setback-table atom_did format matches code-section entityId verbatim,
  // e.g. "elgin_tx/elgin-code-of-ordinances-current-supplement/46-233") —
  // consistent with how bastrop-development-code.json's atom_did values are
  // authored against the same corpus.
  const snapshotPath = path.resolve(
    __dirname,
    "../../../../../../services/retrieval-api/corpus/snapshot.json",
  );

  it("resolves the frozen corpus snapshot path", () => {
    // Fails loudly (ENOENT) rather than silently skipping if the relative
    // path assumption ever breaks under a package restructure.
    expect(() => readFileSync(snapshotPath, "utf-8")).not.toThrow();
  });

  it("every atom_did cited in elgin-development-code.json exists as a code-section entityId in the corpus", () => {
    const raw = readFileSync(snapshotPath, "utf-8");
    const snapshot = JSON.parse(raw) as { atoms: ReadonlyArray<{ entityType: string; entityId: string }> };
    const codeSectionIds = new Set(
      snapshot.atoms.filter((a) => a.entityType === "code-section").map((a) => a.entityId),
    );
    expect(codeSectionIds.size).toBeGreaterThan(0);

    const table = elginDevelopmentCode as SetbackTable;
    const citedDids = new Set<string>();
    for (const d of table.districts) {
      for (const prov of Object.values(d.provenance as Record<string, { atom_did: string }>)) {
        citedDids.add(prov.atom_did);
      }
    }
    expect(citedDids.size).toBeGreaterThan(0);

    const missing = [...citedDids].filter((did) => !codeSectionIds.has(did));
    expect(missing).toEqual([]);
  });

  it("every cited section belongs to Elgin's Chapter 46 zoning ordinance edition", () => {
    const raw = readFileSync(snapshotPath, "utf-8");
    const snapshot = JSON.parse(raw) as {
      atoms: ReadonlyArray<{ entityType: string; entityId: string; codeEditionId?: string }>;
    };
    const byId = new Map(
      snapshot.atoms.filter((a) => a.entityType === "code-section").map((a) => [a.entityId, a]),
    );

    const table = elginDevelopmentCode as SetbackTable;
    for (const d of table.districts) {
      for (const prov of Object.values(d.provenance as Record<string, { atom_did: string }>)) {
        const atom = byId.get(prov.atom_did);
        expect(atom, `missing corpus atom for ${prov.atom_did}`).toBeDefined();
        expect(atom!.codeEditionId).toBe("elgin_tx/elgin-code-of-ordinances-current-supplement");
      }
    }
  });
});
