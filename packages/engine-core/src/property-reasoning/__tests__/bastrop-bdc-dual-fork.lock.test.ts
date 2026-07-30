/**
 * WDLL STEP 3 item 3 — dual-fork lock: descriptor setbackTable VALUES must
 * match the adapter bastrop-development-code SURVIVOR for SF-1/SF-2/SF-3/RR.
 */

import { describe, expect, it } from "vitest";

import { getSetbackTable } from "@hauska-engine/adapters";
import bastropDescriptor from "../fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import { setbackTableDescriptorFromAdapter } from "../setback-table-from-adapter.js";

const CODES = ["SF-1", "SF-2", "SF-3", "RR"] as const;

describe("Bastrop setback dual-fork kill (WDLL STEP 3 item 3)", () => {
  it("adapter bastrop-development-code is the SURVIVOR with Euclidean rows", () => {
    const adapter = getSetbackTable("bastrop-development-code");
    expect(adapter).not.toBeNull();
    expect(adapter!.jurisdictionKey).toBe("bastrop-development-code");
    const tokens = adapter!.districts.map(
      (d) => d.district_name.trim().split(/\s+/)[0]!.toUpperCase(),
    );
    expect(tokens).toEqual(["SF-1", "SF-2", "SF-3", "RR"]);
  });

  it("descriptor setbackTable fronts match adapter for SF-1/SF-2/SF-3/RR", () => {
    const adapter = getSetbackTable("bastrop-development-code")!;
    const fromAdapter = setbackTableDescriptorFromAdapter(adapter)!;
    const fixture = bastropDescriptor.setbackTable!;

    for (const code of CODES) {
      const adapterRow = fromAdapter.rows.find(
        (r) => r.district_code.toUpperCase() === code,
      );
      const fixtureRow = fixture.rows.find(
        (r) => r.district_code.toUpperCase() === code,
      );
      expect(adapterRow, `adapter ${code}`).toBeDefined();
      expect(fixtureRow, `fixture ${code}`).toBeDefined();
      expect(fixtureRow!.front_ft!.value).toBe(adapterRow!.front_ft!.value);
      expect(fixtureRow!.side_ft!.value).toBe(adapterRow!.side_ft!.value);
      expect(fixtureRow!.side_corner_ft!.value).toBe(
        adapterRow!.side_corner_ft!.value,
      );
      expect(fixtureRow!.rear_ft!.value).toBe(adapterRow!.rear_ft!.value);
    }
  });

  it("descriptor setbackTable has no P-* rows (repealed B3 not current)", () => {
    const codes = bastropDescriptor.setbackTable!.rows.map((r) =>
      r.district_code.toUpperCase(),
    );
    expect(codes.some((c) => /^P-[1-5]$/.test(c))).toBe(false);
    expect(codes).toEqual(["SF-1", "SF-2", "SF-3", "RR"]);
  });
});
