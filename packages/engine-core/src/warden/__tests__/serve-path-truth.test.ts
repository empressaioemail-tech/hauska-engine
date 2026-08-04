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
        loadDbTruth: async () => ({ hasZoningFact: true, district: "SF-1", hasBuildableEnvelope: true }),
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
        loadDbTruth: async () => ({ hasZoningFact: true, district: "SF-1", hasBuildableEnvelope: true }),
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
        loadDbTruth: async () => ({ hasZoningFact: true, district: "SF-1", hasBuildableEnvelope: true }),
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
        loadDbTruth: async () => ({ hasZoningFact: true, district: "SF-1", hasBuildableEnvelope: true }),
      },
    });
    expect(findings).toHaveLength(0);
  });
});
