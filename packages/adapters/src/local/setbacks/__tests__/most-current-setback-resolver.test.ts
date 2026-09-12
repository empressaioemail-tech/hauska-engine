/**
 * P-154 (OPS-23 wave 3) — tests for the one setback resolver.
 *
 * Falsifier pre-registered at CP1 (verbatim from the dispatch): "if the
 * resolver picks a value for a parcel whose candidates disagree and whose
 * dates are unreadable, it is a silent pick and the change is wrong."
 * Non-vacuity, three required cases:
 *   1. two candidates differ by date where the LOWER tier is newer -> newer wins.
 *   2. dates are equal -> tier breaks it.
 *   3. an unreadable date -> conflict row, no value.
 */
import { describe, expect, it } from "vitest";
import {
  dateFromAtomSourceVintage,
  dateFromTableEffectiveDate,
  parseYearSequenceOrdinanceCitation,
  resolveMostCurrentSetback,
  type SetbackCandidate,
} from "../most-current-setback-resolver.js";

function candidate(partial: Partial<SetbackCandidate> & Pick<SetbackCandidate, "id" | "sourceKind" | "scalars" | "sourceDate" | "dateBasis">): SetbackCandidate {
  return {
    sourceLabel: partial.id,
    citationUrl: null,
    ...partial,
  };
}

const SCALARS_A = { front_ft: 30, side_ft: 10, rear_ft: 30, side_corner_ft: 20 };
const SCALARS_B = { front_ft: 25, side_ft: 5, rear_ft: 25, side_corner_ft: 15 };

describe("resolveMostCurrentSetback — non-vacuity (CP1 falsifier)", () => {
  it("case 1: the LOWER-tier candidate is newer and wins (date beats tier)", () => {
    const older_higher_tier = candidate({
      id: "ordinance",
      sourceKind: "codified-ordinance", // tier 3, highest
      scalars: SCALARS_B,
      sourceDate: "2015-01-01",
      dateBasis: "ordinance-effective-date",
    });
    const newer_lower_tier = candidate({
      id: "atom",
      sourceKind: "atom-chain", // tier 1, lowest
      scalars: SCALARS_A,
      sourceDate: "2026-06-01",
      dateBasis: "atom-source-vintage",
    });
    const res = resolveMostCurrentSetback([older_higher_tier, newer_lower_tier]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.winner.id).toBe("atom");
      expect(res.winner.scalars).toEqual(SCALARS_A);
    }
  });

  it("case 2: dates tie exactly -> tier breaks it", () => {
    const gis = candidate({
      id: "gis",
      sourceKind: "gis-per-parcel", // tier 2
      scalars: SCALARS_B,
      sourceDate: "2026-04-14",
      dateBasis: "gis-row-citation-ordinance",
    });
    const ordinance = candidate({
      id: "ordinance",
      sourceKind: "codified-ordinance", // tier 3
      scalars: SCALARS_A,
      sourceDate: "2026-04-14",
      dateBasis: "ordinance-effective-date",
    });
    const res = resolveMostCurrentSetback([gis, ordinance]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.winner.id).toBe("ordinance");
    }
  });

  it("case 3: an unreadable date that disagrees in value -> conflict, no value picked", () => {
    const ordinance = candidate({
      id: "ordinance",
      sourceKind: "codified-ordinance",
      scalars: SCALARS_A,
      sourceDate: "2026-04-14",
      dateBasis: "ordinance-effective-date",
    });
    const unreadableGis = candidate({
      id: "gis-unreadable",
      sourceKind: "gis-per-parcel",
      scalars: SCALARS_B, // disagrees with the ordinance
      sourceDate: null,
      dateBasis: "unreadable",
    });
    const res = resolveMostCurrentSetback([ordinance, unreadableGis]);
    expect(res.status).toBe("conflict");
    if (res.status === "conflict") {
      expect(res.candidates).toHaveLength(2);
      expect(res.candidates.map((c) => c.id).sort()).toEqual(["gis-unreadable", "ordinance"]);
    }
  });
});

describe("resolveMostCurrentSetback — other required behavior", () => {
  it("a single candidate resolves trivially, even with an unreadable date", () => {
    const only = candidate({
      id: "only",
      sourceKind: "codified-ordinance",
      scalars: SCALARS_A,
      sourceDate: null,
      dateBasis: "unreadable",
    });
    const res = resolveMostCurrentSetback([only]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.winner).toBe(only);
  });

  it("an unreadable-date candidate that AGREES in value is superseded, not a conflict", () => {
    const ordinance = candidate({
      id: "ordinance",
      sourceKind: "codified-ordinance",
      scalars: SCALARS_A,
      sourceDate: "2026-04-14",
      dateBasis: "ordinance-effective-date",
    });
    const agreeingUnreadable = candidate({
      id: "agrees",
      sourceKind: "atom-chain",
      scalars: SCALARS_A, // same value
      sourceDate: null,
      dateBasis: "unreadable",
    });
    const res = resolveMostCurrentSetback([ordinance, agreeingUnreadable]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.winner.id).toBe("ordinance");
      expect(res.superseded.map((s) => s.candidate.id)).toEqual(["agrees"]);
    }
  });

  it("no readable date anywhere + all candidates agree -> tier tie-break, resolved", () => {
    const a = candidate({ id: "a", sourceKind: "gis-per-parcel", scalars: SCALARS_A, sourceDate: null, dateBasis: "unreadable" });
    const b = candidate({ id: "b", sourceKind: "codified-ordinance", scalars: SCALARS_A, sourceDate: null, dateBasis: "unreadable" });
    const res = resolveMostCurrentSetback([a, b]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.winner.id).toBe("b"); // higher tier
  });

  it("no readable date anywhere + candidates DISAGREE -> conflict (tier cannot silently pick)", () => {
    const a = candidate({ id: "a", sourceKind: "gis-per-parcel", scalars: SCALARS_B, sourceDate: null, dateBasis: "unreadable" });
    const b = candidate({ id: "b", sourceKind: "codified-ordinance", scalars: SCALARS_A, sourceDate: null, dateBasis: "unreadable" });
    const res = resolveMostCurrentSetback([a, b]);
    expect(res.status).toBe("conflict");
  });

  it("two row-unattributed candidates disagreeing on the same dateBasis class -> conflict", () => {
    const layer23 = candidate({
      id: "layer23",
      sourceKind: "gis-per-parcel",
      scalars: SCALARS_B,
      sourceDate: "2026-08-24",
      dateBasis: "gis-layer-data-last-edit-unattributed",
    });
    const layer83 = candidate({
      id: "layer83",
      sourceKind: "gis-per-parcel",
      scalars: SCALARS_A,
      sourceDate: "2026-07-23",
      dateBasis: "gis-layer-data-last-edit-unattributed",
    });
    const res = resolveMostCurrentSetback([layer23, layer83]);
    expect(res.status).toBe("conflict");
  });
});

describe("48021:34049 — the parcel that opened R-1 (live-verified 2026-09-12)", () => {
  it("ordinance (2026-04-14, day-precise) beats layer-23's row citation (2019-51, year-precise) -> resolved 30/10/30/20", () => {
    const citationDate = parseYearSequenceOrdinanceCitation("2019-51");
    expect(citationDate).toEqual({ sourceDate: "2019-01-01", datePrecision: "year", year: 2019 });

    const ordinance = candidate({
      id: "bastrop-development-code",
      sourceKind: "codified-ordinance",
      sourceLabel: "City of Bastrop, TX (Bastrop Development Code / Ord. 2026-06)",
      scalars: { front_ft: 30, side_ft: 10, rear_ft: 30, side_corner_ft: 20 },
      ...dateFromTableEffectiveDate("2026-04-14"),
      citationUrl:
        "https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE%20NO.%202026-06%20B3%20Code%20Repeal%20and%20Bastrop%20Development%20Code%20Adoption.pdf",
    });
    const layer23 = candidate({
      id: "layer-23-prop-34049",
      sourceKind: "gis-per-parcel",
      sourceLabel: "Bastrop Parcels_One_Click layer 23, prop_id=34049",
      scalars: { front_ft: 25, side_ft: 5, rear_ft: 25, side_corner_ft: 15 },
      sourceDate: citationDate!.sourceDate,
      datePrecision: citationDate!.datePrecision,
      dateBasis: "gis-row-citation-ordinance",
      citationUrl:
        "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Parcels_One_Click/FeatureServer/23",
    });

    const res = resolveMostCurrentSetback([ordinance, layer23]);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.winner.id).toBe("bastrop-development-code");
      expect(res.winner.scalars).toEqual({ front_ft: 30, side_ft: 10, rear_ft: 30, side_corner_ft: 20 });
      expect(res.winner.sourceDate).toBe("2026-04-14");
      expect(res.superseded[0]!.candidate.id).toBe("layer-23-prop-34049");
    }
  });
});

describe("date-basis helpers", () => {
  it("dateFromAtomSourceVintage never reads extractedAt-shaped emit timestamps as a source date without being told to", () => {
    // extractedAt is emit time; a caller must not pass it here labeled as sourceVintage.
    const res = dateFromAtomSourceVintage(null);
    expect(res).toEqual({ sourceDate: null, dateBasis: "unreadable" });
  });

  it("dateFromTableEffectiveDate rejects a non-ISO or missing effectiveDate as unreadable, never 1970-01-01", () => {
    expect(dateFromTableEffectiveDate(undefined)).toEqual({ sourceDate: null, dateBasis: "unreadable" });
    expect(dateFromTableEffectiveDate("accessed 2026-07-23")).toEqual({ sourceDate: null, dateBasis: "unreadable" });
    expect(dateFromTableEffectiveDate("2026-04-14")).toEqual({
      sourceDate: "2026-04-14",
      dateBasis: "ordinance-effective-date",
      datePrecision: "day",
    });
  });

  it("parseYearSequenceOrdinanceCitation declines a citation that isn't the year-sequence shape", () => {
    expect(parseYearSequenceOrdinanceCitation(null)).toBeNull();
    expect(parseYearSequenceOrdinanceCitation("")).toBeNull();
    expect(parseYearSequenceOrdinanceCitation("not an ordinance")).toBeNull();
    expect(parseYearSequenceOrdinanceCitation("99-51")).toBeNull();
  });
});
