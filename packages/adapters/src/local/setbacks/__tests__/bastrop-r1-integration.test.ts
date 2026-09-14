/**
 * P-154 (OPS-23 wave 3, AMENDED by A-148 in wave 6) — end-to-end proof that
 * `getSetbackTableForZoning`'s Bastrop branch resolves under R-1 (most-current
 * source wins) instead of "a supplied per-parcel record always wins" (the
 * pre-P-154 behavior, which is exactly the tier-first bug this program exists
 * to remove — see `authoritativeSetbackSource.ts` in legacy-design-tools, which
 * has the SAME bug independently).
 *
 * Fixture: the City of Bastrop's CURRENT, authoritative zoning-layer row for
 * `48021:34049` (1109 Pecan St, SF-1, corner lot) — `Zone_Types/FeatureServer/
 * 25`, OID 297, `ZoneTypeClass` 3, `editingInfo.lastEditDate` 2026-07-09,
 * live-verified 2026-09-14 via
 * `Zone_Types/FeatureServer/25/query?where=OBJECTID=297&f=json`.
 *
 * A-148 (overseer, 2026-09-14) — WHY THIS FIXTURE CHANGED. Wave 6 first read
 * F24 as TWO layers citing TWO ordinances (an older `Parcels_One_Click/23` row
 * printing 25/5/25/15 citing Ord. 2019-51, superseded by Ord. 2026-06). That is
 * superseded. The row below is ONE layer disagreeing WITH ITSELF: its TEXT
 * fields say 30/10/30/20 and the numeric shortcut columns its own One Click
 * join reads (`FrontSetback_`/`SideSetback_`/`RearSetback_`; there is NO
 * numeric corner column) still say 25/5/25, unrefreshed. The city's One Click
 * card reads the numbers, so a customer sees 25/5/25 while our card prints the
 * layer's text values. `Ordinance_` on the row is itself unrefreshed (it reads
 * "2019-51" live), which is why the served row and the conflict sentence are
 * dated by the current ordinance (2026-06, effective 2026-04-14) instead.
 */
import { describe, expect, it } from "vitest";

import { parseBastropPerParcelAttributes } from "../bastrop-per-parcel-record.js";
import { getSetbackTableForZoning } from "../index.js";

/** Real `Zone_Types/FeatureServer/25` row for OID 297, live-verified 2026-09-14. */
const LIVE_ZONE_TYPES_25_ROW_34049 = {
  OBJECTID: 297,
  prop_id: 34049,
  ZoneTypeClass: 3,
  // TEXT fields — the values the layer's own words (and Ord. 2026-06) carry.
  FrontSetback: "30 feet",
  SideSetback: "10 feet",
  RearSetback: "30 feet",
  CornerSideStreetSetback: "20 feet",
  // NUMERIC shortcut columns — read by the city's One Click join, never refreshed.
  FrontSetback_: 25,
  SideSetback_: 5,
  RearSetback_: 25,
  Ordinance_: "2019-51",
  LASTUPDATE: null,
};

describe("Bastrop SF-1, 48021:34049 — R-1 end to end through getSetbackTableForZoning", () => {
  it("parses the live authoritative row, serving the TEXT values and carrying the same-layer disagreement", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    // The value we follow is the TEXT value (30/10/30/20), corner included from
    // the layer's own `CornerSideStreetSetback` field.
    expect(parsed.frontFt).toBe(30);
    expect(parsed.sideInteriorFt).toBe(10);
    expect(parsed.sideCornerFt).toBe(20);
    expect(parsed.rearFt).toBe(30);
    expect(parsed.scalarFieldSource).toBe("text-field");
    // The second shape of R-1 conflict, detected at source: the SAME row's
    // numeric columns disagree with its text fields. Three numeric axes only.
    expect(parsed.textNumericDisagreement).toEqual({
      text: { front: 30, side: 10, rear: 30, corner: 20 },
      numeric: { front: 25, side: 5, rear: 25 },
    });
  });

  it("serves the layer's TEXT values 30/10/30/20 through the conflict arm, dated by the current ordinance", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");

    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    expect(resolution).not.toBeNull();
    // The same-layer disagreement is a CONFLICT ROW; the followed values are
    // still printable on `table` (R-1 names what we follow).
    expect(resolution!.kind).toBe("conflict");
    const district = resolution!.table.districts[0]!;
    expect(district.front_ft).toBe(30);
    expect(district.side_ft).toBe(10);
    expect(district.rear_ft).toBe(30);
    expect(district.side_corner_ft).toBe(20);
    // The row's own `Ordinance_` field is unrefreshed, so it cannot date these
    // text values: the followed row is dated by the current ordinance.
    expect(district.display_meta?.source_date).toBe("2026-04-14");
    expect(district.display_meta?.date_basis).toBe("ordinance-effective-date");
  });

  /**
   * Wave 6 (R-1 CONFLICT ROW), AMENDED by A-148. This is the exact structured
   * payload the one vocabulary sentence is built from on EVERY surface (panel,
   * `get_smart_site`, PDF): the city's One Click card showing the unrefreshed
   * numeric 25/5/25 versus the same layer's text and Ordinance 2026-06 saying
   * 30/10/30/20, confirmed with the City of Bastrop 2026-09-14.
   */
  it("names the One Click card's unrefreshed numeric columns as the second source — three axes, NO corner, current ordinance", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");

    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    expect(resolution!.kind).toBe("conflict");
    if (resolution!.kind !== "conflict") return;
    expect(resolution!.note).toEqual({
      shape: "stale-numeric-columns",
      secondSourceLabel: "One Click card",
      numeric: { front: 25, side: 5, rear: 25 },
      text: { front: 30, side: 10, rear: 30, corner: 20 },
      ordinance: "2026-06",
      confirmedWith: "the City of Bastrop",
      confirmedOn: "2026-09-14",
      source_date: "2026-04-14",
      date_basis: "ordinance-effective-date",
    });
    // The disclosure on the row and the resolution's own note are the same claim.
    expect(resolution!.table.districts[0]!.display_meta?.second_source?.conflict).toEqual(
      resolution!.note,
    );
  });

  /**
   * A-148 falsifier 1 — if the note still says the One Click values cite
   * Ordinance 2019-51 and that it was repealed, the amendment did not land.
   */
  it("A-148 falsifier: the superseded 2019-51 / repealed framing is GONE from the row", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    if (resolution!.kind !== "conflict") throw new Error("expected the conflict arm");
    const note = resolution!.note as Record<string, unknown>;
    // The two-instrument arm's fields are structurally absent from this shape.
    expect("citation" in note).toBe(false);
    expect("repealedByEffectiveDate" in note).toBe(false);
    const serialized = JSON.stringify(resolution!.table.districts[0]!.display_meta);
    expect(serialized).not.toMatch(/2019-51/);
    expect(serialized).not.toMatch(/repealed/i);
  });

  /**
   * A-148 falsifier 2 — a corner value for the second source would mean the
   * note read a numeric corner column that does not exist on the layer.
   */
  it("A-148 falsifier: the numeric second source carries three axes and no corner column", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    if (resolution!.kind !== "conflict") throw new Error("expected the conflict arm");
    if (resolution!.note.shape !== "stale-numeric-columns") throw new Error("expected the stale shape");
    expect(Object.keys(resolution!.note.numeric).sort()).toEqual(["front", "rear", "side"]);
  });

  /**
   * Pre-registered detector falsifier — the same layer with numeric columns
   * that AGREE with its text fields is not a conflict at all: the detector must
   * not fire, and no conflict sentence may appear on the row.
   */
  it("falsifier: numeric columns that agree with the text fields fire nothing", () => {
    const parsed = parseBastropPerParcelAttributes({
      ...LIVE_ZONE_TYPES_25_ROW_34049,
      FrontSetback_: 30,
      SideSetback_: 10,
      RearSetback_: 30,
    });
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    expect(parsed.textNumericDisagreement).toBeUndefined();
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    expect(resolution!.kind).toBe("table");
    expect(resolution!.table.districts[0]!.display_meta?.second_source).toBeUndefined();
  });

  it("without a per-parcel record supplied, R13 (AMENDMENT 8) is unchanged: city BDC districts still require layer-23 -> null, not the chart table", () => {
    // This is deliberately unchanged by P-154: R13 forbids serving the
    // codified chart alone for a Bastrop city BDC code — a per-parcel
    // record must be supplied before there is anything to resolve BETWEEN.
    const table = getSetbackTableForZoning("bastrop-development-code", "SF-1");
    expect(table).toBeNull();
  });
});
