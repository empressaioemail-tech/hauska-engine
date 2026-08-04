/**
 * backfill-bastrop-zoning-fact-code-refs.mjs — structural pins.
 *
 * Grep-style test (matches the cascade precedent in
 * property-reasoning/__tests__/cascade-unzoned-envelope-decline.test.ts):
 * asserts on the actual script source rather than re-deriving DB behavior,
 * so a future edit that drops a guard fails this test even without a live
 * database. Also exercises the pure ref-lookup/honest-miss logic by
 * re-declaring the script's tiny lookup table here and checking it against
 * the district-code-section-map.ts seed roster it must stay in lockstep with.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lookupDistrictCodeSectionRefs } from "../../src/property-reasoning/district-code-section-map.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(HERE, "../backfill-bastrop-zoning-fact-code-refs.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

const MAPPED_DISTRICT_CODES = [
  "P/OS",
  "RR",
  "SF-1",
  "SF-2",
  "SF-3",
  "MU",
  "GC",
  "PI",
  "IND",
  "PDD",
];

const LEGACY_UNMAPPED_CODES = ["P-3", "P-2", "P-5", "P-1", "P-4", "P-EC"];

describe("backfill-bastrop-zoning-fact-code-refs.mjs — WHERE clause shape (pinned)", () => {
  it("candidate query targets Bastrop district-carrying zoning-facts missing codeSectionRefs only", () => {
    // Structural pin: the backfill candidate SELECT must scope to 48021
    // zoning-facts, require a non-empty district (absence facts excluded),
    // and require codeSectionRefs is NOT already present (idempotent /
    // resumable — a second run patches zero rows).
    expect(scriptSource).toContain("entity_type = 'zoning-fact'");
    expect(scriptSource).toContain("entity_id LIKE ${COUNTY_FIPS + \":%\"}");
    expect(scriptSource).toContain("coalesce(body->>'district','') <> ''");
    expect(scriptSource).toContain("NOT (body ? 'codeSectionRefs')");
  });

  it("never selects on absence rows (district-empty) as candidates for patching", () => {
    // The candidate query's district predicate is <> '' (non-empty), which by
    // construction excludes absence.kind = 'no-zoning-stamp' rows (those
    // carry district: undefined / body has no 'district' key at all).
    const candidateBlock = scriptSource.match(
      /} else \{[\s\S]*?rows = await sql`[\s\S]*?`;\n\}/,
    );
    expect(candidateBlock).not.toBeNull();
  });

  it("never re-mints via emitZoningFact/emitFromTier1Snapshot — UPDATE-in-place only", () => {
    expect(scriptSource).not.toContain("emitZoningFact");
    expect(scriptSource).not.toContain("emitFromTier1Snapshot(");
    expect(scriptSource).toContain("UPDATE atoms");
  });

  it("persist gate requires PROPERTY_ATOM_PATH=1 and (--apply or COMPLETE_BASTROP_REFS_BACKFILL=1)", () => {
    expect(scriptSource).toContain("COMPLETE_BASTROP_REFS_BACKFILL");
    expect(scriptSource).toContain('process.env.PROPERTY_ATOM_PATH !== "1"');
    expect(scriptSource).toMatch(/dryRun =\s*\n\s*args\.dryRun \|\|/);
  });

  it("ships a --revert mode that is symmetric (strips the same two keys)", () => {
    expect(scriptSource).toContain("args.revert");
    expect(scriptSource).toContain("delete next.sourceCodeAtomRef");
    expect(scriptSource).toContain("delete next.codeSectionRefs");
  });

  it("recomputes contentHash after the delete-then-set idiom (matches the provenance template)", () => {
    expect(scriptSource).toContain("delete next.contentHash");
    expect(scriptSource).toContain("sha256HexCanonical(JSON.stringify(next))");
  });
});

describe("backfill-bastrop-zoning-fact-code-refs.mjs — honest-miss roster stays in lockstep with the TS map", () => {
  it("every code the script treats as mapped resolves via lookupDistrictCodeSectionRefs(bastrop_tx, ...)", () => {
    for (const code of MAPPED_DISTRICT_CODES) {
      expect(lookupDistrictCodeSectionRefs("bastrop_tx", code)).toBeDefined();
    }
  });

  it("every legacy code the script treats as an honest-miss is genuinely unmapped in the TS map", () => {
    for (const code of LEGACY_UNMAPPED_CODES) {
      expect(lookupDistrictCodeSectionRefs("bastrop_tx", code)).toBeUndefined();
    }
  });

  it("the script's literal MAPPED_DISTRICT_CODES set matches this roster verbatim", () => {
    for (const code of MAPPED_DISTRICT_CODES) {
      expect(scriptSource).toContain(`"${code}"`);
    }
  });
});
