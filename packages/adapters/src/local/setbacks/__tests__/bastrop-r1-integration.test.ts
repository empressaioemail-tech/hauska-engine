/**
 * P-154 (OPS-23 wave 3) — end-to-end proof that `getSetbackTableForZoning`'s
 * Bastrop branch now resolves under R-1 (most-current source wins) instead
 * of "a supplied per-parcel record always wins" (the pre-P-154 behavior,
 * which is exactly the tier-first bug this program exists to remove — see
 * `authoritativeSetbackSource.ts` in legacy-design-tools, which has the
 * SAME bug independently).
 *
 * Fixture: the real layer-23 attributes for `48021:34049` (1109 Pecan St,
 * Bastrop, SF-1, corner lot), live-verified 2026-09-12 via
 * `Parcels_One_Click/FeatureServer/23/query?where=prop_id=34049`.
 */
import { describe, expect, it } from "vitest";

import { parseBastropPerParcelAttributes } from "../bastrop-per-parcel-record.js";
import { getSetbackTableForZoning } from "../index.js";

/** Real layer-23 row for prop_id=34049, live-verified 2026-09-12. */
const LIVE_LAYER_23_ROW_34049 = {
  prop_id: 34049,
  ZoneTypeClass: 3,
  FrontSetback_: 25,
  FrontSetback: "25 ft (porches may encroach up to 10 ft)",
  SideSetback_: 5,
  SideSetback: "5 ft (Corner Side Street Setback: 15 ft)",
  RearSetback_: 25,
  RearSetback: "25 ft",
  Ordinance_: "2019-51",
  LASTUPDATE: null,
};

describe("Bastrop SF-1, prop_id=34049 — R-1 end to end through getSetbackTableForZoning", () => {
  it("parses the live row with a resolvable citation date (2019, year-precision) — NOT unreadable, NOT a placeholder", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(25);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.sideCornerFt).toBe(15);
    expect(parsed.rearFt).toBe(25);
    expect(parsed.sourceDate).toBe("2019-01-01");
    expect(parsed.dateBasis).toBe("gis-row-citation-ordinance");
    expect(parsed.datePrecision).toBe("year");
  });

  it("getSetbackTableForZoning returns the CODIFIED 30/10/30/20 (2026-04-14 beats 2019), not the per-parcel 25/5/25/15", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");

    const table = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    expect(table).not.toBeNull();
    const district = table!.districts.find((d) => d.district_name.startsWith("SF-1"));
    expect(district).toBeDefined();
    expect(district!.front_ft).toBe(30);
    expect(district!.side_ft).toBe(10);
    expect(district!.rear_ft).toBe(30);
    expect(district!.side_corner_ft).toBe(20);

    // R-1: the winning table must carry ITS OWN source date, and the
    // superseded per-parcel candidate must be disclosed, not dropped.
    expect(district!.display_meta?.source_date).toBe("2026-04-14");
    expect(district!.display_meta?.date_basis).toBe("ordinance-effective-date");
    expect(district!.display_meta?.second_source?.note).toMatch(/25\/5\/25\/15/);
  });

  it("without a per-parcel record supplied, R13 (AMENDMENT 8) is unchanged: city BDC districts still require layer-23 -> null, not the chart table", () => {
    // This is deliberately unchanged by P-154: R13 forbids serving the
    // codified chart alone for a Bastrop city BDC code — a per-parcel
    // record must be supplied before there is anything to resolve BETWEEN.
    const table = getSetbackTableForZoning("bastrop-development-code", "SF-1");
    expect(table).toBeNull();
  });
});
