/**
 * P-154 (OPS-23 wave 4, share): the sixth live setback producer,
 * `buildBastropPerParcelSetbackDescriptor`, had no test locking in its
 * numeric output before or after the resolver's move to
 * `@empressaio/setback-corpus/resolve` (flagged, not built out, in the
 * wave-3 close's `contradicted` field). This test closes that gap: it
 * proves the descriptor this function builds for `48021:34049` carries the
 * SAME scalars `resolveMostCurrentSetback` (via `getSetbackTableForZoning`,
 * which this function calls at line ~75) would resolve directly from the
 * same two candidates — the codified Bastrop Development Code table
 * (effective 2026-04-14) versus the live layer-23 per-parcel row (citing
 * Ordinance 2019-51, year-precision) — under R-1 (most-current source
 * wins). Fixture is the same real, live-verified 2026-09-12 layer-23 row
 * used in `../../../adapters/src/local/setbacks/__tests__/bastrop-r1-integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { buildBastropPerParcelSetbackDescriptor } from "../bastrop-per-parcel-setback.js";
import type { JurisdictionDescriptor } from "../types.js";

/** Real layer-23 row for prop_id=34049, live-verified 2026-09-12 (same fixture as the adapters-side R-1 integration test). */
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchForRow(attrs: Record<string, unknown>): typeof fetch {
  return vi.fn(async () =>
    jsonResponse({ features: [{ attributes: attrs }] }),
  ) as unknown as typeof fetch;
}

const BASE_DESCRIPTOR: JurisdictionDescriptor = {
  key: "bastrop-development-code",
  displayName: "City of Bastrop, TX (test descriptor)",
  jurisdictionTenant: "bastrop-development-code",
  parcelFips: "48021",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "descriptor-fixture",
  sourceUrl: "https://example.invalid/bastrop-development-code-test",
};

describe("buildBastropPerParcelSetbackDescriptor — the sixth live producer, 48021:34049", () => {
  it("produces 30/10/30/20 (front/side/rear/corner), matching resolveMostCurrentSetback's own answer for the same two candidates under R-1", async () => {
    const fetchImpl = mockFetchForRow(LIVE_LAYER_23_ROW_34049);

    const result = await buildBastropPerParcelSetbackDescriptor(
      BASE_DESCRIPTOR,
      "48021:34049",
      "SF-1",
      "bastrop-development-code",
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.descriptor.setbackTable?.rows.find(
      (r) => r.district_code === "SF-1",
    );
    expect(row).toBeDefined();
    // This is exactly what getSetbackTableForZoning's Bastrop branch
    // resolves via resolveMostCurrentSetback for this same fixture in
    // bastrop-r1-integration.test.ts: the codified table (2026-04-14)
    // beats the per-parcel citation (2019, year-precision).
    expect(row!.front_ft?.value).toBe(30);
    expect(row!.side_ft?.value).toBe(10);
    expect(row!.rear_ft?.value).toBe(30);
    expect(row!.side_corner_ft?.value).toBe(20);
  });

  it("falsifier: if the per-parcel record's own 25/5/25/15 were returned instead, this producer would still be tier-first/record-first, not most-current — it is not", async () => {
    const fetchImpl = mockFetchForRow(LIVE_LAYER_23_ROW_34049);
    const result = await buildBastropPerParcelSetbackDescriptor(
      BASE_DESCRIPTOR,
      "48021:34049",
      "SF-1",
      "bastrop-development-code",
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.descriptor.setbackTable?.rows.find(
      (r) => r.district_code === "SF-1",
    );
    expect(row!.front_ft?.value).not.toBe(25);
    expect(row!.side_ft?.value).not.toBe(5);
  });
});
