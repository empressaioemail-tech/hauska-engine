/**
 * P-154 (OPS-23 wave 3) — live field-list check for the Bastrop layer-23 /
 * layer-83 URLs and outFields this adapter depends on.
 *
 * Mission item 4: "Both are the kind of read that returns empty and passes;
 * add the test that fails if the field list and the service disagree."
 * Verified live 2026-09-12: BOTH bugs were worse than "reads empty" —
 * `Parcels_One_Click/FeatureServer/83` doesn't exist (400, layer not
 * found), and requesting `Ordinance_Link` in `outFields` against layer 23
 * makes ArcGIS reject the WHOLE query (400 "'outFields' parameter is
 * invalid"), not just omit the one field. A mocked-fetch unit test cannot
 * catch either failure mode — it would happily mock whatever shape the
 * code expects. This test hits the real public ArcGIS endpoints (no
 * privileged relationship required — same principle as every other adapter
 * in this package) and fails if the service's OWN field list or layer
 * topology ever disagrees with what this adapter reads or requests again.
 *
 * Network-dependent by design. On a genuine network failure (not a field
 * mismatch) this test SKIPS with a loud console warning rather than
 * failing the build on a transient connectivity issue — but a live 400, a
 * missing field, or a URL that stops resolving to layer 83 is a real
 * failure and must fail the suite.
 */
import { describe, expect, it } from "vitest";

import {
  BASTROP_LAYER_83_REVISIONS_URL,
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
} from "../local/setbacks/bastrop-per-parcel-record.js";

/** The exact outFields list `fetchBastropPerParcelSetbackRecord` sends live. */
const LIVE_OUT_FIELDS =
  "prop_id,ZoneTypeClass,FrontSetback_,FrontSetback,SideSetback_,SideSetback,RearSetback_,RearSetback,MaxBuildingHt,MinimumLotSize_,MaxImpervisionCoverage,Ordinance_,Shape__Area";

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let networkReachable = true;

describe("Bastrop layer 23 / layer 83 — live field-list check (network required)", () => {
  it("layer 23 (Parcels_One_Click/FeatureServer/23) carries `Ordinance_`, not `Ordinance_Link`", async () => {
    let meta: unknown;
    try {
      meta = await getJson(`${BASTROP_PARCELS_ONE_CLICK_LAYER_23}?f=json`);
    } catch (err) {
      networkReachable = false;
      console.warn(
        `[SKIP: no network] Could not reach layer 23 metadata endpoint: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const fields = ((meta as { fields?: Array<{ name?: string }> }).fields ?? []).map((f) => f.name);
    expect(fields).toContain("Ordinance_");
    expect(fields).not.toContain("Ordinance_Link");
    expect(fields).not.toContain("OrdinanceLink");
  });

  it("the live outFields string this adapter sends does not 400 against layer 23", async () => {
    if (!networkReachable) return;
    const url = new URL(`${BASTROP_PARCELS_ONE_CLICK_LAYER_23}/query`);
    url.searchParams.set("where", "prop_id=34049");
    url.searchParams.set("outFields", LIVE_OUT_FIELDS);
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("f", "json");
    let json: unknown;
    try {
      json = await getJson(url.toString());
    } catch (err) {
      console.warn(`[SKIP: no network] ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const errorEnv = (json as { error?: { message?: string; details?: string[] } }).error;
    expect(errorEnv, `ArcGIS rejected outFields: ${JSON.stringify(errorEnv)}`).toBeUndefined();
    expect(Array.isArray((json as { features?: unknown }).features)).toBe(true);
  });

  it("BASTROP_LAYER_83_REVISIONS_URL resolves to the real layer 83 (Zoned_Parcels_Revisions_Clip), not a 'layer not found'", async () => {
    if (!networkReachable) return;
    let meta: unknown;
    try {
      meta = await getJson(`${BASTROP_LAYER_83_REVISIONS_URL}?f=json`);
    } catch (err) {
      console.warn(`[SKIP: no network] ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const errorEnv = (meta as { error?: { message?: string; details?: string[] } }).error;
    expect(errorEnv, `layer 83 URL is dead: ${JSON.stringify(errorEnv)}`).toBeUndefined();
    expect((meta as { id?: number }).id).toBe(83);
    expect((meta as { name?: string }).name).toBe("Zoned_Parcels_Revisions_Clip");
  });
});
