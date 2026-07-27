/**
 * Pack-level probes with mocked fetch — AGOL zero alerts; dead-expected quiet.
 */

import { describe, expect, it, vi } from "vitest";

import { SEED_BASELINES } from "../spine-health/baselines.js";
import {
  probeBastropZoningDeadExpected,
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
});
