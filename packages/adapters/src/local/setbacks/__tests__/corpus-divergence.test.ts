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
 * `findMatchingDistrict` below). Label text (district_name), citation_url,
 * and provenance metadata (verification_state, confidence, atom_did,
 * quote/note) are allowed to differ — those are real, already-documented
 * differences between the two repos' independent research passes (see the
 * corpus package's own CHANGELOG/README), not value regressions.
 *
 * `../index.ts` is now itself backed by the published package (the repoint
 * this test proved safe), so this file loads the still-on-disk vendored
 * `<jurisdiction>.json` files DIRECTLY as the frozen "old" baseline —
 * comparing `../index.ts` against the corpus package here would just be
 * comparing the corpus against itself. Retiring these JSON files is a
 * separate, later step; this test is what has to stay green up to that
 * point, and can be deleted along with them once they're gone.
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
  vendored: SetbackDistrict,
): SetbackDistrict | undefined | "ambiguous" {
  const exact = districts.find(
    (d) => normalizeDistrictName(d.district_name) === normalizeDistrictName(vendored.district_name),
  );
  if (exact) return exact;

  const wanted = leadingToken(vendored.district_name);
  const tokenMatches = districts.filter((d) => leadingToken(d.district_name) === wanted);
  if (tokenMatches.length === 1) return tokenMatches[0];
  if (tokenMatches.length > 1) return "ambiguous";
  return undefined;
}

describe("setback-corpus divergence — vendored copy vs published package", () => {
  it("every jurisdiction this repo vendors also resolves through the published package", () => {
    for (const key of Object.keys(VENDORED_TABLES)) {
      const corpusTable = getCorpusSetbackTable(key);
      expect(corpusTable, `${key}: not found in @empressaio/setback-corpus`).not.toBeNull();
    }
  });

  it("every vendored district's numeric setback values match the published package, district by district", () => {
    const mismatches: string[] = [];
    for (const [key, vendored] of Object.entries(VENDORED_TABLES)) {
      const corpus = getCorpusSetbackTable(key);
      if (!corpus) continue; // covered by the presence test above

      for (const vendoredDistrict of vendored.districts) {
        const corpusDistrict = findMatchingDistrict(corpus.districts, vendoredDistrict);
        if (corpusDistrict === "ambiguous") {
          mismatches.push(
            `${key}/${vendoredDistrict.district_name}: leading token ambiguous against multiple published districts, no exact name match either`,
          );
          continue;
        }
        if (!corpusDistrict) {
          mismatches.push(`${key}/${vendoredDistrict.district_name}: no matching district in the published package`);
          continue;
        }
        for (const field of NUMERIC_FIELDS) {
          const vendoredValue = vendoredDistrict[field];
          const corpusValue = corpusDistrict[field];
          if (vendoredValue !== corpusValue) {
            mismatches.push(
              `${key}/${vendoredDistrict.district_name}.${field}: vendored=${vendoredValue} published=${corpusValue}`,
            );
          }
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});
