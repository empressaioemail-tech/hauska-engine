import { describe, it, expect, vi } from "vitest";

import { runServePathTruthCheck } from "../serve-path-truth.js";

const FIXED_NOW = () => new Date("2026-08-04T00:00:00.000Z");
const FIPS = "48021";
const ROW_ID = "Bastrop";
const SAMPLE = [`${FIPS}:34073`, `${FIPS}:34081`];

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("runServePathTruthCheck", () => {
  it("401 on authed /search flags SERVE-PATH-UNHEALTHY per parcel", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(401, {});
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: SAMPLE,
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(SAMPLE.length);
    for (const f of findings) {
      expect(f.checkId).toBe("servePathTruth");
      expect(f.defectClass).toBe("SERVE-PATH-UNHEALTHY");
      expect(f.severity).toBe("flag");
      expect(f.evidence.httpStatus).toBe(401);
    }
  });

  it("unhealthy /health/search short-circuits with a single row-level flag (no per-parcel probes attempted)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(500, {});
      throw new Error("should not reach /search when /health/search fails");
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: SAMPLE,
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.parcelNodeId).toBeNull();
    expect(findings[0]!.evidence.probe).toBe("health/search");
  });

  it("200s but atom-chain body diverges from DB truth — flags atom-chain-body-sanity", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, { atoms: [] }); // served body omits the zoning-fact the DB says exists
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.probe).toBe("atom-chain-body-sanity");
    expect(findings[0]!.evidence.mismatches).toContain("zoningFactPresent");
  });

  it("all probes healthy and body sanity matches DB truth — no findings", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, {
          atoms: [
            { entityType: "zoning-fact", body: { district: "SF-1" } },
            { entityType: "buildable-envelope" },
          ],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(0);
  });

  it("calibration fix 1 — every finding carries the SAMPLED parcel's own id, never a shared/degenerate id, across a realistic multi-parcel sample with real getPropertyAtomChain wire shapes", async () => {
    const sample = [`${FIPS}:34073`, `${FIPS}:34081`, `${FIPS}:105054`];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        const parcelNodeId = url.split("/property-nodes/")[1]!.split("/atom-chain")[0]!;
        // Real getPropertyAtomChain wire shape: top-level parcelNodeId echo,
        // zoningFact/buildableEnvelope as top-level keys, atoms[] entries
        // carrying type/kind rather than entityType.
        return jsonResponse(200, {
          parcelNodeId,
          zoningFact: { entityType: "zoning-fact", district: "SF-1" },
          buildableEnvelope: { entityType: "buildable-envelope" },
          atoms: [{ did: "x", type: "zoning-fact", kind: "zoning-fact", payload: { entityType: "zoning-fact", district: "SF-1" } }],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample,
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    // Every parcel is fully healthy and matches DB truth — no findings at
    // all, which itself proves the served body was parsed correctly for
    // every distinct parcel in the sample (a shared/degenerate id or a
    // field-name mis-parse would have produced mismatches here).
    expect(findings).toHaveLength(0);
  });

  it("calibration fix 1 — a per-parcel probe failure carries THAT parcel's own sampled id, never a neighbor's or a constant fallback", async () => {
    const sample = [`${FIPS}:34073`, `${FIPS}:34081`, `${FIPS}:105054`];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes(`/search?`)) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        // Force every atom-chain probe to 500 so each sampled parcel produces its own flag.
        return jsonResponse(500, {});
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample,
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(sample.length);
    expect(findings.map((f) => f.parcelNodeId)).toEqual(sample);
    // No two findings share an id, and none carries a degenerate id like "48021:0".
    expect(new Set(findings.map((f) => f.parcelNodeId)).size).toBe(sample.length);
    for (const f of findings) expect(f.parcelNodeId).not.toBe(`${FIPS}:0`);
  });

  it("calibration fix 1 — a served atom-chain body echoing a DIFFERENT parcelNodeId than requested is flagged as an id mismatch, filed under the SAMPLED id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        // Server echoes back a parcelNodeId that does not match the one requested.
        return jsonResponse(200, { parcelNodeId: `${FIPS}:0`, atoms: [] });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: false,
          district: null,
          hasBuildableEnvelope: false,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.parcelNodeId).toBe(`${FIPS}:34073`);
    expect(findings[0]!.evidence.probe).toBe("atom-chain-parcel-id-mismatch");
    expect(findings[0]!.evidence.sampledParcelNodeId).toBe(`${FIPS}:34073`);
    expect(findings[0]!.evidence.servedParcelNodeId).toBe(`${FIPS}:0`);
  });

  it("calibration fix 2 — real wire shape (buildableEnvelope top-level key, atoms[] type/kind fields) is parsed correctly, not silently missed", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, {
          parcelNodeId: `${FIPS}:34073`,
          zoningFact: { entityType: "zoning-fact", district: "SF-1" },
          buildableEnvelope: { entityType: "buildable-envelope" },
          atoms: [
            { did: "a", type: "zoning-fact", kind: "zoning-fact" },
            { did: "b", type: "buildable-envelope", kind: "buildable-envelope" },
          ],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: null,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    // A real envelope, correctly parsed via the real field names, matches DB truth — no findings.
    expect(findings).toHaveLength(0);
  });

  it("calibration fix 3 — DESIGNED suppression (stale setback source, envelope not independently serve-eligible) never flags, records an info note instead", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        // Envelope is suppressed at serve time — absent from both the top-level key and atoms[].
        return jsonResponse(200, {
          parcelNodeId: `${FIPS}:34073`,
          zoningFact: { entityType: "zoning-fact", district: "SF-1" },
          atoms: [{ did: "a", type: "zoning-fact", kind: "zoning-fact" }],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          // Unambiguous designed-suppression inputs: setback source IS stale,
          // and the envelope carries none of the independent-survival markers.
          setbackSourceStale: true,
          envelopeServeIndependentOfStaleSetback: false,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.defectClass).toBe("SERVE-PATH-UNHEALTHY");
    expect(findings[0]!.evidence.note).toBe("designed-suppression-observed");
  });

  it("calibration fix 3 — a genuinely unambiguous non-suppression case (non-stale setback source) still flags a real serve defect", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, {
          parcelNodeId: `${FIPS}:34073`,
          zoningFact: { entityType: "zoning-fact", district: "SF-1" },
          atoms: [{ did: "a", type: "zoning-fact", kind: "zoning-fact" }],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          // Unambiguous non-suppression: the setback source is explicitly NOT stale.
          setbackSourceStale: false,
          envelopeServeIndependentOfStaleSetback: null,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("flag");
    expect(findings[0]!.defectClass).toBe("SERVE-PATH-UNHEALTHY");
    expect(findings[0]!.evidence.mismatches).toContain("envelopePresent");
  });

  it("calibration fix 3 — an envelope independently serve-eligible under suppression (depth-warm survival markers) never flags even with a stale setback source", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/health/search")) return jsonResponse(200, {});
      if (url.includes("/search?")) return jsonResponse(200, {});
      if (url.includes("/atom-chain")) {
        return jsonResponse(200, {
          parcelNodeId: `${FIPS}:34073`,
          zoningFact: { entityType: "zoning-fact", district: "SF-1" },
          atoms: [{ did: "a", type: "zoning-fact", kind: "zoning-fact" }],
        });
      }
      return jsonResponse(200, {});
    });
    const findings = await runServePathTruthCheck({
      sweepId: "test-sweep",
      fips: FIPS,
      rowId: ROW_ID,
      now: FIXED_NOW,
      deps: {
        baseUrl: "https://retrieval.example",
        apiKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sample: [`${FIPS}:34073`],
        loadDbTruth: async () => ({
          hasZoningFact: true,
          district: "SF-1",
          hasBuildableEnvelope: true,
          setbackSourceStale: true,
          envelopeServeIndependentOfStaleSetback: true,
        }),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.evidence.note).toBe("designed-suppression-observed");
  });
});
