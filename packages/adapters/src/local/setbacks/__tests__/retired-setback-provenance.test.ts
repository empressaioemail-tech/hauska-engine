/**
 * P-219 — the CI check that fails if `bastrop-per-parcel/*` reappears as a
 * served setback value.
 *
 * DEV_PROCESS 2.2: a gating indicator is tested for its ability to FIRE before
 * it is trusted, and 2.3: prove the negative case on the real result, not on a
 * pipe. So this file asserts BOTH directions on every claim — the guard says
 * yes to a retired DID and no to a live one, and the resolver's followed row
 * carries a live provenance while a deliberately reintroduced retired one is
 * caught. A check that cannot fail for the right reason is a defect, not a
 * check.
 *
 * Retirement is proven by DECLINE, never by documentation (dispatch, P-219).
 */
import { describe, expect, it } from "vitest";

import {
  RETIRED_SETBACK_DECLINE_REASON,
  RETIRED_SETBACK_PROVENANCE_PREFIXES,
  isRetiredSetbackProvenance,
  retiredSetbackDecline,
} from "../retired-setback-provenance.js";
import { parseBastropPerParcelAttributes } from "../bastrop-per-parcel-record.js";
import { getSetbackTableForZoning } from "../index.js";

/**
 * The LIVE `Parcels_One_Click/FeatureServer/23` row for prop_id 34049,
 * read at source 2026-09-15. This is what the production fetcher actually
 * returns — note that it is NOT the `Zone_Types/FeatureServer/25` row the
 * A-148 fixture in `bastrop-r1-integration.test.ts` uses: layer 23 has no
 * `CornerSideStreetSetback` column, its text fields AGREE with its numeric
 * columns at 25/5/25, and its `Ordinance_` reads "2019-51". That is why the
 * same-layer (stale-numeric-columns) arm does NOT fire on the live fetch path
 * and the two-candidate arm is what runs in production.
 */
const LIVE_LAYER_23_ROW_34049 = {
  prop_id: 34049,
  ZoneTypeClass: 3,
  FrontSetback_: 25,
  FrontSetback: "25 ft (porches may encroach up to 10 ft)",
  SideSetback_: 5,
  SideSetback: "5 ft (Corner Side Street Setback: 15 ft)",
  RearSetback_: 25,
  RearSetback: "25 ft",
  MaxBuildingHt: 35,
  MinimumLotSize_: 0.33,
  MaxImpervisionCoverage: "50%",
  Ordinance_: "2019-51",
  Shape__Area: 29552.365234375,
};

describe("P-219 retired setback provenance — the guard fires in both directions", () => {
  it("says YES to every retired prefix", () => {
    for (const prefix of RETIRED_SETBACK_PROVENANCE_PREFIXES) {
      expect(isRetiredSetbackProvenance(`${prefix}34049/front`)).toBe(true);
    }
    // The exact string both PDF products printed, live 2026-09-15.
    expect(isRetiredSetbackProvenance("bastrop-per-parcel/34049/front")).toBe(true);
    expect(isRetiredSetbackProvenance("bastrop-per-parcel/34049/side-corner")).toBe(true);
    // Case-insensitive on the head of the DID.
    expect(isRetiredSetbackProvenance("BASTROP-PER-PARCEL/34049/rear")).toBe(true);
  });

  it("says NO to a live provenance, so the check cannot be passing by accident", () => {
    // The ordinance-backed DID the BDC corpus row carries — the source that
    // takes over. If this ever read `true`, the guard would decline everything
    // and the "retirement" would be an outage wearing a rule's clothes.
    expect(isRetiredSetbackProvenance("bastrop_tx/bdc-2026-adopted/14.02.003")).toBe(false);
    expect(isRetiredSetbackProvenance("elgin_tx/edc-2025/5.3")).toBe(false);
    // A DID that merely CONTAINS the prefix is not retired — the rule is a
    // namespace head, not a substring, or an unrelated source could be
    // silently declined by a coincidence of spelling.
    expect(isRetiredSetbackProvenance("city/bastrop-per-parcel/34049/front")).toBe(false);
  });

  it("treats an absent or empty DID as NOT retired (an empty result is not an absence)", () => {
    expect(isRetiredSetbackProvenance(null)).toBe(false);
    expect(isRetiredSetbackProvenance(undefined)).toBe(false);
    expect(isRetiredSetbackProvenance("")).toBe(false);
    expect(isRetiredSetbackProvenance("   ")).toBe(false);
  });

  it("carries one decline shape, with the reason a surface prints", () => {
    const decline = retiredSetbackDecline("bastrop-per-parcel/34049/front");
    expect(decline.kind).toBe("retired-setback-provenance");
    expect(decline.atomDid).toBe("bastrop-per-parcel/34049/front");
    expect(decline.reason).toBe(RETIRED_SETBACK_DECLINE_REASON);
    // The decline never restates the retired NUMBERS: a refusal that prints
    // the value it refuses has refused nothing.
    expect(decline.reason).not.toMatch(/\b25\b|\b5\b/);
  });
});

describe("P-219 retirement, proven by decline on the live layer-23 row for 48021:34049", () => {
  it("parses the live row exactly as production does — 25/5/25, corner 15, Ordinance 2019-51", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.frontFt).toBe(25);
    expect(parsed.sideInteriorFt).toBe(5);
    expect(parsed.rearFt).toBe(25);
    expect(parsed.sideCornerFt).toBe(15);
    // Layer 23's own text and numeric columns AGREE, so the same-layer arm
    // does not fire here. This is the production path, and it is a different
    // path from the A-148 fixture's.
    expect(parsed.textNumericDisagreement).toBeUndefined();
  });

  it("serves the RULED 30/10/30/20 and no served scalar cites the retired namespace", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    expect(resolution).not.toBeNull();
    const row = resolution!.table.districts[0]!;
    expect(row.front_ft).toBe(30);
    expect(row.side_ft).toBe(10);
    expect(row.rear_ft).toBe(30);
    expect(row.side_corner_ft).toBe(20);

    // THE CI CHECK. Every scalar on the followed row must rest on a live
    // provenance. If a future edit lets the per-parcel table become the
    // followed table again, this fails here rather than on a customer's PDF.
    const provenance = row.provenance as
      | Record<string, { atom_did?: string } | undefined>
      | undefined;
    const retired = Object.entries(provenance ?? {})
      .filter(([, v]) => isRetiredSetbackProvenance(v?.atom_did))
      .map(([axis, v]) => `${axis}=${v?.atom_did}`);
    expect(retired).toEqual([]);
    expect(row.provenance?.front_ft).toMatchObject({
      atom_did: "bastrop_tx/bdc-2026-adopted/14.02.003",
    });
  });

  it("FAILS on a deliberately reintroduced retired provenance (the check can fire)", () => {
    // The negative control. This is the shape the served row had before
    // P-219 — literally the string the feasibility study printed. The same
    // scan that returns [] above must return it.
    const regressedRow = {
      provenance: {
        front_ft: { atom_did: "bastrop-per-parcel/34049/front" },
        side_ft: { atom_did: "bastrop-per-parcel/34049/side-interior" },
        rear_ft: { atom_did: "bastrop-per-parcel/34049/rear" },
        side_corner_ft: { atom_did: "bastrop-per-parcel/34049/side-corner" },
      },
    };
    const retired = Object.entries(regressedRow.provenance)
      .filter(([, v]) => isRetiredSetbackProvenance(v.atom_did))
      .map(([axis]) => axis);
    expect(retired.sort()).toEqual(["front_ft", "rear_ft", "side_corner_ft", "side_ft"]);
  });

  it("still NAMES the retired source as the second source — the P-154 conflict row survives", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    // Retiring a value author must not silence the disclosure that the city's
    // own card shows different numbers. F24 / P-154 exist to say exactly that.
    expect(resolution!.kind).toBe("conflict");
    if (resolution!.kind !== "conflict") return;
    expect(resolution!.secondSource.id).toBe("bastrop-per-parcel-record");
    expect(resolution!.secondSource.scalars).toMatchObject({
      front_ft: 25,
      side_ft: 5,
      rear_ft: 25,
    });
  });
});
