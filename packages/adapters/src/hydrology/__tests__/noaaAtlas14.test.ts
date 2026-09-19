/**
 * G-165. READ THIS BEFORE TRUSTING A GREEN RUN IN THIS FILE.
 *
 * The pre-G-165 version of this test file held this fixture:
 *
 *   const html = `<table>
 *       <tr><td>100</td><td>6.2</td></tr>
 *       <tr><td>25</td><td>4.1</td></tr>
 *     </table>`;
 *   expect(parsePfdsDepthTable(html).get(100)).toBe(6.2);
 *
 * That HTML table is NOT the shape the HDSC endpoint returns and has not been
 * since at least 2026-09-14. The suite stayed green for as long as it did
 * because the test asserted the parser against a fixture the parser was written
 * for, while production asked a different question. The fixture below is the
 * REAL payload, captured live from
 *   https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py?lat=30.110500&lon=-97.316900&type=pf&data=depth&units=english&series=pds
 * on 2026-09-18, HTTP 200, 5074 bytes on disk (the payload embeds a
 * non-reproducible `pyRunTime` float, so the raw body is not byte-stable; the
 * `quantiles` matrix is).
 *
 * The old `<tr><td>` fixture is still here — as a REFUSAL case, which is what
 * it now is.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach } from "vitest";

import {
  buildPfdsUrl,
  parsePfdsDepthTable,
  pfdsRefusalTally,
  resetPfdsRefusalTally,
  PfdsRefusal,
  PFDS_DURATION_ROWS,
  PFDS_RETURN_PERIOD_COLUMNS,
} from "../noaaAtlas14.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");

const BASTROP = fixture("pfds-bastrop-tx-2026-09-18.pfds.txt");
const EL_PASO = fixture("pfds-el-paso-tx-2026-09-18.pfds.txt");
const OUTSIDE_ATLAS14 = fixture("pfds-uncovered-outside-atlas14-2026-09-18.pfds.txt");

const BASTROP_LATLNG = { lat: 30.1105, lng: -97.3169 };

/** The retired 2026 fixture, kept only as a payload the parser must refuse. */
const RETIRED_HTML_TABLE = `
  <table>
    <tr><td>100</td><td>6.2</td></tr>
    <tr><td>25</td><td>4.1</td></tr>
  </table>
`;

/** Rebuild `payload` with a mutated `quantiles` matrix, keeping the rest intact. */
function withMutatedQuantiles(
  payload: string,
  mutate: (rows: string[][]) => string[][],
): string {
  const m = /quantiles = (\[\[.*?\]\]);/s.exec(payload);
  if (!m?.[1]) throw new Error("fixture has no quantiles literal");
  const rows = JSON.parse(m[1].replace(/'/g, '"')) as string[][];
  return payload.replace(m[1], JSON.stringify(mutate(rows)).replace(/"/g, "'"));
}

const refusalFrom = (fn: () => unknown): PfdsRefusal => {
  try {
    fn();
  } catch (err) {
    if (err instanceof PfdsRefusal) return err;
    throw err;
  }
  throw new Error("expected a PfdsRefusal, but nothing was thrown");
};

describe("noaaAtlas14", () => {
  beforeEach(() => resetPfdsRefusalTally());

  it("buildPfdsUrl includes lat/lon and depth params", () => {
    const url = buildPfdsUrl(30.5086, -97.6789);
    expect(url).toContain("lat=30.508600");
    expect(url).toContain("lon=-97.678900");
    expect(url).toContain("data=depth");
  });

  // ── The live shape (G-165) ────────────────────────────────────────────────

  it("parses the REAL HDSC payload shape (JavaScript array literal), 24-hr by return period", () => {
    const parsed = parsePfdsDepthTable(BASTROP, {
      durationHours: 24,
      expectLatLng: BASTROP_LATLNG,
    });
    // Bastrop's own 24-hr row, cross-checked against the labeled endpoint
    // fe_text.csv on the same day: 3.21,4.17,5.51,6.81,8.81,10.5,12.6,14.9,18.5,21.5
    expect(parsed.get(2)).toBe(4.17);
    expect(parsed.get(10)).toBe(6.81);
    expect(parsed.get(25)).toBe(8.81);
    expect(parsed.get(100)).toBe(12.6);
    expect(parsed.get(500)).toBe(18.5);
    expect([...parsed.keys()]).toEqual([...PFDS_RETURN_PERIOD_COLUMNS]);
  });

  it("THE LOAD-BEARING ONE: the depth VARIES WITH LOCATION — two real payloads, two real depths", () => {
    const bastrop = parsePfdsDepthTable(BASTROP, { durationHours: 24, expectLatLng: BASTROP_LATLNG });
    const elPaso = parsePfdsDepthTable(EL_PASO, {
      durationHours: 24,
      expectLatLng: { lat: 31.7619, lng: -106.485 },
    });
    expect(bastrop.get(100)).toBe(12.6);
    expect(elPaso.get(100)).toBe(4.7);
    expect(bastrop.get(100)).not.toBe(elPaso.get(100));
    // And neither is the regional default the pre-fix code served for both.
    expect(bastrop.get(100)).not.toBe(9.5);
    expect(elPaso.get(100)).not.toBe(9.5);
  });

  it("reads a duration other than 24-hr off the same unlabeled matrix (12-hr row index 8)", () => {
    const parsed = parsePfdsDepthTable(BASTROP, {
      durationHours: 12,
      expectLatLng: BASTROP_LATLNG,
    });
    // labeled cross-check: 12-hr:, 2.87,3.68,4.84,5.94,7.60,9.02,10.6,12.5,15.4,17.9
    expect(parsed.get(100)).toBe(10.6);
    expect(parsed.get(2)).toBe(3.68);
  });

  it("covers all 19 published durations and 10 return-period columns", () => {
    expect(PFDS_DURATION_ROWS).toHaveLength(19);
    expect(PFDS_RETURN_PERIOD_COLUMNS).toHaveLength(10);
    expect(PFDS_DURATION_ROWS[9]!.label).toBe("24-hr");
    expect(PFDS_DURATION_ROWS[9]!.minutes).toBe(1440);
  });

  // ── Refusal: the retired fixture and every perturbation of the live one ───

  it("REFUSES the retired `<tr><td>` HTML fixture — the fixture that used to be the whole test", () => {
    const refusal = refusalFrom(() => parsePfdsDepthTable(RETIRED_HTML_TABLE));
    expect(refusal.code).toBe("result_missing");
    expect(refusal.message).toContain("not a PFDS response");
  });

  it("REFUSES a point NOAA does not cover, and marks it as a principled absence rather than a parse failure", () => {
    const refusal = refusalFrom(() => parsePfdsDepthTable(OUTSIDE_ATLAS14));
    expect(refusal.code).toBe("result_not_values");
    expect(refusal.notCovered).toBe(true);
    expect(refusal.errorMsg).toContain("not within a project area");
  });

  it("REFUSES when the quantiles assignment is absent", () => {
    const stripped = BASTROP.replace(/quantiles = \[\[.*?\]\];/s, "");
    expect(refusalFrom(() => parsePfdsDepthTable(stripped)).code).toBe("quantiles_missing");
  });

  it("REFUSES a matrix with the wrong number of duration rows (a dropped 24-hr row must never be served as 2-day)", () => {
    const dropped = withMutatedQuantiles(BASTROP, (rows) => rows.filter((_, i) => i !== 9));
    const refusal = refusalFrom(() => parsePfdsDepthTable(dropped));
    expect(refusal.code).toBe("matrix_shape");
    expect(refusal.detail).toContain("18 duration rows");
  });

  it("REFUSES rows swapped between 12-hr and 24-hr — same length, same values, wrong duration", () => {
    const swapped = withMutatedQuantiles(BASTROP, (rows) => {
      const a = rows[8]!;
      const b = rows[9]!;
      rows[8] = b;
      rows[9] = a;
      return rows;
    });
    const refusal = refusalFrom(() => parsePfdsDepthTable(swapped, { durationHours: 24 }));
    expect(refusal.code).toBe("duration_not_increasing");
    // The pre-G-165 parser would have silently served the 12-hr numbers as 24-hr.
    expect(refusal.detail).toContain("24-hr");
  });

  it("REFUSES a row whose depth falls as the return period rises", () => {
    const reversed = withMutatedQuantiles(BASTROP, (rows) => {
      rows[9] = [...rows[9]!].reverse();
      return rows;
    });
    expect(refusalFrom(() => parsePfdsDepthTable(reversed)).code).toBe(
      "return_period_not_increasing",
    );
  });

  it("REFUSES when a semantic echo disagrees: unit, datatype, series, type", () => {
    expect(
      refusalFrom(() => parsePfdsDepthTable(BASTROP.replace("unit = 'english'", "unit = 'metric'")))
        .code,
    ).toBe("echo_mismatch");
    expect(
      refusalFrom(() =>
        parsePfdsDepthTable(BASTROP.replace("datatype = 'depth'", "datatype = 'intensity'")),
      ).code,
    ).toBe("echo_mismatch");
    expect(
      refusalFrom(() => parsePfdsDepthTable(BASTROP.replace("ser = 'pds'", "ser = 'ams'"))).code,
    ).toBe("echo_mismatch");
    expect(
      refusalFrom(() => parsePfdsDepthTable(BASTROP.replace("type = 'pf'", "type = 'ams'"))).code,
    ).toBe("echo_mismatch");
  });

  it("REFUSES a payload for a different point than the one asked for", () => {
    const refusal = refusalFrom(() =>
      parsePfdsDepthTable(BASTROP, { expectLatLng: { lat: 31.7619, lng: -106.485 } }),
    );
    expect(refusal.code).toBe("location_mismatch");
  });

  it("REFUSES a truncated body rather than returning a partial matrix", () => {
    const truncated = BASTROP.slice(0, Math.floor(BASTROP.length / 2));
    // Which code fires depends on where the cut lands (the echo block sits
    // AFTER the matrix, so half a body loses the semantics before it loses the
    // matrix). What matters is that a partial payload can never yield a value.
    const refusal = refusalFrom(() => parsePfdsDepthTable(truncated));
    expect([
      "quantiles_malformed",
      "echo_missing",
      "result_missing",
      "matrix_shape",
    ]).toContain(refusal.code);
  });

  it("REFUSES an empty payload and a whitespace-only payload", () => {
    expect(refusalFrom(() => parsePfdsDepthTable("")).code).toBe("result_missing");
    expect(refusalFrom(() => parsePfdsDepthTable("   \n  ")).code).toBe("result_missing");
  });

  it("REFUSES an unsupported duration instead of silently returning the 24-hr row", () => {
    const refusal = refusalFrom(() => parsePfdsDepthTable(BASTROP, { durationHours: 5 }));
    expect(refusal.code).toBe("unsupported_duration");
  });

  it("the CONTROL: a whitespace-only reformat still parses — refusal is not indiscriminate", () => {
    const reformatted = BASTROP.replace(/,\s*/g, ", ").replace(/;\n/g, ";\n\n");
    expect(reformatted).not.toBe(BASTROP);
    const parsed = parsePfdsDepthTable(reformatted, { durationHours: 24 });
    expect(parsed.get(100)).toBe(12.6);
  });

  // ── Counting ─────────────────────────────────────────────────────────────

  it("COUNTS every refusal, by code, from the single increment site", () => {
    expect(pfdsRefusalTally().total).toBe(0);
    refusalFrom(() => parsePfdsDepthTable(RETIRED_HTML_TABLE));
    refusalFrom(() => parsePfdsDepthTable(OUTSIDE_ATLAS14));
    refusalFrom(() => parsePfdsDepthTable(OUTSIDE_ATLAS14));
    refusalFrom(() => parsePfdsDepthTable(BASTROP, { durationHours: 5 }));
    const tally = pfdsRefusalTally();
    expect(tally.total).toBe(4);
    expect(tally.byCode.result_missing).toBe(1);
    expect(tally.byCode.result_not_values).toBe(2);
    expect(tally.byCode.unsupported_duration).toBe(1);
    // A successful parse does not touch the tally.
    parsePfdsDepthTable(BASTROP, { durationHours: 24 });
    expect(pfdsRefusalTally().total).toBe(4);
  });
});
