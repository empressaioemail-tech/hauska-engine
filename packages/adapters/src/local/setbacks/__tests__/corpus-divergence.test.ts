/**
 * item 4 (setback-corpus consumer repointing, 2026-09-07): before this
 * repo's vendored `<jurisdiction>.json` tables are retired in favor of the
 * published `@empressaio/setback-corpus` package, every jurisdiction this
 * repo currently serves must be proven to still resolve to the SAME real
 * setback values through the package. This test is the proof — it fails on
 * disagreement, not on cosmetic/provenance-only drift.
 *
 * Deliberately compares only the seven numeric fields a customer-facing
 * envelope computation actually reads, matched district-by-district (see
 * `findMatchingDistrict` below). Label text (district_name) and citation_url
 * are allowed to differ — those are real, already-documented differences
 * between the two repos' independent research passes (see the corpus
 * package's own CHANGELOG/README), not value regressions.
 *
 * `../index.ts` is now itself backed by the published package (the repoint
 * this test proved safe), so this file loads the still-on-disk vendored
 * `<jurisdiction>.json` files DIRECTLY as the frozen "old" baseline —
 * comparing `../index.ts` against the corpus package here would just be
 * comparing the corpus against itself. Retiring these JSON files is a
 * separate, later step; this test is what has to stay green up to that
 * point, and can be deleted along with them once they're gone.
 *
 * CTX-B fix (2026-09-07, the Kyle regression): this test used to compare
 * ONLY the 7 numeric fields, and only in one direction
 * (`for (const vendoredDistrict of vendored.districts)`), which is exactly
 * the shape of the blind spot the Kyle regression exploited — a corpus
 * merge silently (a) added 4 districts absent from the baseline, never
 * examined by a one-directional loop, and (b) reverted 5 already-reviewed
 * districts' verification_state from `primary-source-verified` back to a
 * fabricated `human-verified`, a change this test's own prior docstring
 * explicitly excluded from comparison ("provenance metadata ... allowed to
 * differ"). Both halves of the regression are now checked: `compareTables`
 * is symmetric on the district set (set equality, not one-way containment)
 * and asserts provenance monotonicity on top of the numeric-value check.
 */
import { describe, expect, it } from "vitest";
import { getSetbackTable as getCorpusSetbackTable } from "@empressaio/setback-corpus";

import type { SetbackDistrict, SetbackTable } from "../table-types.js";

import grandCountyUt from "../grand-county-ut.json" with { type: "json" };
import lemhiCountyId from "../lemhi-county-id.json" with { type: "json" };
import bastropTx from "../bastrop-tx.json" with { type: "json" };
import bastropCityTx from "../bastrop-city-tx.json" with { type: "json" };
import bastropDevelopmentCode from "../bastrop-development-code.json" with { type: "json" };
import elginDevelopmentCode from "../elgin-development-code.json" with { type: "json" };
import austinTx from "../austin-tx.json" with { type: "json" };
import pflugervilleTx from "../pflugerville-tx.json" with { type: "json" };
import sanAntonioTx from "../san-antonio-tx.json" with { type: "json" };
import utahUnincorporated from "../utah-unincorporated.json" with { type: "json" };
import idahoUnincorporated from "../idaho-unincorporated.json" with { type: "json" };
import wacoTx from "../waco-tx.json" with { type: "json" };
import roundRockTx from "../round-rock-tx.json" with { type: "json" };
import kyleTx from "../kyle-tx.json" with { type: "json" };

// Frozen "old" baseline — the vendored JSON files as they sit on disk
// today, loaded directly rather than through ../index.ts. Same key set
// VENDORED_JURISDICTION_KEYS declares in index.ts, "elgin-tx" included
// (it aliases elgin-development-code.json there too).
const VENDORED_TABLES: Readonly<Record<string, SetbackTable>> = {
  "grand-county-ut": grandCountyUt as SetbackTable,
  "lemhi-county-id": lemhiCountyId as SetbackTable,
  "bastrop-tx": bastropTx as SetbackTable,
  "bastrop-city-tx": bastropCityTx as SetbackTable,
  "bastrop-development-code": bastropDevelopmentCode as SetbackTable,
  "elgin-development-code": elginDevelopmentCode as SetbackTable,
  "elgin-tx": elginDevelopmentCode as SetbackTable,
  "austin-tx": austinTx as SetbackTable,
  "pflugerville-tx": pflugervilleTx as SetbackTable,
  "san-antonio-tx": sanAntonioTx as SetbackTable,
  "utah-unincorporated": utahUnincorporated as SetbackTable,
  "idaho-unincorporated": idahoUnincorporated as SetbackTable,
  "waco-tx": wacoTx as SetbackTable,
  "round-rock-tx": roundRockTx as SetbackTable,
  "kyle-tx": kyleTx as SetbackTable,
};

const NUMERIC_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_height_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

/**
 * Claimed-evidentiary-strength rank for `verification_state`, used ONLY by
 * the monotonicity check below. NOT the "obvious" ranking (human-verified
 * highest) — deliberately inverted, because in this corpus `human-verified`
 * has now shipped with a fabricated, non-resolving `atom_did` TWICE
 * (Round Rock's original correction, and the Kyle regression this file
 * exists to catch): it is a claim this corpus has learned to distrust.
 * `primary-source-verified` is the earned, honest ceiling for a
 * jurisdiction confirmed to have zero code-section atoms — reaching it
 * requires a live check that no atom corpus exists (see kyle-tx.json's
 * CORRECTION note); a repoint replacing it with an unverified
 * `human-verified` is a regression in what the data can actually support,
 * even though the label reads "stronger". This rank exists to make that
 * regression a rank DECREASE so "never weaken" catches it.
 */
const VERIFICATION_STATE_RANK: Readonly<Record<string, number>> = {
  asserted: 0,
  "human-verified": 1,
  "primary-source-verified": 2,
};

function verificationStateOf(
  district: SetbackDistrict,
  field: (typeof NUMERIC_FIELDS)[number],
): string | undefined {
  const prov = district.provenance as
    | Record<string, { verification_state?: string } | undefined>
    | undefined;
  return prov?.[field]?.verification_state;
}

function normalizeDistrictName(districtName: string): string {
  return districtName.trim().toLowerCase().replace(/\s+/g, " ");
}

function leadingToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/**
 * Two-pass match, neither of which is safe alone:
 *   1. Full normalized name — precise, but breaks on legitimate cosmetic
 *      label differences between the two repos' independent research
 *      (e.g. Kyle's "R-1-1 Single-Family Residential District 1" vs the
 *      published package's "R-1-1 Single-Family Residential 1").
 *   2. Leading-token fallback, matching how `getSetbackTableForZoning`
 *      resolves districts elsewhere in this package — but ONLY when
 *      exactly one district in the target table shares that leading
 *      token. Some tables (the unincorporated-county fallback tables in
 *      particular) carry multiple districts sharing a first word
 *      ("Default Agricultural" vs "Default Unincorporated Residential");
 *      picking either one blind manufactures a false divergence instead
 *      of a real one, so an ambiguous leading token is reported as a
 *      genuine mismatch rather than silently guessed.
 */
function findMatchingDistrict(
  districts: ReadonlyArray<SetbackDistrict>,
  wanted: SetbackDistrict,
): SetbackDistrict | undefined | "ambiguous" {
  const exact = districts.find(
    (d) => normalizeDistrictName(d.district_name) === normalizeDistrictName(wanted.district_name),
  );
  if (exact) return exact;

  const token = leadingToken(wanted.district_name);
  const tokenMatches = districts.filter((d) => leadingToken(d.district_name) === token);
  if (tokenMatches.length === 1) return tokenMatches[0];
  if (tokenMatches.length > 1) return "ambiguous";
  return undefined;
}

/**
 * Districts present in exactly one table for a jurisdiction both tables
 * claim to serve, and not covered by an explicit, dated exception. Every
 * entry here MUST name why it is safe to ignore — an undated or unexplained
 * entry defeats the point of the allowlist (DEV_PROCESS 2.0: a control that
 * depends on someone remembering is not a control, so the exception itself
 * must be an explicit, reviewable artifact, not a blanket skip).
 */
const KNOWN_ASYMMETRIC_DISTRICTS: Readonly<
  Record<string, { side: "vendored-only" | "corpus-only"; districts: string[]; reason: string }[]>
> = {
  "kyle-tx": [
    {
      side: "corpus-only",
      districts: [
        "R-3-1 Multifamily Residential 1",
        "R-3-2 Multifamily Residential 2",
        "RS Retail Services",
        "M-2 Manufactured Home 2",
      ],
      reason:
        "Added to the corpus 2026-09-06/07 'for live GIS frequency' beyond the 5 districts hauska-engine's PR #393 reviewed. Legitimate coverage growth, not a regression: reviewed as part of the 2026-09-07 CTX-B Kyle-regression fix and confirmed honestly primary-source-verified (no atom corpus exists for kyle_tx at all, so none of Kyle's 9 districts can claim more). Left un-mirrored into this vendored baseline deliberately -- the baseline's own retirement is a separate, later step (see file header), not this fix's to do.",
    },
  ],
  "round-rock-tx": [
    {
      side: "corpus-only",
      districts: [
        "MH Manufactured Housing",
        "TF Two-Family",
        "TH Townhouse (Single-lot)",
        "SR Suburban Residential",
        "MF-1 Multifamily Residential 1",
        "MF-2 Multifamily Residential 2",
      ],
      reason:
        "2026-09-07 CTX-B Round Rock reconciliation, RULING 2 (operator-ruled): district breadth widened from this baseline's 4 Article-II-single-family-only rows to legacy-design-tools' full 10-district research pass, folded into the corpus. Legitimate, reviewed coverage growth (see round-rock-tx.json's own RECONCILED note for the full derivation), not a silent addition -- left un-mirrored into this frozen baseline deliberately, same as the Kyle entry above.",
    },
  ],
};

export interface TableMismatch {
  kind: "missing-in-corpus" | "extra-in-corpus" | "ambiguous-match" | "numeric-mismatch" | "verification-weakened";
  jurisdictionKey: string;
  district: string;
  field?: string;
  detail: string;
}

/**
 * Compare a vendored (baseline) table against the corpus package's table for
 * the same jurisdiction. Pure and side-effect-free so it can be exercised
 * directly against synthetic fixtures (see "prove by violation" below) as
 * well as against the two repos' real data.
 */
export function compareTables(
  jurisdictionKey: string,
  vendored: SetbackTable,
  corpus: SetbackTable,
): TableMismatch[] {
  const mismatches: TableMismatch[] = [];
  const allowed = KNOWN_ASYMMETRIC_DISTRICTS[jurisdictionKey] ?? [];
  const allowedCorpusOnly = new Set(
    allowed.filter((a) => a.side === "corpus-only").flatMap((a) => a.districts.map(normalizeDistrictName)),
  );
  const allowedVendoredOnly = new Set(
    allowed.filter((a) => a.side === "vendored-only").flatMap((a) => a.districts.map(normalizeDistrictName)),
  );

  // Direction 1: every vendored district must resolve in corpus, and its
  // numeric fields + verification_state ranks must match / not weaken.
  for (const vendoredDistrict of vendored.districts) {
    const match = findMatchingDistrict(corpus.districts, vendoredDistrict);
    if (match === "ambiguous") {
      mismatches.push({
        kind: "ambiguous-match",
        jurisdictionKey,
        district: vendoredDistrict.district_name,
        detail: "leading token ambiguous against multiple corpus districts, no exact name match either",
      });
      continue;
    }
    if (!match) {
      if (allowedVendoredOnly.has(normalizeDistrictName(vendoredDistrict.district_name))) continue;
      mismatches.push({
        kind: "missing-in-corpus",
        jurisdictionKey,
        district: vendoredDistrict.district_name,
        detail: "no matching district in the published package",
      });
      continue;
    }
    for (const field of NUMERIC_FIELDS) {
      const vendoredValue = vendoredDistrict[field];
      const corpusValue = match[field];
      if (vendoredValue !== corpusValue) {
        mismatches.push({
          kind: "numeric-mismatch",
          jurisdictionKey,
          district: vendoredDistrict.district_name,
          field,
          detail: `vendored=${vendoredValue} published=${corpusValue}`,
        });
      }

      const vendoredState = verificationStateOf(vendoredDistrict, field);
      const corpusState = verificationStateOf(match, field);
      if (vendoredState && corpusState) {
        const vendoredRank = VERIFICATION_STATE_RANK[vendoredState];
        const corpusRank = VERIFICATION_STATE_RANK[corpusState];
        if (vendoredRank !== undefined && corpusRank !== undefined && corpusRank < vendoredRank) {
          mismatches.push({
            kind: "verification-weakened",
            jurisdictionKey,
            district: vendoredDistrict.district_name,
            field,
            detail: `verification_state weakened: baseline=${vendoredState} published=${corpusState}`,
          });
        }
      }
    }
  }

  // Direction 2 (the fix): every corpus district for a jurisdiction the
  // baseline also serves must be traceable back to a vendored district (or
  // be an explicit, dated, reviewed exception). A one-directional loop is
  // exactly the shape that let 4 unreviewed Kyle districts through silently.
  for (const corpusDistrict of corpus.districts) {
    const match = findMatchingDistrict(vendored.districts, corpusDistrict);
    if (match === undefined) {
      if (allowedCorpusOnly.has(normalizeDistrictName(corpusDistrict.district_name))) continue;
      mismatches.push({
        kind: "extra-in-corpus",
        jurisdictionKey,
        district: corpusDistrict.district_name,
        detail:
          "published package carries this district but the vendored baseline does not -- new/unreviewed addition, add to KNOWN_ASYMMETRIC_DISTRICTS once reviewed or investigate as a regression",
      });
    }
  }

  return mismatches;
}

describe("setback-corpus divergence — vendored copy vs published package", () => {
  it("every jurisdiction this repo vendors also resolves through the published package", () => {
    for (const key of Object.keys(VENDORED_TABLES)) {
      const corpusTable = getCorpusSetbackTable(key);
      expect(corpusTable, `${key}: not found in @empressaio/setback-corpus`).not.toBeNull();
    }
  });

  it("every vendored district's numeric values and verification_state match the published package, symmetrically", () => {
    const mismatches: TableMismatch[] = [];
    for (const [key, vendored] of Object.entries(VENDORED_TABLES)) {
      const corpus = getCorpusSetbackTable(key);
      if (!corpus) continue; // covered by the presence test above
      mismatches.push(...compareTables(key, vendored, corpus as SetbackTable));
    }
    const rendered = mismatches
      .map((m) => `${m.kind} ${m.jurisdictionKey}/${m.district}${m.field ? "." + m.field : ""}: ${m.detail}`)
      .join("\n");
    expect(mismatches, rendered).toEqual([]);
  });
});

describe("compareTables — proof by violation (DEV_PROCESS 2.2: a check untested for its ability to fail is not a check)", () => {
  function table(districts: SetbackDistrict[]): SetbackTable {
    return {
      jurisdictionKey: "demo-tx",
      jurisdictionDisplayName: "Demo, TX",
      districts,
    };
  }

  function district(overrides: Partial<SetbackDistrict> = {}): SetbackDistrict {
    return {
      district_name: "SF-1",
      front_ft: 25,
      rear_ft: 20,
      side_ft: 5,
      side_corner_ft: 15,
      max_height_ft: 35,
      max_lot_coverage_pct: 40,
      max_impervious_pct: 55,
      citation_url: "https://example.gov/udc",
      provenance: {
        front_ft: { section_number: "1", quote: "q", confidence: 0.9, verification_state: "primary-source-verified" },
      } as SetbackDistrict["provenance"],
      ...overrides,
    };
  }

  it("passes on two identical tables (sanity: the check is not vacuously true)", () => {
    const t = table([district()]);
    expect(compareTables("demo-tx", t, t)).toEqual([]);
  });

  it("FAILS (reports a mismatch) on a corpus table with an extra, unreviewed district", () => {
    const vendored = table([district()]);
    const corpus = table([district(), district({ district_name: "SF-2" })]);
    const mismatches = compareTables("demo-tx", vendored, corpus);
    expect(mismatches.some((m) => m.kind === "extra-in-corpus" && m.district === "SF-2")).toBe(true);
  });

  it("FAILS (reports a mismatch) on a corpus table that weakens a verification_state — the exact Kyle-regression shape", () => {
    const vendored = table([
      district({
        provenance: {
          front_ft: {
            section_number: "1",
            quote: "q",
            confidence: 0.9,
            verification_state: "primary-source-verified",
          },
        } as SetbackDistrict["provenance"],
      }),
    ]);
    const corpus = table([
      district({
        provenance: {
          front_ft: {
            atom_did: "demo_tx/fabricated/1",
            section_number: "1",
            quote: "q",
            confidence: 0.95,
            verification_state: "human-verified",
          },
        } as SetbackDistrict["provenance"],
      }),
    ]);
    const mismatches = compareTables("demo-tx", vendored, corpus);
    expect(
      mismatches.some(
        (m) =>
          m.kind === "verification-weakened" &&
          m.field === "front_ft" &&
          m.detail.includes("baseline=primary-source-verified") &&
          m.detail.includes("published=human-verified"),
      ),
    ).toBe(true);
  });

  it("FAILS on BOTH violations at once when a corpus table combines an extra district with a weakened state (the actual Kyle shape)", () => {
    const reviewed = district({ district_name: "R-1-1" });
    const vendored = table([reviewed]);
    const corpusReviewed = district({
      district_name: "R-1-1",
      provenance: {
        front_ft: {
          atom_did: "kyle_tx/ch53/53-33",
          section_number: "1",
          quote: "q",
          confidence: 0.95,
          verification_state: "human-verified",
        },
      } as SetbackDistrict["provenance"],
    });
    const corpusUnreviewed = district({ district_name: "R-3-1" });
    const corpus = table([corpusReviewed, corpusUnreviewed]);
    const mismatches = compareTables("demo-tx", vendored, corpus);
    expect(mismatches.some((m) => m.kind === "verification-weakened")).toBe(true);
    expect(mismatches.some((m) => m.kind === "extra-in-corpus" && m.district === "R-3-1")).toBe(true);
    expect(mismatches.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag a strengthening (asserted -> primary-source-verified) as a weakening", () => {
    const vendored = table([
      district({
        provenance: {
          front_ft: { section_number: "1", quote: "q", confidence: 0.5, verification_state: "asserted" },
        } as SetbackDistrict["provenance"],
      }),
    ]);
    const corpus = table([
      district({
        provenance: {
          front_ft: {
            section_number: "1",
            quote: "q",
            confidence: 0.8,
            verification_state: "primary-source-verified",
          },
        } as SetbackDistrict["provenance"],
      }),
    ]);
    expect(compareTables("demo-tx", vendored, corpus)).toEqual([]);
  });

  it("does NOT flag the reviewed, allowlisted Kyle extras (regression guard on the allowlist itself)", () => {
    // If this test starts failing, either the allowlist has drifted from
    // reality or a real new asymmetry needs its own reviewed entry above.
    const vendored = table([district({ district_name: "R-1-1" })]);
    const corpus = table([
      district({ district_name: "R-1-1" }),
      district({ district_name: "R-3-1 Multifamily Residential 1" }),
      district({ district_name: "R-3-2 Multifamily Residential 2" }),
      district({ district_name: "RS Retail Services" }),
      district({ district_name: "M-2 Manufactured Home 2" }),
    ]);
    expect(compareTables("kyle-tx", vendored, corpus)).toEqual([]);
  });
});
