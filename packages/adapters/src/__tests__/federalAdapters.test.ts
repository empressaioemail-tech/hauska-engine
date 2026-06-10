/**
 * Federal site-context adapters — DA-PI-2.
 *
 * Each adapter is exercised against a recorded fixture so the network
 * is never touched. The runner is invoked end-to-end so the gating,
 * timeout, and `AdapterRunError` translation paths are covered too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { femaNfhlAdapter } from "../federal/fema-nfhl";
import { usgsNedAdapter } from "../federal/usgs-ned";
import {
  epaEjscreenAdapter,
  EPA_EJSCREEN_DATASET_VERSION,
  EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS,
  EPA_EJSCREEN_PROVIDER_LABEL,
} from "../federal/epa-ejscreen";
import {
  fccBroadbandAdapter,
  __resetFccInMemCacheForTests,
} from "../federal/fcc-broadband";
import { runAdapters } from "../runner";
import {
  arcgisEmpty,
  jsonResponse,
} from "../__fixtures__/arcgisFixtures";
import {
  epqsElevationFeet,
  epqsNoData,
  epqsStringValue,
  ejscreenBlockGroup,
  ejscreenEmpty,
  fccBroadbandFeatures,
  femaNfhlFeature,
} from "../__fixtures__/federalFixtures";
import type { AdapterContext } from "../types";
import { SLOW_UPSTREAM_TIMEOUT_MS } from "../timeouts";

const moab: AdapterContext = {
  parcel: { latitude: 38.5733, longitude: -109.5498 },
  jurisdiction: { stateKey: "utah", localKey: "grand-county-ut" },
};
const bastrop: AdapterContext = {
  parcel: { latitude: 30.1105, longitude: -97.3186 },
  jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
};
const offPilot: AdapterContext = {
  parcel: { latitude: 40.0, longitude: -105.27 }, // Boulder, CO
  jurisdiction: { stateKey: null, localKey: null },
};
// PL-04: federal adapters now apply nationwide whenever lat/lng is
// finite, so the genuine negative case is "engagement has no
// geocode" — NaN coordinates short-circuit `appliesTo` to false.
const noGeocode: AdapterContext = {
  parcel: { latitude: NaN, longitude: NaN },
  jurisdiction: { stateKey: null, localKey: null },
};

describe("FEMA NFHL flood-zone adapter", () => {
  it("returns inSpecialFloodHazardArea=true with the FEMA flood zone for an in-floodplain parcel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(femaNfhlFeature));
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      inSpecialFloodHazardArea: boolean;
      floodZone: string | null;
    };
    expect(payload.kind).toBe("flood-zone");
    expect(payload.inSpecialFloodHazardArea).toBe(true);
    expect(payload.floodZone).toBe("AE");
    expect(outcomes[0].result?.tier).toBe("federal");
    expect(outcomes[0].result?.sourceKind).toBe("federal-adapter");
  });

  it("emits an out-of-floodplain row (rather than no-coverage) when the layer returns no features", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      inSpecialFloodHazardArea: boolean;
      floodZone: string | null;
    };
    expect(payload.inSpecialFloodHazardArea).toBe(false);
    expect(payload.floodZone).toBeNull();
    // The note attribution lets the briefing engine surface "no
    // floodplain risk" against a cited source rather than a blank.
    expect(outcomes[0].result?.note).toMatch(/Zone X/i);
  });

  it("runs for an off-pilot but geocoded engagement (PL-04: federal applies nationwide)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(femaNfhlFeature));
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...offPilot, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not run when the engagement has no geocode", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [femaNfhlAdapter],
      context: { ...noGeocode, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("getUpstreamFreshness (Task #227)", () => {
    /**
     * The FEMA NFHL freshness probe GETs the layer's MapServer
     * metadata (`?f=json`) and compares `editingInfo.lastEditDate`
     * (Unix epoch ms) against the cached row's write time.
     */
    const cachedAt = new Date("2026-04-30T00:00:00.000Z");

    it("returns `fresh` when FEMA's lastEditDate is older than the cached row", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          editingInfo: {
            // Edited 10 days before the cache row was written.
            lastEditDate: cachedAt.getTime() - 10 * 86_400_000,
          },
        }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("fresh");
      expect(fetchImpl).toHaveBeenCalledOnce();
      // The probe hits the layer's metadata endpoint (no `/query`).
      expect(fetchImpl.mock.calls[0][0]).toMatch(/MapServer\/28\?f=json$/);
    });

    it("returns `stale` when FEMA published a newer revision after the cache row was written", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          editingInfo: {
            // Edited 1 day after the cache row was written.
            lastEditDate: cachedAt.getTime() + 86_400_000,
          },
        }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("stale");
      expect(verdict.reason).toMatch(/FEMA published a NFHL revision/);
      // The reason includes both the upstream edit timestamp and
      // the cached row's write time so the FE tooltip can show
      // both without parsing the message back apart.
      expect(verdict.reason).toContain(cachedAt.toISOString());
    });

    it("returns `unknown` when the metadata endpoint responds with HTTP 5xx", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("oops", { status: 503 }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toMatch(/HTTP 503/);
    });

    it("treats a missing `editingInfo.lastEditDate` as `fresh` rather than unknown", async () => {
      // ArcGIS only stamps lastEditDate on layers that have been
      // edited at least once — absence means the layer has never
      // changed, which is the strongest possible "still fresh".
      const fetchImpl = vi.fn(async () => jsonResponse({}));
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("fresh");
    });

    it("returns `unknown` when `lastEditDate` is present but malformed (contract drift)", async () => {
      // If FEMA ever changes the shape (e.g. strings instead of epoch
      // numbers), we shouldn't silently call it "fresh" — that would
      // mask real upstream changes. Surface as `unknown` so the FE
      // pill stays neutral instead of falsely confident.
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ editingInfo: { lastEditDate: "2026-05-01" } }),
      );
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toMatch(/non-numeric lastEditDate/);
    });

    it("returns `unknown` when fetch throws (network error)", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ENOTFOUND hazards.fema.gov");
      });
      const verdict = await femaNfhlAdapter.getUpstreamFreshness!({
        ctx: { ...bastrop, fetchImpl },
        cachedAt,
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toContain("ENOTFOUND");
    });
  });
});

describe("USGS NED elevation adapter", () => {
  it("normalizes a numeric EPQS elevation into the payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsElevationFeet));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      elevationFeet: number | null;
      units: string;
    };
    expect(payload.kind).toBe("elevation-point");
    expect(payload.elevationFeet).toBeCloseTo(4032.7, 1);
    expect(payload.units).toBe("Feet");
    expect(outcomes[0].result?.tier).toBe("federal");
  });

  it("sends only the EPQS-supported query params (no wkid / includeDate)", async () => {
    // EPQS v1 rejects `wkid` / `includeDate` with HTTP 400.
    const fetchImpl = vi.fn(async () => jsonResponse(epqsElevationFeet));
    await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toMatch(/[?&]x=-109\.5498\b/);
    expect(calledUrl).toMatch(/[?&]y=38\.5733\b/);
    expect(calledUrl).toMatch(/[?&]units=Feet\b/);
    expect(calledUrl).toMatch(/[?&]output=json\b/);
    expect(calledUrl).not.toMatch(/[?&]wkid=/);
    expect(calledUrl).not.toMatch(/[?&]includeDate=/);
  });

  it("translates a deterministic HTTP 400 into an `upstream-error` failed outcome (no retry)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "invalid URL" }, 400),
    );
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy stringified `value` shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsStringValue));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      elevationFeet: number | null;
    };
    expect(payload.elevationFeet).toBeCloseTo(1284.5, 1);
  });

  it("normalizes the EPQS no-data sentinel to a null elevation with a note", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(epqsNoData));
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      elevationFeet: number | null;
    };
    expect(payload.elevationFeet).toBeNull();
    expect(outcomes[0].result?.note).toMatch(/no elevation/i);
  });

  it("translates an HTTP 5xx to an upstream-error failed outcome", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "boom" }, 503),
    );
    const outcomes = await runAdapters({
      adapters: [usgsNedAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
  });
});

describe("EPA EJScreen adapter (CalEPA mirror opt-in, 2026-05-23)", () => {
  it("emits the normalized block-group indicators alongside the raw attribute map", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      blockGroupId: string | null;
      stateName: string | null;
      population: number | null;
      demographicIndexPercentile: number | null;
      supplementalDemographicIndexPercentile: number | null;
      pm25Percentile: number | null;
      ozonePercentile: number | null;
      leadPaintPercentile: number | null;
      raw: Record<string, unknown>;
    };
    expect(payload.kind).toBe("ejscreen-blockgroup");
    // Values mirror the live Moab UT recon result (BG 490190002004)
    // recorded in 2026-05-23's QA-22 SCOPE A session note — schema
    // covers 5/5 indicators the old broker exposed plus the new
    // supplemental demographic-index variant.
    expect(payload.blockGroupId).toBe("490190002004");
    expect(payload.stateName).toBe("Utah");
    expect(payload.population).toBe(1179);
    expect(payload.demographicIndexPercentile).toBe(83);
    expect(payload.supplementalDemographicIndexPercentile).toBe(79);
    expect(payload.pm25Percentile).toBe(3);
    expect(payload.ozonePercentile).toBe(4);
    expect(payload.leadPaintPercentile).toBe(76);
    expect(payload.raw).toBeDefined();
  });

  it("targets the CalEPA EJSCREEN_2023_BG FeatureServer (NOT the decommissioned ejscreen.epa.gov broker)", async () => {
    // The dead-end ledger in `epa-ejscreen.ts` lists the decommissioned
    // broker as a known-bad URL; guard against any regression that
    // accidentally re-points the adapter at it.
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toContain("services2.arcgis.com");
    expect(calledUrl).toContain(
      "EJSCREEN_2023_BG_StatePct_with_AS_CNMI_GU_VI_gdb/FeatureServer/0",
    );
    expect(calledUrl).not.toContain("ejscreen.epa.gov");
    expect(calledUrl).not.toContain("ejscreenRESTbroker3.aspx");
  });

  it("sends an ArcGIS point-intersects query with the EJScreen 2023 outFields list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toMatch(/[?&]geometryType=esriGeometryPoint\b/);
    expect(calledUrl).toMatch(/[?&]spatialRel=esriSpatialRelIntersects\b/);
    expect(calledUrl).toMatch(/[?&]inSR=4326\b/);
    expect(calledUrl).toMatch(/[?&]returnGeometry=false\b/);
    // Every field the payload reads must be in the outFields list so
    // a typo doesn't silently drop one indicator from the briefing.
    expect(calledUrl).toContain("ID");
    expect(calledUrl).toContain("STATE_NAME");
    expect(calledUrl).toContain("ACSTOTPOP");
    expect(calledUrl).toContain("P_DEMOGIDX_2");
    expect(calledUrl).toContain("P_DEMOGIDX_5");
    expect(calledUrl).toContain("P_PM25");
    expect(calledUrl).toContain("P_OZONE");
    expect(calledUrl).toContain("P_LDPNT");
    // Geometry payload encodes the parcel's lat/lng in the WGS84 point
    // shape arcgisPointQuery builds.
    const geometryMatch = /[?&]geometry=([^&]+)/.exec(calledUrl);
    expect(geometryMatch).not.toBeNull();
    const geometry = JSON.parse(decodeURIComponent(geometryMatch![1]));
    expect(geometry.x).toBe(moab.parcel.longitude);
    expect(geometry.y).toBe(moab.parcel.latitude);
  });

  it("translates an empty features array to a no-coverage failed outcome", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenEmpty));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.code).toBe("no-coverage");
  });

  it("translates an ArcGIS error envelope into an upstream-error", async () => {
    // services2.arcgis.com surfaces in-band errors as
    // `{ error: { code, message } }` with HTTP 200 — the arcgisPointQuery
    // helper rejects that as upstream-error rather than letting it
    // round-trip as a "successful" empty response.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        error: { code: 400, message: "Invalid geometry" },
      }),
    );
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("upstream-error");
    expect(outcomes[0].error?.message).toMatch(/Invalid geometry/);
  });

  it("retries a transient HTTP 503 from the CalEPA mirror before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // ─── State-percentile disclosure (decision-record requirement #2) ────
  // The CalEPA mirror's `P_*` fields are state-distribution percentiles,
  // NOT US-distribution. The payload must carry an explicit basis flag
  // so the UI / chip / markdown digest can surface "state-pctile" and
  // not silently drift to the more-familiar US-percentile reading.
  it("stamps `percentileBasis: \"state\"` on the payload so the UI can disclose state-vs-US semantics", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    const payload = outcomes[0].result?.payload as {
      percentileBasis: unknown;
    };
    expect(payload.percentileBasis).toBe("state");
  });

  // ─── Source-attribution disclosure (decision-record requirement #1) ──
  // Provider field MUST NOT read just "EJScreen" — the federal-tier
  // promise on Redd softens via attribution, it does not silently
  // erase. Guard against any regression that strips the CalEPA-mirror
  // attribution from the persisted briefing-source row.
  it("attributes the source as the CalEPA mirror in the persisted provider field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].result?.provider).toBe(EPA_EJSCREEN_PROVIDER_LABEL);
    // Negative assertion: must not regress to the old broker-era
    // bare "EPA EJScreen" wording that hid the third-party hosting.
    expect(outcomes[0].result?.provider).not.toBe("EPA EJScreen");
    // Must mention both the third-party host and the EPA-retired
    // context so the reader can interpret the federal-tier softening.
    expect(outcomes[0].result?.provider).toMatch(/CalEPA mirror/);
    expect(outcomes[0].result?.provider).toMatch(/EPA EJScreen API retired/i);
  });

  // ─── Data-vintage disclosure (decision-record requirement #1 + #2) ───
  // The CalEPA mirror is a frozen 2023 snapshot, not a live feed.
  // Exposing the dataset version on the payload lets the UI surface
  // "what year of EJScreen this is" independently of the `snapshotDate`
  // timestamp (which measures fetch time, not data publication time).
  it("exposes the dataset version on the payload so the UI can render a data-vintage footer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ejscreenBlockGroup));
    const outcomes = await runAdapters({
      adapters: [epaEjscreenAdapter],
      context: { ...moab, fetchImpl },
    });
    const payload = outcomes[0].result?.payload as {
      upstreamDatasetVersion: unknown;
    };
    expect(payload.upstreamDatasetVersion).toBe(EPA_EJSCREEN_DATASET_VERSION);
    expect(payload.upstreamDatasetVersion).toMatch(/EJScreen 2023/);
    expect(payload.upstreamDatasetVersion).toMatch(/2024-01-29/);
  });

  // ─── Freshness threshold (decision-record requirement #3) ────────────
  it("carries the widened 24-month freshness threshold for the CalEPA mirror's frozen-snapshot cadence", () => {
    // 24 vs the old broker's 18 reflects the absence of a published
    // CalEPA refresh cadence — see the FRESHNESS THRESHOLD CHOICE
    // section in the adapter docstring for the rationale.
    expect(EPA_EJSCREEN_FRESHNESS_THRESHOLD_MONTHS).toBe(24);
  });
});

describe("FCC broadband adapter", () => {
  // QA-22 upstream-probe (2026-05-23) — the adapter holds a
  // module-scoped 15-minute in-memory cache to catch the
  // operator-reload-within-15min case. Tests share the same vitest
  // worker, all run against the same `moab` coordinates, and would
  // therefore see cache hits leaking across cases without an explicit
  // reset between each one.
  beforeEach(() => {
    __resetFccInMemCacheForTests();
  });

  it("rolls up provider rows into a fastest-tier summary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      providerCount: number;
      fastestDownstreamMbps: number | null;
      fastestUpstreamMbps: number | null;
      providers: Array<{ provider: string | null }>;
    };
    expect(payload.kind).toBe("broadband-availability");
    expect(payload.providerCount).toBe(2);
    expect(payload.fastestDownstreamMbps).toBe(1000);
    expect(payload.fastestUpstreamMbps).toBe(35);
    expect(payload.providers.map((p) => p.provider).sort()).toEqual([
      "FastNet",
      "RuralWisp",
    ]);
  });

  it("emits a zero-providers row (rather than no-coverage) when FCC has no deployment", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      providerCount: number;
      fastestDownstreamMbps: number | null;
    };
    expect(payload.providerCount).toBe(0);
    expect(payload.fastestDownstreamMbps).toBeNull();
    expect(outcomes[0].result?.note).toMatch(/no fixed-broadband/i);
  });

  it("hits the BDC v2 location/availability endpoint with lat+lng", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    const calledUrl = String(fetchImpl.mock.calls[0][0]);
    expect(calledUrl).toContain("broadbandmap.fcc.gov");
    expect(calledUrl).toContain("/published/location/availability");
    expect(calledUrl).toMatch(/[?&]lat=38\.5733\b/);
    expect(calledUrl).toMatch(/[?&]lng=-109\.5498\b/);
    // The old broken path produced `/feature/0/query`; guard against
    // any regression that brings it back.
    expect(calledUrl).not.toContain("/feature/0/query");
  });

  it("retries an FCC HTTP 502 once before succeeding on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ msg: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse(fccBroadbandFeatures));
    const outcomes = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // QA-22 upstream-probe — Per-adapter timeout floor was raised from
  // the shared `SLOW_UPSTREAM_TIMEOUT_MS` (45s) to a dedicated 90s
  // for `fcc:broadband` only, because the BDC v2 endpoint
  // legitimately answers slower than the shared floor from Cloud
  // Run egress (cortex-api-00020-85n pill: "did not respond in time
  // during attempt 1"). EPA / Grand County intentionally stay at the
  // shared floor because their failure modes are different (DNS,
  // TCP connect-timeout).
  it("carries the QA-22 upstream-probe 90s timeout floor (above SLOW_UPSTREAM_TIMEOUT_MS)", () => {
    expect(fccBroadbandAdapter.timeoutMs).toBe(90_000);
    expect(fccBroadbandAdapter.timeoutMs).toBeGreaterThan(
      SLOW_UPSTREAM_TIMEOUT_MS,
    );
  });

  // QA-22 upstream-probe — second call to the same parcel within
  // the 15-minute TTL must hit the module-scoped in-memory cache and
  // skip the outbound fetch entirely. This is the cache-key contract
  // (rounded lat/lng, matching CACHE_COORDINATE_PRECISION) that the
  // operator-reload case depends on; if the assertion drifts, the
  // operator-reload-within-15min path quietly stops working and
  // each Generate Layers re-run pays the full FCC 90s timeout again.
  it("second call within 15-min TTL hits the in-memory cache and skips the outbound fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    const first = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(first[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Second invocation at the same coordinates — cache hit, no
    // additional fetch. Result payload must equal the first call's
    // (modulo snapshotDate, which is re-stamped on every cache hit
    // so downstream freshness math sees "now" rather than the
    // cache-write timestamp).
    const second = await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(second[0].status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second[0].result?.payload).toEqual(first[0].result?.payload);
  });

  // QA-22 upstream-probe — slightly-different coordinates rounded to
  // the same `CACHE_COORDINATE_PRECISION` (5 d.p., ~1.1m at the
  // equator) must collapse to a cache hit; a geocoded parcel that
  // drifts a fraction of a meter between Generate Layers runs still
  // dedups.
  it("treats two coordinates that round to the same cache key as the same parcel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(fccBroadbandFeatures));
    await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: { ...moab, fetchImpl },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Move the parcel by 1e-7 degrees on each axis — well below the
    // 5-decimal-place rounding window, so the cache key is identical.
    const moabDrift: AdapterContext = {
      ...moab,
      parcel: {
        latitude: moab.parcel.latitude + 1e-7,
        longitude: moab.parcel.longitude - 1e-7,
      },
      fetchImpl,
    };
    await runAdapters({
      adapters: [fccBroadbandAdapter],
      context: moabDrift,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("federal adapter gating (PL-04)", () => {
  it("skips every federal adapter when the engagement has no geocode", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [
        femaNfhlAdapter,
        usgsNedAdapter,
        epaEjscreenAdapter,
        fccBroadbandAdapter,
      ],
      context: { ...noGeocode, fetchImpl },
    });
    expect(outcomes.every((o) => o.status === "no-coverage")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invokes every federal adapter for an off-pilot but geocoded engagement", async () => {
    // Each fetch returns the per-adapter shape the success path expects;
    // we only care that `appliesTo` accepted the off-pilot stateKey.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(femaNfhlFeature))
      .mockResolvedValueOnce(jsonResponse(epqsElevationFeet))
      .mockResolvedValueOnce(jsonResponse(ejscreenBlockGroup))
      .mockResolvedValueOnce(jsonResponse(fccBroadbandFeatures));
    const outcomes = await runAdapters({
      adapters: [
        femaNfhlAdapter,
        usgsNedAdapter,
        epaEjscreenAdapter,
        fccBroadbandAdapter,
      ],
      context: { ...offPilot, fetchImpl },
    });
    expect(outcomes.every((o) => o.status === "ok")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("QA-22 — slow-upstream per-adapter timeout floors", () => {
  // QA-22 upstream-probe (2026-05-23) — FCC was bumped off the
  // shared `SLOW_UPSTREAM_TIMEOUT_MS` to a dedicated 90s floor. See
  // the `carries the QA-22 upstream-probe 90s timeout floor` test in
  // the FCC describe block above for the rationale.
  it("FCC broadband carries a per-adapter floor strictly larger than SLOW_UPSTREAM_TIMEOUT_MS (QA-22 upstream-probe)", () => {
    expect(fccBroadbandAdapter.timeoutMs).toBeGreaterThan(
      SLOW_UPSTREAM_TIMEOUT_MS,
    );
  });

  // QA-22 SCOPE A opt-in (2026-05-23) — EPA EJScreen dropped its
  // SLOW_UPSTREAM_TIMEOUT_MS floor when the adapter swapped from the
  // (now decommissioned) ejscreen.epa.gov broker to the CalEPA
  // FeatureServer mirror. The mirror answers in ~300-600ms on the
  // recorded operator-workstation probe, well inside the runner
  // default; the wider budget would have been safety theater.
  it("the fast federal adapters (FEMA + USGS + EPA EJScreen) keep the runner default (no per-adapter floor)", () => {
    expect(femaNfhlAdapter.timeoutMs).toBeUndefined();
    expect(usgsNedAdapter.timeoutMs).toBeUndefined();
    expect(epaEjscreenAdapter.timeoutMs).toBeUndefined();
  });
});
