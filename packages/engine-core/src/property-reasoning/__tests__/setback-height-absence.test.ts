/**
 * P-299 engine half — a height the code does not state in FEET never reaches an
 * engine output as a number.
 *
 * The corpus's canonical stated-absence sentinel for `max_height_ft` is 999
 * (hauska-setback-corpus rule G7). It is a placeholder, not a height: the meaning
 * lives in the row's `provenance.max_height_ft.not_specified` flag. On corpus
 * 1.4.0 that shape is everywhere — Round Rock's 21 non-MU districts state height
 * in STORIES, Bastrop's six Place Type rows do the same for half their rows — and
 * before this change the engine's emit path read `row.max_height_ft.value`
 * straight onto the setback-rule atom, so a "999 ft limit" was minted for rows
 * whose code states no feet figure at all.
 *
 * These tests drive the REAL corpus 1.4.0 tables (through the same
 * `getSetbackTable` the api-server uses) through the engine's own consumer —
 * `setbackTableDescriptorFromAdapter` -> `resolveSetbackTableRow` /
 * `emitSetbackRule` — so they fail if any future edit reintroduces the number.
 *
 * The rule is deliberately two-sided, mirroring legacy-design-tools'
 * `heightIsAbsent()` (`artifacts/api-server/src/routes/localSetbacks.ts`, P-299):
 * absent when the flag is set, AND absent when the bare sentinel arrives with no
 * flag — the corpus gate (G8) blocks that shape from shipping, but this boundary
 * reads adapter JSON directly, so it fails closed on the value too.
 */
import { describe, expect, it } from "vitest";

import { getSetbackTable } from "@hauska-engine/adapters";

import { emitSetbackRule } from "../emit-setback-rule.js";
import { setbackTableDescriptorFromAdapter } from "../setback-table-from-adapter.js";
import type { JurisdictionDescriptor, SetbackTableRowProvenance } from "../types.js";

const NOT_SPECIFIED_MAX_HEIGHT_FT = 999;

function descriptorFor(key: string): JurisdictionDescriptor {
  const table = getSetbackTable(key);
  if (!table) throw new Error(`${key} not carried by @empressaio/setback-corpus`);
  const setbackTable = setbackTableDescriptorFromAdapter(table as { districts?: unknown });
  if (!setbackTable) throw new Error(`${key}: adapter table produced no rows`);
  return {
    key,
    displayName: key,
    jurisdictionTenant: "hauska",
    parcelFips: "48000",
    defaultAccessPolicy: "public-free",
    setbackTable,
    sourceAdapter: key,
    sourceUrl: "https://example.gov/udc",
  };
}

function rowFor(
  descriptor: JurisdictionDescriptor,
  districtCode: string,
): SetbackTableRowProvenance {
  const row = descriptor.setbackTable?.rows.find((r) => r.district_code === districtCode);
  if (!row) throw new Error(`${descriptor.key}: no row for ${districtCode}`);
  return row;
}

function emit(descriptor: JurisdictionDescriptor, districtCode: string) {
  const atom = emitSetbackRule(
    descriptor,
    districtCode,
    rowFor(descriptor, districtCode),
    "48000:HEIGHT-1",
  );
  if ("kind" in atom) throw new Error(`${descriptor.key}/${districtCode}: ${atom.reason}`);
  return atom;
}

const ROUND_ROCK = descriptorFor("round-rock-tx");
const BASTROP_CITY = descriptorFor("bastrop-city-tx");

describe("P-299 — a flagged height never reaches an engine output as a number", () => {
  it("Round Rock SF-2 (height stated in stories) emits NO maxHeightFt field at all", () => {
    // The row as the corpus carries it: 999 with not_specified: true.
    const row = rowFor(ROUND_ROCK, "SF-2");
    expect(row.max_height_ft?.value).toBe(NOT_SPECIFIED_MAX_HEIGHT_FT);
    expect(row.max_height_ft?.not_specified).toBe(true);

    const atom = emit(ROUND_ROCK, "SF-2");
    expect("maxHeightFt" in atom).toBe(false);
    expect(atom.maxHeightFt).toBeUndefined();
    // And the key is gone from the serialized atom too, so no JSON round-trip
    // (or persisted row) can carry the placeholder forward.
    expect(JSON.stringify(atom)).not.toContain('"maxHeightFt"');
  });

  it("carries the REASON with the absence: fieldProvenance.height.notSpecified", () => {
    const atom = emit(ROUND_ROCK, "SF-2");
    expect(atom.fieldProvenance?.height).toMatchObject({ notSpecified: true });
    expect(atom.fieldProvenance?.height?.atomDid).toBe(atom.sourceCodeAtomRef.atomDid);
  });

  it("bastrop-city-tx P-3 (Place Type rows state height in stories) — same rule, second jurisdiction", () => {
    const atom = emit(BASTROP_CITY, "P-3");
    expect("maxHeightFt" in atom).toBe(false);
    expect(atom.fieldProvenance?.height).toMatchObject({ notSpecified: true });
  });

  it("positive control: a real feet height is still served, with no absence flag (the check cannot pass by nulling everything)", () => {
    const row = rowFor(ROUND_ROCK, "MU-1");
    expect(row.max_height_ft?.value).toBe(48);

    const atom = emit(ROUND_ROCK, "MU-1");
    expect(atom.maxHeightFt).toBe(48);
    expect(atom.fieldProvenance?.height?.notSpecified).toBeUndefined();
  });

  it("a BARE canonical sentinel with no flag is absent too — the value fails closed on its own", () => {
    // The corpus gate (G8) blocks this shape from shipping, but this boundary
    // reads adapter JSON directly, so it must not depend on the gate having run.
    const synthetic = setbackTableDescriptorFromAdapter({
      districts: [
        {
          district_name: "XX-1 Synthetic",
          front_ft: 25,
          rear_ft: 20,
          side_ft: 5,
          side_corner_ft: 15,
          max_height_ft: NOT_SPECIFIED_MAX_HEIGHT_FT,
        },
      ],
    });
    if (!synthetic) throw new Error("synthetic table produced no rows");
    const descriptor: JurisdictionDescriptor = {
      ...ROUND_ROCK,
      setbackTable: synthetic,
    };
    const atom = emit(descriptor, "XX-1");
    expect("maxHeightFt" in atom).toBe(false);
    expect(atom.fieldProvenance?.height).toMatchObject({ notSpecified: true });
  });

  it("the flag alone is enough — a non-sentinel number carrying not_specified is still an absence", () => {
    // Rule G7 forbids this shape shipping, but the FLAG is the payload: if a
    // table ever states 48 with not_specified, 48 is not a limit.
    const synthetic = setbackTableDescriptorFromAdapter({
      districts: [
        {
          district_name: "YY-1 Synthetic",
          front_ft: 25,
          rear_ft: 20,
          side_ft: 5,
          side_corner_ft: 15,
          max_height_ft: 48,
          provenance: { max_height_ft: { not_specified: true, confidence: 0.8 } },
        },
      ],
    });
    if (!synthetic) throw new Error("synthetic table produced no rows");
    const atom = emit({ ...ROUND_ROCK, setbackTable: synthetic }, "YY-1");
    expect("maxHeightFt" in atom).toBe(false);
  });
});
