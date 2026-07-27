/**
 * UNREACHABLE-CITY-GIS mechanical gate (M0 promotion — RECIPE-PROOF Caldwell).
 * Goes RED if the Caldwell recon fixture drops the unreachable verdict,
 * invents authoritative from a DNS-miss, or omits OSM best-available.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cityGisProvenancePosture,
  isUnreachableCityGisVerdict,
  unreachableCityGisReconHolds,
  type RoadSourceReconFixture,
} from "../unreachable-city-gis.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CALDWELL_RECON = JSON.parse(
  readFileSync(join(HERE, "../fixtures/caldwell-road-source-recon.json"), "utf8").replace(
    /^\uFEFF/,
    "",
  ),
) as RoadSourceReconFixture;

describe("UNREACHABLE-CITY-GIS gate (27d / Caldwell RECIPE-PROOF)", () => {
  it("maps DNS/HTTP unreachable city GIS to absent-use-osm — never authoritative", () => {
    expect(
      cityGisProvenancePosture({
        status: "unreachable",
        reason: "dns-fail",
        urlsTried: ["https://gis.lockhart-tx.org/server/rest/services"],
      }),
    ).toBe("absent-use-osm-best-available");

    expect(
      cityGisProvenancePosture({
        status: "unreachable",
        reason: "http-hard-fail",
        urlsTried: ["https://maps.example.invalid/arcgis/rest/services"],
      }),
    ).toBe("absent-use-osm-best-available");

    expect(cityGisProvenancePosture({ status: "reachable" })).toBe(
      "authoritative-if-data-populated",
    );
  });

  it("detects UNREACHABLE in recon verdict strings", () => {
    expect(
      isUnreachableCityGisVerdict(
        "UNREACHABLE (DNS fail) — treat as absent; OSM best-available for Lockhart city grid",
      ),
    ).toBe(true);
    expect(
      isUnreachableCityGisVerdict(
        "SCHEMA_AND_DATA_POPULATED for county roads; city streets sparse",
      ),
    ).toBe(false);
  });

  it("Caldwell recon fixture holds the gate (mechanical — RED if prose-only drift)", () => {
    const result = unreachableCityGisReconHolds(CALDWELL_RECON);
    expect(result.failures, result.failures.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);

    const lockhart = CALDWELL_RECON.sources.find((s) => /Lockhart city GIS/i.test(s.name));
    expect(lockhart?.verdict).toMatch(/UNREACHABLE/i);
    expect(lockhart?.urlsTried?.length).toBeGreaterThan(0);
  });

  it("goes RED when unreachable city GIS is silently dropped from recon", () => {
    const stripped: RoadSourceReconFixture = {
      ...CALDWELL_RECON,
      sources: CALDWELL_RECON.sources.filter((s) => !/Lockhart city GIS/i.test(s.name)),
      newDecision: "something else",
    };
    const result = unreachableCityGisReconHolds(stripped);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /UNREACHABLE verdict/i.test(f))).toBe(true);
  });

  it("goes RED when recon invents authoritative and omits OSM after unreachable", () => {
    const bad: RoadSourceReconFixture = {
      event: "AUTHORITATIVE-ROAD-SOURCE-RECON",
      countyFips: "48055",
      sources: [
        {
          name: "Lockhart city GIS",
          verdict: "UNREACHABLE (DNS fail)",
          urlsTried: ["https://gis.lockhart-tx.org/server/rest/services"],
        },
      ],
      newDecision: "UNREACHABLE-CITY-GIS: noted",
      liveIngest: { osmEmitted: 0, cadAuthoritative: 9999 },
    };
    const result = unreachableCityGisReconHolds(bad);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /OSM best-available/i.test(f))).toBe(true);
    expect(result.failures.some((f) => /osmEmitted/i.test(f))).toBe(true);
  });
});
