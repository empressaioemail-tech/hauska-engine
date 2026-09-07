/**
 * item 20 -- soil type (USDA SSURGO). Mocked USDA upstream (no live network
 * in unit tests), consuming the real `usdaSsurgoSoilsAdapter` through
 * `FEDERAL_ADAPTERS` + `runAdapters` rather than re-implementing it.
 *
 * The SDA response body below is not invented: it is the real payload
 * `sdmdataaccess.sc.egov.usda.gov/tabular/post.rest` returned live
 * 2026-09-07 for parcel 48021:52726's centroid (1007 Water St, Bastrop, TX)
 * -- "Bosque loam, 0 to 1 percent slopes, occasionally flooded", well
 * drained, hydrologic group B. mukey 393277 is real; the gSSURGO polygon
 * response is a synthetic feature carrying the same real mukey/areasymbol,
 * since the live gSSURGO ArcGIS host was not queried for this fixture.
 */
import { describe, expect, it } from "vitest";

import { resolveSoilFact } from "../resolve-soil-fact.js";

const BASTROP_52726_CENTROID = { latitude: 30.11148235687972, longitude: -97.31856839686304 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Real SDA response, captured live 2026-09-07 for the Bastrop centroid above. */
const REAL_SDA_TABLE = {
  Table: [
    ["mukey", "musym", "muname", "areasymbol", "brockdepmin", "wtdepannmin", "drclassdcd", "hydgrpdcd", "compname", "drainagecl", "hydgrp", "slope_r"],
    ["393277", "Bo", "Bosque loam, 0 to 1 percent slopes, occasionally flooded", "TX021", null, null, "Well drained", "B", "Bosque", "Well drained", "B", "0.5"],
  ],
};

function routedFetch(opts: { gssurgo?: Response | Error; sda?: Response | Error }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("nrcsgeoservices.sc.egov.usda.gov")) {
      if (opts.gssurgo instanceof Error) throw opts.gssurgo;
      return opts.gssurgo ?? jsonResponse({ features: [] });
    }
    if (url.includes("sdmdataaccess.sc.egov.usda.gov")) {
      if (opts.sda instanceof Error) throw opts.sda;
      return opts.sda ?? jsonResponse({ Table: [] });
    }
    throw new Error(`unexpected USDA URL in test: ${url} ${init?.method ?? ""}`);
  }) as unknown as typeof fetch;
}

describe("resolveSoilFact", () => {
  it("real Bastrop replay: present with the live-verified Bosque loam series", async () => {
    const fetchImpl = routedFetch({
      gssurgo: jsonResponse({
        features: [{ attributes: { MUKEY: "393277", MUSYM: "Bo", MUNAME: "Bosque loam, 0 to 1 percent slopes, occasionally flooded", AREASYMBOL: "TX021" } }],
      }),
      sda: jsonResponse(REAL_SDA_TABLE),
    });

    const result = await resolveSoilFact(BASTROP_52726_CENTROID, fetchImpl);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.facts.mukey).toBe("393277");
      expect(result.facts.muname).toBe("Bosque loam, 0 to 1 percent slopes, occasionally flooded");
      expect(result.facts.areaSymbol).toBe("TX021");
      expect(result.facts.drainageClass).toBe("Well drained");
      expect(result.facts.hydrologicSoilGroup).toBe("B");
      expect(result.facts.degraded).toBe(false);
      expect(result.facts.sourceCitation).toContain("SSURGO");
    }
  });

  it("degraded-but-present when SDA resets but the gSSURGO map unit still answers", async () => {
    const fetchImpl = routedFetch({
      gssurgo: jsonResponse({
        features: [{ attributes: { MUKEY: "393277", MUSYM: "Bo", MUNAME: "Bosque loam, 0 to 1 percent slopes, occasionally flooded", AREASYMBOL: "TX021" } }],
      }),
      sda: new Error("ECONNRESET"),
    });

    const result = await resolveSoilFact(BASTROP_52726_CENTROID, fetchImpl);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.facts.mukey).toBe("393277");
      expect(result.facts.degraded).toBe(true);
      expect(result.facts.degradationReasons.length).toBeGreaterThan(0);
      // SDA-only attributes are honestly null, never guessed from the map unit alone.
      expect(result.facts.drainageClass).toBeNull();
    }
  });

  it("honest absence, never a fabricated soil series, when both USDA upstreams find nothing", async () => {
    // A finite, in-bbox US coordinate (mid-continent) so `appliesTo` passes and
    // the adapter itself runs -- Null Island (0,0) fails the adapter's own US
    // bbox gate and short-circuits before either mocked upstream is called.
    const IN_BBOX_BUT_UNMAPPED = { latitude: 40, longitude: -100 };
    const fetchImpl = routedFetch({ gssurgo: jsonResponse({ features: [] }), sda: jsonResponse({ Table: [] }) });
    const result = await resolveSoilFact(IN_BBOX_BUT_UNMAPPED, fetchImpl);
    expect(result.status).toBe("absent");
    if (result.status === "absent") {
      expect(result.reason.toLowerCase()).toContain("no ssurgo soil map unit");
    }
  });

  it("honest absence when both upstreams fail outright", async () => {
    const fetchImpl = routedFetch({ gssurgo: new Error("network unreachable"), sda: new Error("network unreachable") });
    const result = await resolveSoilFact(BASTROP_52726_CENTROID, fetchImpl);
    expect(result.status).toBe("absent");
  });
});
