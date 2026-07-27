/**
 * M0 — mocked zero-vs-baseline must raise alert (COMPLETE-BASTROP B1 / WDLL 7).
 */

import { describe, expect, it } from "vitest";

import { deriveProbeStatus } from "../spine-health/derive-status.js";
import { SEED_BASELINES } from "../spine-health/baselines.js";

describe("spine-health deriveProbeStatus (M0 alert path)", () => {
  it("alerts dead when current is zero and baseline > 0", () => {
    const result = deriveProbeStatus({
      baseline: SEED_BASELINES["zoning-agol:bastrop-city-tx"],
      current: 0,
    });
    expect(result.status).toBe("dead");
    expect(result.alert).toBe(true);
  });

  it("alerts dead when errored and baseline > 0", () => {
    const result = deriveProbeStatus({
      baseline: SEED_BASELINES["depth-warm"],
      current: null,
      errored: true,
    });
    expect(result.status).toBe("dead");
    expect(result.alert).toBe(true);
  });

  it("does not alert on expectedDead even when current is zero", () => {
    const result = deriveProbeStatus({
      expectedDead: true,
      baseline: 0,
      current: 0,
    });
    expect(result.status).toBe("dead-expected");
    expect(result.alert).toBe(false);
  });

  it("marks degraded+alert when below degrade fraction of baseline", () => {
    const result = deriveProbeStatus({
      baseline: 1000,
      current: 500,
      degradeFraction: 0.8,
    });
    expect(result.status).toBe("degraded");
    expect(result.alert).toBe(true);
  });

  it("marks firing when current is healthy vs baseline", () => {
    const result = deriveProbeStatus({
      baseline: 574,
      current: 574,
    });
    expect(result.status).toBe("firing");
    expect(result.alert).toBe(false);
  });

  it("QA4: errored + fallbackCovered → degraded-covered, no alert", () => {
    const result = deriveProbeStatus({
      baseline: SEED_BASELINES["osm-overpass"],
      current: null,
      errored: true,
      fallbackCovered: true,
    });
    expect(result.status).toBe("degraded-covered");
    expect(result.alert).toBe(false);
  });

  it("QA4: errored without fallback → dead + alert", () => {
    const result = deriveProbeStatus({
      baseline: SEED_BASELINES["osm-overpass"],
      current: null,
      errored: true,
      fallbackCovered: false,
    });
    expect(result.status).toBe("dead");
    expect(result.alert).toBe(true);
  });
});
