/**
 * G-165: the `/rainfall-forcing` path used to invent a depth.
 *
 * `resolveRainfallForcing` read `match?.depthInches ?? 4` and published the 4
 * under `kind: "noaa-atlas-14"`, and `services/engine-api/src/routes/hydrology.ts`
 * classifies anything other than `noaa-atlas-14` as degraded — so the invented
 * number was served as a NOAA Atlas 14 value AND reported at okCoverage.
 * Measured pre-fix (2026-09-18, live endpoint, Bastrop and El Paso):
 * `{ kind: "noaa-atlas-14", depthInches: 4, designStormCount: 0 }` for both.
 *
 * These tests pin that there is now no number to publish unless the parser
 * produced one.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach } from "vitest";

import { PfdsRefusal, resetPfdsRefusalTally } from "../noaaAtlas14.js";
import { resolveRainfallForcing } from "../rainfallForcing.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");

const BASTROP = fixture("pfds-bastrop-tx-2026-09-18.pfds.txt");
const OUTSIDE_ATLAS14 = fixture("pfds-uncovered-outside-atlas14-2026-09-18.pfds.txt");

const BASTROP_POINT = { lat: 30.1105, lng: -97.3169 };

const stubFetch = (body: string, status = 200): typeof fetch =>
  (async () =>
    new Response(body, { status, headers: { "content-type": "text/html" } })) as typeof fetch;

const refusalFrom = async (fn: () => Promise<unknown>): Promise<PfdsRefusal> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PfdsRefusal) return err;
    throw err;
  }
  throw new Error("expected a PfdsRefusal, but nothing was thrown");
};

describe("resolveRainfallForcing (G-165)", () => {
  beforeEach(() => resetPfdsRefusalTally());

  it("serves the PARSED 100-yr 24-hr depth for the point, under the noaa-atlas-14 kind", async () => {
    const result = await resolveRainfallForcing({
      ...BASTROP_POINT,
      fetchImpl: stubFetch(BASTROP),
    });
    expect(result.kind).toBe("noaa-atlas-14");
    expect(result.depthInches).toBe(12.6);
    expect(result.returnPeriodYears).toBe(100);
    if (result.kind !== "noaa-atlas-14") throw new Error("unreachable");
    expect(result.estimate.designStorms).toHaveLength(5);
    expect(result.estimate.designStorms.map((d) => d.depthInches)).toEqual([
      4.17, 6.81, 8.81, 12.6, 18.5,
    ]);
  });

  it("the legacy 4-inch fallback is GONE: an unusable payload REFUSES instead of inventing a depth", async () => {
    for (const body of [
      OUTSIDE_ATLAS14,
      "<table><tr><td>100</td><td>6.2</td></tr></table>",
      "",
      "{ truncated",
    ]) {
      const refusal = await refusalFrom(() =>
        resolveRainfallForcing({ ...BASTROP_POINT, fetchImpl: stubFetch(body) }),
      );
      expect(refusal.code).not.toBe("estimate_empty");
    }
  });

  it("names an uncovered point as a principled absence (notCovered), not an instrument failure", async () => {
    const refusal = await refusalFrom(() =>
      resolveRainfallForcing({ ...BASTROP_POINT, fetchImpl: stubFetch(OUTSIDE_ATLAS14) }),
    );
    expect(refusal.notCovered).toBe(true);
    expect(refusal.code).toBe("result_not_values");
  });

  it("refuses on a non-200 with the status named", async () => {
    const refusal = await refusalFrom(() =>
      resolveRainfallForcing({ ...BASTROP_POINT, fetchImpl: stubFetch(BASTROP, 503) }),
    );
    expect(refusal.code).toBe("http_status");
    expect(refusal.detail).toContain("503");
  });

  it("refuses on a dead transport with the cause named", async () => {
    const dead = (async () => {
      throw new Error("getaddrinfo ENOTFOUND hdsc.nws.noaa.gov");
    }) as unknown as typeof fetch;
    const refusal = await refusalFrom(() =>
      resolveRainfallForcing({ ...BASTROP_POINT, fetchImpl: dead }),
    );
    expect(refusal.code).toBe("transport_error");
    expect(refusal.detail).toContain("ENOTFOUND");
  });

  it("a manual override still wins and needs no fetch at all", async () => {
    const exploding = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const result = await resolveRainfallForcing({
      ...BASTROP_POINT,
      manualDepthInches: 4,
      fetchImpl: exploding,
    });
    expect(result.kind).toBe("manual");
    expect(result.depthInches).toBe(4);
  });
});
