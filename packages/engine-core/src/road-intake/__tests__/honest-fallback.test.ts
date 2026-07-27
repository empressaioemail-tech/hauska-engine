/**
 * QA4 — honest overpass fallback mechanical gates.
 * Must go RED on pre-fix code (silent zero / bare dead-alert).
 */

import { describe, expect, it } from "vitest";

import {
  coverageEmitsRoads,
  overpassProbeCoverageMode,
  resolveHonestRoadCoverage,
} from "../honest-fallback.js";
import {
  fetchOverpassRoadsInBbox,
  fetchOverpassRoadsInBboxOutcome,
  BASTROP_CITY_BBOX,
  OVERPASS_MAX_ATTEMPTS,
} from "../fetch-overpass-bbox.js";
import { resolveBastropRoadsHonest } from "../resolve-bastrop-roads-honest.js";
import {
  emitCountyRoadwayRoadNode,
  parseBastropRoadwayFeature,
  bastropCountyRoadwayDescriptor,
} from "../emit-county-roadway-node.js";

describe("resolveHonestRoadCoverage (QA4)", () => {
  it("504 + county roadway present → degraded-covered, roads still emitable, no alert", () => {
    const coverage = resolveHonestRoadCoverage(
      {
        ok: false,
        error: "Overpass HTTP 504: Gateway Timeout after 3 attempts",
        attempts: 3,
        statusCode: 504,
        elapsedMs: 1200,
      },
      { countyRoadwayCount: 11_351, streetsSurveyedCount: 1_307 },
    );

    expect(coverage.kind).toBe("degraded-covered");
    expect(coverage.alert).toBe(false);
    expect(coverage.message).toBe("overpass down, fallback active");
    expect(coverageEmitsRoads(coverage)).toBe(true);
    expect(overpassProbeCoverageMode(coverage)).toBe("degraded-covered");
    if (coverage.kind === "degraded-covered") {
      expect(coverage.fallbackActive).toContain("county-roadway");
      expect(coverage.fallbackRoadCount).toBe(11_351 + 1_307);
    }
  });

  it("504 + NO road source → degraded-no-source + alert (never silent zero)", () => {
    const coverage = resolveHonestRoadCoverage(
      {
        ok: false,
        error: "Overpass HTTP 504: Gateway Timeout after 3 attempts",
        attempts: 3,
        statusCode: 504,
        elapsedMs: 900,
      },
      { countyRoadwayCount: 0, streetsSurveyedCount: 0 },
    );

    expect(coverage.kind).toBe("degraded-no-source");
    expect(coverage.alert).toBe(true);
    expect(coverage.message).toBe(
      "roads unavailable this run: overpass down, no county roadway source",
    );
    expect(coverageEmitsRoads(coverage)).toBe(false);
    expect(coverage.elements).toEqual([]);
    expect(overpassProbeCoverageMode(coverage)).toBe("degraded-no-source");
  });

  it("overpass ok with ways → overpass-ok", () => {
    const coverage = resolveHonestRoadCoverage(
      {
        ok: true,
        elements: [
          {
            type: "way",
            id: 1,
            tags: { highway: "residential" },
            geometry: [
              { lat: 30.11, lon: -97.32 },
              { lat: 30.1105, lon: -97.3195 },
            ],
          },
        ],
        attempts: 1,
        elapsedMs: 50,
      },
      { countyRoadwayCount: 0, streetsSurveyedCount: 0 },
    );
    expect(coverage.kind).toBe("overpass-ok");
    expect(coverageEmitsRoads(coverage)).toBe(true);
  });

  it("overpass ok zero + no county → genuine-empty (distinguishable from outage)", () => {
    const coverage = resolveHonestRoadCoverage(
      { ok: true, elements: [], attempts: 1, elapsedMs: 40 },
      { countyRoadwayCount: 0, streetsSurveyedCount: 0 },
    );
    expect(coverage.kind).toBe("genuine-empty");
    expect(coverage.alert).toBe(false);
    expect(coverage.message).toMatch(/no roads observed/);
  });
});

describe("fetchOverpassRoadsInBbox retry (QA4)", () => {
  it("retries transient 504 then succeeds", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, status: 504, statusText: "Gateway Timeout" } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          elements: [
            {
              type: "way",
              id: 99,
              tags: { highway: "residential" },
              geometry: [
                { lat: 30.11, lon: -97.32 },
                { lat: 30.1105, lon: -97.3195 },
              ],
            },
          ],
        }),
      } as Response;
    };

    const result = await fetchOverpassRoadsInBbox(BASTROP_CITY_BBOX, fetchImpl, {
      maxAttempts: OVERPASS_MAX_ATTEMPTS,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(calls).toBe(3);
    expect(sleepCalls.length).toBe(2);
    expect(result.elements.length).toBe(1);
    expect(result.attempts).toBe(3);
  });

  it("returns outcome (not throw) after exhausting 504 retries", async () => {
    const fetchImpl = async () =>
      ({ ok: false, status: 504, statusText: "Gateway Timeout" }) as Response;

    const outcome = await fetchOverpassRoadsInBboxOutcome(BASTROP_CITY_BBOX, {
      fetchImpl,
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleepImpl: async () => {},
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.statusCode).toBe(504);
      expect(outcome.attempts).toBe(2);
      expect(outcome.error).toMatch(/504/);
    }
  });
});

describe("resolveBastropRoadsHonest orchestration (QA4)", () => {
  it("mock 504 + county WITH roadway → degraded-covered and emits county road node", async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("overpass")) {
        return { ok: false, status: 504, statusText: "Gateway Timeout" } as Response;
      }
      // ArcGIS count probes
      if (url.includes("Bastrop_County_Roadway") && url.includes("returnCountOnly")) {
        return {
          ok: true,
          json: async () => ({ count: 11_351 }),
        } as Response;
      }
      if (url.includes("StreetsSurveyed2016") && url.includes("returnCountOnly")) {
        return {
          ok: true,
          json: async () => ({ count: 1_307 }),
        } as Response;
      }
      return { ok: false, status: 404, statusText: "not found" } as Response;
    };

    const { coverage, fallback } = await resolveBastropRoadsHonest({
      fetchImpl: fetchImpl as typeof fetch,
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleepImpl: async () => {},
      env: {},
    });

    expect(coverage.kind).toBe("degraded-covered");
    expect(coverage.alert).toBe(false);
    expect(fallback.countyRoadwayCount).toBe(11_351);
    expect(coverageEmitsRoads(coverage)).toBe(true);

    // Roads still emitted from county-roadway fallback (mechanical emit).
    const obs = parseBastropRoadwayFeature(
      {
        objectId: 42,
        attributes: {
          class: "LS",
          surface: "Asphalt",
          rdcls_typ: "Local",
          owner: "City",
          full_name: "Fallback Ln",
        },
        centerline: [
          [-97.32, 30.11],
          [-97.319, 30.111],
        ],
      },
      "2026-07-27T12:00:00.000Z",
    );
    expect(obs).not.toBeNull();
    const atom = emitCountyRoadwayRoadNode(
      bastropCountyRoadwayDescriptor(),
      obs!,
    );
    expect(atom.roadNodeId).toContain("48021");
    expect(atom.row.provenance.kind).toMatch(/county-roadway/);
  });

  it("mock 504 + NO road source → honest degraded-no-source + alert", async () => {
    const { coverage } = await resolveBastropRoadsHonest({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 504,
          statusText: "Gateway Timeout",
        }) as Response) as typeof fetch,
      fallbackPresence: { countyRoadwayCount: 0, streetsSurveyedCount: 0 },
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
      sleepImpl: async () => {},
      env: {},
    });

    expect(coverage.kind).toBe("degraded-no-source");
    expect(coverage.alert).toBe(true);
    expect(coverage.message).toMatch(/no county roadway source/);
    expect(coverageEmitsRoads(coverage)).toBe(false);
  });
});
