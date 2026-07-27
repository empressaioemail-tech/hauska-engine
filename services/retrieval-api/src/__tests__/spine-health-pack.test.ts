/**
 * Pack-level probes with mocked fetch — AGOL zero alerts; dead-expected quiet.
 * QA4: osm-overpass 504 + county roadway → degraded-covered (not red alert).
 */

import { describe, expect, it, vi } from "vitest";

import { SEED_BASELINES } from "../spine-health/baselines.js";
import {
  probeBastropZoningDeadExpected,
  probeOsmOverpass,
  probeZoningAgol,
} from "../spine-health/probes.js";

describe("spine-health pack probes (mocked)", () => {
  it("raises alert when AGOL zoning count returns 0 against baseline", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await probeZoningAgol({
      substrateSql: null,
      overlaySql: null,
      storage: null,
      fetchImpl,
      baselines: {
        "zoning-agol:bastrop-city-tx":
          SEED_BASELINES["zoning-agol:bastrop-city-tx"],
      },
    });

    expect(result.probeId).toBe("zoning-agol:bastrop-city-tx");
    expect(result.currentValue).toBe(0);
    expect(result.baselineValue).toBe(574);
    expect(result.status).toBe("dead");
    expect(result.alert).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("labels bastrop-tx:zoning as dead-expected with no alert", async () => {
    const result = await probeBastropZoningDeadExpected({
      substrateSql: null,
      overlaySql: null,
      storage: null,
    });

    expect(result.probeId).toBe("bastrop-tx:zoning");
    expect(result.status).toBe("dead-expected");
    expect(result.alert).toBe(false);
    expect(result.signal.replacement).toBe("zoning-agol:bastrop-city-tx");
  });

  it("QA4: overpass 504 + county roadway → degraded-covered, alert=false", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return new Response("gateway timeout", { status: 504 });
      }
      if (url.includes("Bastrop_County_Roadway")) {
        return new Response(JSON.stringify({ count: 11_351 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("StreetsSurveyed2016")) {
        return new Response(JSON.stringify({ count: 1_307 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await probeOsmOverpass({
      substrateSql: null,
      overlaySql: null,
      storage: null,
      fetchImpl,
      baselines: { "osm-overpass": SEED_BASELINES["osm-overpass"] },
    });

    expect(result.probeId).toBe("osm-overpass");
    expect(result.status).toBe("degraded-covered");
    expect(result.alert).toBe(false);
    expect(result.signal.coverageMode).toBe("degraded-covered");
    expect(result.signal.message).toBe("overpass down, fallback active");
    expect(result.error).toMatch(/504/);
  });

  it("QA4: overpass 504 + NO fallback → dead + alert=true", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return new Response("gateway timeout", { status: 504 });
      }
      // County sources absent / empty
      return new Response(JSON.stringify({ count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probeOsmOverpass({
      substrateSql: null,
      overlaySql: null,
      storage: null,
      fetchImpl,
      baselines: { "osm-overpass": SEED_BASELINES["osm-overpass"] },
    });

    expect(result.probeId).toBe("osm-overpass");
    expect(result.status).toBe("dead");
    expect(result.alert).toBe(true);
    expect(result.signal.coverageMode).toBe("degraded-no-source");
  });
});
