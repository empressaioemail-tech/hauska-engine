import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { authorParcelFeasibilityExport } from "../feasibility-author.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../../parcel-terrain/author.js";

/**
 * P-120 item 6, wiring half.
 *
 * `narrative-section-client.test.ts` proves the client is correct. It does
 * not prove the author CALLS it, nor that a failure actually lands on the
 * deterministic skeleton instead of an error. This file runs the real
 * `authorParcelFeasibilityExport` with only the network stubbed.
 *
 * A normal-sized parcel deliberately, so this is independent of the
 * narrow-parcel terrain-window fix in the same branch.
 *
 * WDLL item 6's check, verbatim: "A generated PDF for a real parcel carries
 * a cited, non-skeleton narrative; an LLM-unavailable fixture still emits the
 * complete skeleton, never an error."
 */

const bbox = { westLng: -97.3156, southLat: 30.1103, eastLng: -97.3151, northLat: 30.1107 };
const ringWgs84: Array<[number, number]> = [
  [-97.31555, 30.11035],
  [-97.31515, 30.11035],
  [-97.31515, 30.11065],
  [-97.31555, 30.11065],
  [-97.31555, 30.11035],
];

const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    120, 120.4, 120.8, 121, 119.8, 120.2, 120.6, 120.9, 119.5, 119.9, 120.3, 120.7, 119.2, 119.6,
    120, 120.4,
  ]),
  minElevation: 119.2,
  maxElevation: 121,
  nodataCount: 0,
};

const resolver: ParcelGeometryResolver = {
  async resolve() {
    return { bbox, sourceRef: "txgio-parcel:48021:47595:test", ring: ringWgs84 };
  },
};

function artifactStore(): TerrainArtifactStore {
  const data = new Map<string, Uint8Array>();
  return {
    async put(input) {
      const key = `memory://${input.parcelNodeId}/${input.format}/${data.size}`;
      data.set(key, input.bytes);
      return key;
    },
  };
}

const fetchDem = (async (bboxArg: any, opts: { resolutionMeters: number }) => ({
  bytes: new Uint8Array(0),
  contentType: "image/tiff",
  bbox: bboxArg,
  resolutionMeters: opts.resolutionMeters,
  resolutionMetersRequested: opts.resolutionMeters,
  resolutionMetersActual: null,
  widthPx: dem.width,
  heightPx: dem.height,
  endpoint: "https://fake.usgs.example/exportImage",
  fetchedAt: new Date().toISOString(),
})) as any;

function baseOptions() {
  return {
    parcelNodeId: "48021:47595",
    resolver,
    storage: new InMemoryStorage(),
    artifactStore: artifactStore(),
    fetchAerialImage: async () => {
      throw new Error("test stub: no aerial fetch");
    },
    fetchDem,
    parseDem: async () => dem,
    fetchFloodZone: async () => ({
      honestUnavailable: true as const,
      reason: "test stub",
    }),
  };
}

function narrativeFetch(body: unknown, ok = true) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return { ok, status: ok ? 200 : 502, json: async () => body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CITED_NARRATIVE = {
  narrative:
    "The parcel lies in Bastrop County [jurisdiction]. Terrain falls about two metres across the site [terrain].",
  generatedBy: "grok",
  generatedAt: "2026-09-07T19:00:00.000Z",
};

describe("Feasibility narrative wiring (P-120 item 6)", () => {
  it("with no config, the skeleton is DECLARED, not silent", async () => {
    // This test previously asserted `narrativeFallbackReason` was undefined
    // here, which pinned a real defect as a specification: with no config the
    // client was never called, so the report came back looking complete and
    // naming nothing. Caught by doc-repo-26 in review, not by this suite,
    // because the suite was asserting the bug. The value the system produced
    // was checked against itself instead of against the doctrine, which is
    // exactly the failure the enforcement rules name.
    const result = await authorParcelFeasibilityExport(baseOptions() as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);
    // The reason is now the SPECIFIC one. Generation moved in-process AND
    // became opt-in (63s measured, against PE's 55s whole-compose budget), so
    // an unrequested narrative reports "not-requested" rather than the older
    // "not-configured", which described a cross-repo endpoint that is no
    // longer the first path tried. What must not change is that SOME reason
    // is always named — that invariant has its own test below.
    expect(result.narrativeFallbackReason).toBe("not-requested");
    expect(result.pageCount).toBeGreaterThan(0);
  });

  it("NO PATH reaches the skeleton without saying why", async () => {
    // The general invariant, rather than one more instance of it. Whenever
    // the report falls back, something must name the cause.
    const cases: Array<Record<string, unknown>> = [
      {}, // unconfigured
      {
        narrativeSection: {
          baseUrl: "https://api.example/api/brokerage/v1",
          apiKey: "svc",
          fetchImpl: narrativeFetch({}, false).impl,
        },
      }, // configured but upstream failed
      {
        narrativeSection: {
          baseUrl: "https://api.example/api/brokerage/v1",
          apiKey: "svc",
          fetchImpl: narrativeFetch({
            narrative: "Fluent and uncited.",
            generatedBy: "grok",
            generatedAt: "2026-09-07T19:00:00.000Z",
          }).impl,
        },
      }, // configured, answered, refused for lack of citation
    ];
    for (const extra of cases) {
      const result = await authorParcelFeasibilityExport({
        ...baseOptions(),
        ...extra,
      } as any);
      expect(result.narrativeIsDeterministicSkeleton).toBe(true);
      expect(result.narrativeFallbackReason).toBeTruthy();
    }
  });

  it("a real generated narrative carries NO fallback reason", async () => {
    // Guards the guard: if a reason were emitted unconditionally the test
    // above would pass while meaning nothing.
    const f = narrativeFetch(CITED_NARRATIVE);
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(false);
    expect(result.narrativeFallbackReason).toBeUndefined();
  });

  it("WIRING: with config, the author actually calls the endpoint", async () => {
    // Guards the dormant case: a correct client nothing invokes.
    const f = narrativeFetch(CITED_NARRATIVE);
    await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(f.calls).toEqual([
      "https://api.example/api/brokerage/v1/research/narrative-section",
    ]);
  });

  it("a generated, cited narrative produces a NON-skeleton report", async () => {
    const f = narrativeFetch(CITED_NARRATIVE);
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(false);
    expect(result.narrativeFallbackReason).toBeUndefined();
    expect([...(result.narrativeCitedSections ?? [])].sort()).toEqual(["jurisdiction", "terrain"]);
  });

  it("an LLM-unavailable fixture still emits the COMPLETE skeleton, never an error", async () => {
    // WDLL item 6's stated check. The assertion that matters is that this
    // resolves at all, with a full report, rather than rejecting.
    const f = narrativeFetch({}, false);
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);
    expect(result.narrativeFallbackReason).toBe("http-error");
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.sectionCount).toBeGreaterThan(0);
  });

  it("DECLARED, not silent: the fallback reason is recorded on the atom too", async () => {
    const f = narrativeFetch({}, false);
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    const artifact = result.atom.artifacts["pdf-feasibility"] as Record<string, unknown>;
    expect(artifact.narrativeIsDeterministicSkeleton).toBe(true);
    expect(artifact.narrativeFallbackReason).toBe("http-error");
  });

  it("an uncited narrative is refused at the author level, not just in the client", async () => {
    const f = narrativeFetch({
      narrative: "A promising site with excellent potential.",
      generatedBy: "grok",
      generatedAt: "2026-09-07T19:00:00.000Z",
    });
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(true);
    expect(result.narrativeFallbackReason).toBe("no-cited-sections");
  });

  it("an explicit narrativeOverride still wins and skips the call entirely", async () => {
    const f = narrativeFetch(CITED_NARRATIVE);
    const result = await authorParcelFeasibilityExport({
      ...baseOptions(),
      narrativeOverride: {
        text: "Operator-supplied narrative.",
        generatedBy: "operator",
        generatedAt: "2026-09-07T00:00:00.000Z",
      },
      narrativeSection: {
        baseUrl: "https://api.example/api/brokerage/v1",
        apiKey: "svc",
        fetchImpl: f.impl,
      },
    } as any);
    expect(result.narrativeIsDeterministicSkeleton).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
