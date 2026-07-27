/**
 * UNREACHABLE-CITY-GIS gate (27d / RECIPE-PROOF Caldwell 2026-07-27).
 *
 * When a jurisdiction-level city GIS endpoint fails DNS or hard-fails HTTP,
 * treat it as an ABSENT source — not empty-authoritative. Fall to OSM
 * best-available; never invent county-roadway-authoritative / city-authoritative
 * from a missing endpoint.
 */

export type CityGisReachability =
  | { status: "reachable" }
  | {
      status: "unreachable";
      reason: "dns-fail" | "http-hard-fail";
      urlsTried: readonly string[];
    };

/** Provenance posture for city streets given city-GIS reachability. */
export function cityGisProvenancePosture(
  reachability: CityGisReachability,
): "authoritative-if-data-populated" | "absent-use-osm-best-available" {
  if (reachability.status === "unreachable") {
    return "absent-use-osm-best-available";
  }
  return "authoritative-if-data-populated";
}

/** True when a recon source verdict string encodes the UNREACHABLE gate. */
export function isUnreachableCityGisVerdict(verdict: string): boolean {
  return /\bUNREACHABLE\b/i.test(verdict);
}

export type RoadSourceReconFixture = {
  event: string;
  countyFips: string;
  sources: ReadonlyArray<{
    name: string;
    verdict?: string;
    role?: string;
    urlsTried?: readonly string[];
  }>;
  newDecision?: string;
  liveIngest?: {
    osmEmitted?: number;
    cadAuthoritative?: number;
  };
};

/**
 * Mechanical invariants for a county road-source recon that hit UNREACHABLE-CITY-GIS.
 * Throws (via expect-style returns) as a pure predicate so vitest can assert.
 */
export function unreachableCityGisReconHolds(recon: RoadSourceReconFixture): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];

  if (recon.event !== "AUTHORITATIVE-ROAD-SOURCE-RECON") {
    failures.push(`event must be AUTHORITATIVE-ROAD-SOURCE-RECON, got ${recon.event}`);
  }

  const unreachable = recon.sources.filter(
    (s) => typeof s.verdict === "string" && isUnreachableCityGisVerdict(s.verdict),
  );
  if (unreachable.length === 0) {
    failures.push("expected at least one source with UNREACHABLE verdict");
  }

  for (const u of unreachable) {
    const posture = cityGisProvenancePosture({
      status: "unreachable",
      reason: /DNS/i.test(u.verdict ?? "") ? "dns-fail" : "http-hard-fail",
      urlsTried: u.urlsTried ?? [],
    });
    if (posture !== "absent-use-osm-best-available") {
      failures.push(`${u.name}: unreachable must map to absent-use-osm-best-available`);
    }
    if (/\bauthoritative\b/i.test(u.verdict ?? "") && !/not|never|absent|OSM/i.test(u.verdict ?? "")) {
      failures.push(`${u.name}: unreachable verdict must not claim authoritative`);
    }
  }

  const osm = recon.sources.find(
    (s) =>
      /OSM/i.test(s.name) ||
      s.role === "osm-best-available" ||
      (typeof s.role === "string" && /osm-best-available/i.test(s.role)),
  );
  if (!osm) {
    failures.push("unreachable city GIS requires an OSM best-available source entry");
  }

  if (!recon.newDecision || !/UNREACHABLE-CITY-GIS/i.test(recon.newDecision)) {
    failures.push("newDecision must name UNREACHABLE-CITY-GIS when recon has unreachable city GIS");
  }

  // Never invent authoritative from the miss — live ingest must keep OSM when CAD city is sparse.
  if (
    recon.liveIngest &&
    typeof recon.liveIngest.osmEmitted === "number" &&
    recon.liveIngest.osmEmitted <= 0
  ) {
    failures.push("liveIngest.osmEmitted must be > 0 when city GIS is unreachable (OSM is the city grid)");
  }

  return { ok: failures.length === 0, failures };
}
