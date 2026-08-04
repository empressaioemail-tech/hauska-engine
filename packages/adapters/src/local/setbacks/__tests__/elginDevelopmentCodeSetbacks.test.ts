/**
 * Elgin onboarding (2026-08-03 draft, 2026-08-04 RATIFIED by operator after
 * planner row-verification — see doc_repo
 * _sessions/2026-08-03_elgin_foundation_and_city_code_refs, and the
 * ratification note on the elgin-development-code.json import in
 * index.ts). elgin-development-code.json is now registered in
 * SETBACK_TABLES (index.ts) and reachable through
 * getSetbackTable/getSetbackTableForZoning. This test suite covers:
 *
 *   1. the raw JSON file's shape (8 districts, all required scalar fields);
 *   2. every cited atom_did actually exists as a code-section entityId in
 *      the frozen corpus snapshot (mechanical grep/load test, per dispatch);
 *   3. the table IS registered and reachable through
 *      getSetbackTable/getSetbackTableForZoning (ratification wired it in);
 *   4. conditional cells carry a structured, additive governed_by (or
 *      governed_by_dwellings) object per the operator's ratification
 *      directive, alongside the existing provenance quote/note — values are
 *      byte-unchanged from the ratified draft.
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

describe("elgin-development-code.json — ratified shape", () => {
  const table = elginDevelopmentCode as SetbackTable;

  it("carries the authoring provenance note (source corpus + district roster)", () => {
    expect(table.note).toMatch(/authored 2026-08-03/);
    expect(table.note).toMatch(/Elgin Code of Ordinances/);
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

  it("is registered in SETBACK_TABLES and reachable through getSetbackTable/getSetbackTableForZoning (ratified 2026-08-04)", () => {
    expect(SETBACK_JURISDICTION_KEYS).toContain("elgin-development-code");
    expect(SETBACK_JURISDICTION_KEYS).toContain("elgin-tx");
    expect(getSetbackTable("elgin-development-code")).not.toBeNull();
    expect(getSetbackTable("elgin-tx")).not.toBeNull();
    expect(getSetbackTable("elgin-tx")).toBe(getSetbackTable("elgin-development-code"));
    expect(getSetbackTableForZoning("elgin-development-code", "R-1")).not.toBeNull();
    expect(getSetbackTableForZoning("elgin-development-code", "R-1")?.jurisdictionKey).toBe(
      "elgin-development-code",
    );
    expect(getSetbackTableForZoning("elgin-tx", "R-1")).not.toBeNull();
    expect(getSetbackTableForZoning("elgin-tx", "R-1")).toBe(
      getSetbackTableForZoning("elgin-development-code", "R-1"),
    );
  });

  it("C-2 conditional yard cells (front/rear/side/side_corner) carry governed_by routing to C-1 plus governed_by_dwellings routing to R-4, per operator ratification directive", () => {
    const c2 = table.districts.find((d) => leadingToken(d.district_name) === "C-2")!;
    const prov = c2.provenance as Record<
      string,
      {
        governed_by?: { condition?: string; district?: string; section_number?: string; note?: string };
        governed_by_dwellings?: { district?: string; section_number?: string };
      }
    >;
    for (const field of ["front_ft", "rear_ft", "side_ft", "side_corner_ft"] as const) {
      expect(prov[field].governed_by).toBeDefined();
      expect(prov[field].governed_by?.condition).toBe("adjacent-to-residential");
      expect(prov[field].governed_by?.district).toBe("C-1");
      expect(prov[field].governed_by?.section_number).toBe("46-391");
      expect(prov[field].governed_by_dwellings).toBeDefined();
      expect(prov[field].governed_by_dwellings?.district).toBe("R-4");
      expect(prov[field].governed_by_dwellings?.section_number).toBe("46-391");
    }
  });

  it("I (Industrial) front/side cells carry governed_by adjoins-dwelling-district at 25 ft, section 46-441", () => {
    const industrial = table.districts.find((d) => leadingToken(d.district_name) === "I")!;
    const prov = industrial.provenance as Record<
      string,
      { governed_by?: { condition?: string; value_ft?: number; section_number?: string } }
    >;
    for (const field of ["front_ft", "side_ft"] as const) {
      expect(prov[field].governed_by).toBeDefined();
      expect(prov[field].governed_by?.condition).toBe("adjoins-dwelling-district");
      expect(prov[field].governed_by?.value_ft).toBe(25);
      expect(prov[field].governed_by?.section_number).toBe("46-441");
    }
  });

  it("I (Industrial) rear cell carries governed_by conditions array (serviced-from-rear 30ft, adjoins-dwelling-district 25ft), section 46-441", () => {
    const industrial = table.districts.find((d) => leadingToken(d.district_name) === "I")!;
    const prov = industrial.provenance as Record<
      string,
      {
        governed_by?: {
          conditions?: Array<{ condition: string; value_ft?: number }>;
          section_number?: string;
        };
      }
    >;
    const governedBy = prov.rear_ft.governed_by;
    expect(governedBy).toBeDefined();
    expect(governedBy?.section_number).toBe("46-441");
    expect(governedBy?.conditions).toEqual([
      { condition: "serviced-from-rear", value_ft: 30 },
      { condition: "adjoins-dwelling-district", value_ft: 25 },
    ]);
  });

  it("R-4 rear cell carries governed_by conditions array (default formula, backs-to-residential 50ft), section 46-333", () => {
    const r4 = table.districts.find((d) => leadingToken(d.district_name) === "R-4")!;
    const prov = r4.provenance as Record<
      string,
      {
        governed_by?: {
          conditions?: Array<{ condition: string; value_ft?: number; note?: string }>;
          section_number?: string;
        };
      }
    >;
    const governedBy = prov.rear_ft.governed_by;
    expect(governedBy).toBeDefined();
    expect(governedBy?.section_number).toBe("46-333");
    expect(governedBy?.conditions).toEqual([
      { condition: "default", note: "same as side yard (formula D = 12 + L/15)" },
      { condition: "backs-to-residential", value_ft: 50 },
    ]);
  });

  it("governed_by is additive only — existing quote/note/confidence/verification_state/not_specified values are byte-unchanged from the ratified draft", () => {
    const r4 = table.districts.find((d) => leadingToken(d.district_name) === "R-4")!;
    const r4Prov = r4.provenance as Record<string, { quote: string; not_specified?: boolean }>;
    expect(r4Prov.rear_ft.quote).toBe(
      "Rear yard. For multiple-family dwellings, same as side yard except where property backs up to residentially zoned property the rear yard must have a depth of 50 feet including parking areas.",
    );
    expect(r4Prov.rear_ft.not_specified).toBe(true);

    const c2 = table.districts.find((d) => leadingToken(d.district_name) === "C-2")!;
    const c2Prov = c2.provenance as Record<string, { quote: string }>;
    expect(c2Prov.front_ft.quote).toBe(
      "Front, side and rear yards. There are no specific front, side or rear yard requirements for uses other than dwellings, except where the property is adjacent to residential property, then the yard requirements shall be the same as in the C-1 Neighborhood Shopping District.",
    );

    const industrial = table.districts.find((d) => leadingToken(d.district_name) === "I")!;
    const iProv = industrial.provenance as Record<string, { quote: string }>;
    expect(iProv.rear_ft.quote).toBe(
      "Rear yard. Where a building is to be serviced from the rear there shall be provided an alley, service court, rear yard or combination thereof of not less than 30 feet in width ... In all other cases no rear yard is required; provided, however, that a building shall set back a distance of not less than 25 feet from the rear lot line that adjoins a dwelling district.",
    );
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
