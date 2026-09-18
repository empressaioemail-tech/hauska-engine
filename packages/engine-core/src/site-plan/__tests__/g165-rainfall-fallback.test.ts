/**
 * G-165: what the study path does when the live Atlas 14 read does not answer.
 *
 * The parser-level refusals are pinned in
 * `packages/adapters/src/hydrology/__tests__/noaaAtlas14.test.ts`. This file pins
 * the OTHER half of the acceptance clause: "any surviving fallback is named,
 * counted and marked on read rather than presented as a measured value."
 *
 * These tests drive the real `fetchNoaaAtlas14PointEstimate` (with its fetch
 * stubbed by a captured live payload) through the real `resolveStudyRainfall`,
 * so the refusal really travels the production seam rather than a hand-written
 * throw.
 */

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { fetchNoaaAtlas14PointEstimate, resetPfdsRefusalTally } from "@hauska-engine/adapters/hydrology";

import {
  DEFAULT_RAINFALL_DEPTH_INCHES,
  resolveStudyRainfall,
} from "../flood-drainage-study.js";

/**
 * The captured payloads live with the adapter that reads them; reaching across
 * the package boundary here is deliberate, so this test and the adapter's own
 * test grade the SAME bytes rather than two hand-maintained copies.
 */
const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../../../adapters/src/hydrology/__fixtures__/${name}`, import.meta.url),
    "utf8",
  );

const BASTROP = fixture("pfds-bastrop-tx-2026-09-18.pfds.txt");
const OUTSIDE_ATLAS14 = fixture("pfds-uncovered-outside-atlas14-2026-09-18.pfds.txt");
const RETIRED_HTML = "<table><tr><td>100</td><td>6.2</td></tr></table>";

const BASTROP_CENTROID = { lat: 30.1105, lng: -97.3169 };
const SEATTLE_CENTROID = { lat: 47.6062, lng: -122.3321 };

/** The real client, with only the wire stubbed. */
const clientServing = (body: string, status = 200) => {
  const fetchImpl = (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
  return (args: { lat: number; lng: number }) =>
    fetchNoaaAtlas14PointEstimate({ ...args, fetchImpl });
};

describe("G-165 study-path rainfall fallback is named, not silent", () => {
  it("a live payload makes the study read noaa-atlas14 with the PARSED depth and NO fallback block", async () => {
    resetPfdsRefusalTally();
    const resolved = await resolveStudyRainfall(
      BASTROP_CENTROID,
      undefined,
      clientServing(BASTROP),
    );
    expect(resolved.source).toBe("noaa-atlas14");
    expect(resolved.depthInches).toBe(12.6);
    expect(resolved.fallback).toBeUndefined();
    expect(resolved.curve?.find((c) => c.returnPeriodYears === 100)?.depthInches).toBe(12.6);
  });

  it("a point NOAA does not cover falls back to the default NAMED as a principled absence", async () => {
    resetPfdsRefusalTally();
    const resolved = await resolveStudyRainfall(
      SEATTLE_CENTROID,
      undefined,
      clientServing(OUTSIDE_ATLAS14),
    );
    expect(resolved.source).toBe("default");
    expect(resolved.depthInches).toBe(DEFAULT_RAINFALL_DEPTH_INCHES);
    expect(resolved.fallback?.reason).toBe("noaa-not-covered");
    expect(resolved.fallback?.errorMsg).toContain("not within a project area");
    // Honest-absent, never a fabricated curve.
    expect(resolved.curve).toBeUndefined();
  });

  it("a payload the parser cannot read falls back NAMED as a payload refusal, not as 'no data here'", async () => {
    resetPfdsRefusalTally();
    const resolved = await resolveStudyRainfall(
      BASTROP_CENTROID,
      undefined,
      clientServing(RETIRED_HTML),
    );
    expect(resolved.source).toBe("default");
    expect(resolved.fallback?.reason).toBe("noaa-payload-refused");
    expect(resolved.fallback?.detail).toContain("result_missing");
    expect(resolved.curve).toBeUndefined();
  });

  it("a dead transport falls back NAMED as unreachable", async () => {
    resetPfdsRefusalTally();
    const resolved = await resolveStudyRainfall(BASTROP_CENTROID, undefined, clientServing(BASTROP, 503));
    expect(resolved.fallback?.reason).toBe("noaa-unreachable");
    expect(resolved.fallback?.detail).toContain("503");
  });

  it("a non-Atlas failure the fetch seam surfaces is named as fetch-failed, never silently the default", async () => {
    resetPfdsRefusalTally();
    const boom = (async () => {
      throw new Error("test stub: no NOAA egress");
    }) as unknown as typeof fetchNoaaAtlas14PointEstimate;
    const resolved = await resolveStudyRainfall(BASTROP_CENTROID, undefined, boom);
    expect(resolved.source).toBe("default");
    expect(resolved.fallback?.reason).toBe("noaa-fetch-failed");
    // The raw cause stays on the fallback block; the study's own `detail` line
    // names the reason class, so a reader sees WHY without a stack trace.
    expect(resolved.fallback?.detail).toContain("no NOAA egress");
    expect(resolved.detail).toContain("noaa-fetch-failed");
  });

  it("a caller-supplied parameter still wins and carries no fallback block", async () => {
    resetPfdsRefusalTally();
    const resolved = await resolveStudyRainfall(
      BASTROP_CENTROID,
      6.25,
      clientServing(RETIRED_HTML),
    );
    expect(resolved.source).toBe("parameter");
    expect(resolved.depthInches).toBe(6.25);
    expect(resolved.fallback).toBeUndefined();
  });
});
