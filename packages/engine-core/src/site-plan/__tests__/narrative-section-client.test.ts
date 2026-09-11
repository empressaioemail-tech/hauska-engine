import { describe, expect, it } from "vitest";

import {
  buildFullNarrativeFacts,
  buildNarrativeFacts,
  deriveCitedSections,
  fetchFeasibilityNarrative,
} from "../narrative-section-client.js";
import {
  absent as absentFact,
  present as presentFact,
  type JurisdictionFacts,
} from "../feasibility-model.js";
import type { ParcelReportModel } from "../report-model.js";

/**
 * P-120 item 6, consuming side.
 *
 * The endpoint contract is fixed by the shipped route in legacy-design-tools
 * (PR #633) and read from that source, not from a description of it:
 *   request  { parcelNodeId, facts, courthouseDocuments? }
 *   response { narrative, generatedBy, generatedAt }
 * with citation derived by the caller scanning for its own `[key]` markers.
 */

function modelFixture(overrides: Partial<ParcelReportModel["facts"]> = {}): ParcelReportModel {
  const jurisdiction: JurisdictionFacts = {
    countyFips: "48021",
    countyName: "Bastrop",
    cityLimitsStatus: "unresolved",
    etjStatus: "unresolved",
  };
  return {
    parcelNodeId: "48021:47595",
    geometry: { status: "absent", reason: "not composed in this fixture" },
    drainage: { status: "absent", reason: "not composed in this fixture" },
    package: { verdict: "", narrativeSkeleton: "", openItems: [], dataQuality: { supersededNotes: [] } },
    facts: {
      jurisdiction,
      parcelOwnership: absentFact("No CAD roll row on file."),
      flood: presentFact({ zone: "X", inSpecialFloodHazardArea: false } as never),
      specialDistricts: absentFact("No special-district atom on file."),
      wellsPipelines: absentFact("No well or pipeline atom on file."),
      terrain: presentFact({ elevationRangeMeters: { min: 119.2, max: 121 }, contourIntervalMeters: 1 }),
      utilities: absentFact("No utility service rail reached this parcel."),
      hoa: { searchStatus: "not-searched" },
      footprint: absentFact("No building-footprint atom on file."),
      dischargePoint: absentFact("No county hydrography source registered."),
      ...overrides,
    },
  };
}

const config = { baseUrl: "https://api.example/api/brokerage/v1", apiKey: "svc-key-123" };

/** A fetch stub that records the one call it receives. */
function stubFetch(response: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  throws?: Error;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response.throws) throw response.throws;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({})),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const goodBody = {
  narrative:
    "The parcel sits in Bastrop County [jurisdiction]. It is mapped outside the special flood hazard area [flood]. Elevation ranges about two metres across the lot [terrain].",
  generatedBy: "grok",
  generatedAt: "2026-09-07T19:00:00.000Z",
};

describe("buildNarrativeFacts: what the model is allowed to see", () => {
  it("passes fact-state sections through unchanged", () => {
    const model = modelFixture();
    const facts = buildNarrativeFacts(model);
    expect(facts.flood).toBe(model.facts.flood);
    expect(facts.parcelOwnership).toBe(model.facts.parcelOwnership);
    expect(facts.footprint).toBe(model.facts.footprint);
  });

  it("HONESTY: an unsearched HOA is ABSENT, never a present 'no restrictions' fact", () => {
    // The load-bearing one. `searchStatus: "not-searched"` is the absence of
    // a search, not a finding that there are no restrictions. Handing it over
    // as present invites the model to write "no HOA restrictions apply".
    const facts = buildNarrativeFacts(modelFixture()) as Record<string, { status: string; reason?: string }>;
    expect(facts.hoa.status).toBe("absent");
    expect(facts.hoa.reason).toMatch(/have not been searched/i);
  });

  it("HOA becomes present only when a document is actually mounted", () => {
    const facts = buildNarrativeFacts(
      modelFixture({ hoa: { searchStatus: "not-searched", mountedDocumentCitation: "Vol 123 Pg 45" } }),
    ) as Record<string, { status: string; mountedDocumentCitation?: string }>;
    expect(facts.hoa.status).toBe("present");
    expect(facts.hoa.mountedDocumentCitation).toBe("Vol 123 Pg 45");
  });

  it("jurisdiction is absent when no county resolved, and carries the unresolved flags when it is", () => {
    const unknown = buildNarrativeFacts(
      modelFixture({
        jurisdiction: {
          countyFips: null,
          cityLimitsStatus: "unresolved",
          etjStatus: "unresolved",
        },
      }),
    ) as Record<string, { status: string }>;
    expect(unknown.jurisdiction.status).toBe("absent");

    const known = buildNarrativeFacts(modelFixture()) as Record<
      string,
      { status: string; cityLimitsStatus?: string }
    >;
    expect(known.jurisdiction.status).toBe("present");
    // The model must be able to say these are unresolved rather than guess.
    expect(known.jurisdiction.cityLimitsStatus).toBe("unresolved");
  });

  it("KEEPS the LDT contract at nine families — widening it regressed production", () => {
    // Regression guard, 2026-09-08. `buildNarrativeFacts` feeds
    // cortex-api's /research/narrative-section, a service this lane does not
    // own. Widening it made that service slower, tripped the client's 20s
    // timeout, and returned working parcels to the deterministic skeleton
    // (Caldwell 48055:20478 failed 3/3 on the canary while the serving
    // revision produced a real narrative in 17s). The wide payload lives on
    // `buildFullNarrativeFacts` instead.
    expect(Object.keys(buildNarrativeFacts(modelFixture())).sort()).toEqual(
      [
        "dischargePoint",
        "flood",
        "footprint",
        "hoa",
        "jurisdiction",
        "parcelOwnership",
        "specialDistricts",
        "terrain",
        "utilities",
        "wellsPipelines",
      ].sort(),
    );
  });

  it("offers every FACT FAMILY on the model to IN-PROCESS generation", () => {
    // Derived from the model, not frozen as a list. The frozen version of
    // this assertion named nine keys and passed for months while geometry,
    // topography, the drainage study, all five PR #404 families and the
    // package layer were absent from the payload — which is why the narrative
    // could never discuss flood or terrain. A snapshot of the omission cannot
    // catch the omission.
    const model = modelFixture();
    const offered = new Set(Object.keys(buildFullNarrativeFacts(model)));
    const missing = Object.keys(model.facts).filter((k) => !offered.has(k));
    expect(missing).toEqual([]);
  });

  it("offers the composed sub-models the fact families do not cover", () => {
    const offered = new Set(Object.keys(buildFullNarrativeFacts(modelFixture())));
    for (const key of ["geometry", "topography", "drainageStudy", "verdict", "openItems"]) {
      expect(offered.has(key)).toBe(true);
    }
  });

  it("projects the drainage study rather than spreading it", () => {
    // The study carries catchment GeoJSON, flow-line GeoJSON and a gradient
    // raster. Shipping those to a language model bills for coordinates it
    // cannot use, so the payload must carry summary numbers only.
    const serialized = JSON.stringify(buildFullNarrativeFacts(modelFixture()));
    expect(serialized).not.toContain("catchmentGeoJson");
    expect(serialized).not.toContain("flowLinesGeoJson");
    expect(serialized).not.toContain("coordinates");
  });

  // P-159 item 3. The payload used to send the raw LOCAL offset-ring
  // `buildableAreaSqFt` verbatim — a second, uncited number the model had no
  // way to reconcile against what the document actually prints (F4's
  // mechanism). It now sends the ONE printed value, atom-backed or refused.
  it("P-159: sends `printedBuildable`, never the raw local `buildableAreaSqFt`, in the geometry object", () => {
    const sitePlan = {
      summary: {
        zoningDistrict: "R-6",
        lotAreaSqFt: 10_000,
        buildableAreaSqFt: 6_500, // LOCAL — must never reach the payload
        buildableAreaHonestNote: undefined,
        printedBuildable: { kind: "refused", reason: "pending — buildable-envelope atom not yet on file" },
        elevationRangeMeters: { min: 100, max: 105 },
        verticalDatumSummary: "NAVD88 orthometric (USGS 3DEP)",
        address: "1127 N PINE ST, SAN ANTONIO, TX 78202",
        countyName: "Bexar County",
      },
      contourIntervalMeters: 0.5,
      setback: { honestAbsence: false, front: 15, side: 5, rear: 15, displayLine: "15 / 5 / 15" },
    };
    const model = modelFixture();
    (model as { geometry: unknown }).geometry = { status: "present", model: sitePlan };
    const facts = buildFullNarrativeFacts(model) as { geometry: Record<string, unknown> };
    expect(facts.geometry.printedBuildable).toEqual(sitePlan.summary.printedBuildable);
    expect(facts.geometry).not.toHaveProperty("buildableAreaSqFt");
    expect(facts.geometry).not.toHaveProperty("buildableAreaNote");
    expect(JSON.stringify(facts.geometry)).not.toContain("6500");
  });

  // P-159 item 3: the SAME guard the facts page applies
  // (`footprintContradictsAppraisal`, `report-model.ts`) — never hand the
  // narrative-generating model "the site reads as unimproved" when the
  // appraisal roll independently says the parcel carries a structure.
  describe("P-159: the footprint fact the model sees never contradicts the appraisal roll", () => {
    it("overrides the misleading consequence when the roll carries year built / living area", () => {
      const model = modelFixture({
        footprint: absentFact(
          "clear",
          "Checked against the building-footprint source; no structure is mapped on this parcel.",
          "The site reads as unimproved, so redevelopment is unlikely to require demolition.",
        ),
        parcelOwnership: presentFact({ yearBuilt: 1904, livingAreaSqft: 1_820 } as never),
      });
      const facts = buildFullNarrativeFacts(model) as { footprint: { consequence?: string; status: string } };
      expect(facts.footprint.status).toBe("absent"); // the FACT is unchanged — only the consequence text
      expect(facts.footprint.consequence).not.toContain("unimproved");
      expect(facts.footprint.consequence).toContain("Sources disagree");
      expect(facts.footprint.consequence).toContain("1,820 sq ft");
      expect(facts.footprint.consequence).toContain("1904");
    });

    it("leaves the footprint fact untouched when the roll agrees the parcel is genuinely vacant", () => {
      const model = modelFixture({
        footprint: absentFact("clear", "no structure mapped", "The site reads as unimproved, so redevelopment is unlikely to require demolition."),
        parcelOwnership: presentFact({} as never),
      });
      const facts = buildFullNarrativeFacts(model) as { footprint: { consequence?: string } };
      expect(facts.footprint.consequence).toContain("unimproved");
    });

    it("applies the same override on the narrow LDT payload, not only the wide in-process one", () => {
      const model = modelFixture({
        footprint: absentFact("clear", "no structure mapped", "The site reads as unimproved, so redevelopment is unlikely to require demolition."),
        parcelOwnership: presentFact({ yearBuilt: 1975 } as never),
      });
      const facts = buildNarrativeFacts(model) as { footprint: { consequence?: string } };
      expect(facts.footprint.consequence).not.toContain("unimproved");
      expect(facts.footprint.consequence).toContain("Sources disagree");
    });
  });
});

describe("deriveCitedSections: scanned, never self-reported", () => {
  it("counts only markers actually present in the text", () => {
    const { cited, uncited } = deriveCitedSections("Sits in the county [jurisdiction].", [
      "jurisdiction",
      "flood",
    ]);
    expect(cited).toEqual(["jurisdiction"]);
    expect(uncited).toEqual(["flood"]);
  });

  it("a model that merely NAMES a category without marking it does not get credit", () => {
    // The whole point of scanning rather than trusting a returned list.
    const { cited } = deriveCitedSections(
      "I considered flood and jurisdiction carefully and cited them both.",
      ["jurisdiction", "flood"],
    );
    expect(cited).toEqual([]);
  });
});

describe("fetchFeasibilityNarrative: the request", () => {
  it("posts the locked contract to the right path with bearer service auth", async () => {
    const f = stubFetch({ json: async () => goodBody });
    await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, fetchImpl: f.impl },
    });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://api.example/api/brokerage/v1/research/narrative-section");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer svc-key-123");
    const body = JSON.parse(String(init.body));
    expect(body.parcelNodeId).toBe("48021:47595");
    expect(Object.keys(body.facts)).toContain("flood");
    // Omitted, not sent as an empty array, when there are none.
    expect(body).not.toHaveProperty("courthouseDocuments");
  });

  it("sends courthouse documents when supplied (item 16's seam)", async () => {
    const f = stubFetch({ json: async () => goodBody });
    await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, fetchImpl: f.impl },
      courthouseDocuments: [{ citation: "Vol 9 Pg 1", excerpt: "No structure shall..." }],
    });
    expect(JSON.parse(String(f.calls[0]!.init.body)).courthouseDocuments).toHaveLength(1);
  });

  it("tolerates a baseUrl with a trailing slash", async () => {
    const f = stubFetch({ json: async () => goodBody });
    await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, baseUrl: `${config.baseUrl}/`, fetchImpl: f.impl },
    });
    expect(f.calls[0]!.url).toBe("https://api.example/api/brokerage/v1/research/narrative-section");
  });
});

describe("fetchFeasibilityNarrative: the happy path", () => {
  it("returns an override shaped for the PDF emitter, with scanned citations", async () => {
    const f = stubFetch({ json: async () => goodBody });
    const out = await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, fetchImpl: f.impl },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.outcome.narrativeOverride.text).toContain("Bastrop County");
    expect(out.outcome.narrativeOverride.generatedBy).toBe("grok");
    expect([...out.outcome.citedSections].sort()).toEqual(["flood", "jurisdiction", "terrain"]);
    expect(out.outcome.uncitedSections).toContain("utilities");
  });
});

describe("fetchFeasibilityNarrative: every failure falls back, none throws", () => {
  const cases: Array<[string, Parameters<typeof stubFetch>[0], string]> = [
    ["a network error", { throws: new Error("ECONNRESET") }, "request-failed"],
    ["a 500", { ok: false, status: 500 }, "http-error"],
    ["a 401", { ok: false, status: 401 }, "http-error"],
    [
      "unparseable JSON",
      { json: async () => { throw new Error("Unexpected token"); } },
      "malformed-response",
    ],
    ["a response missing fields", { json: async () => ({ narrative: "x" }) }, "malformed-response"],
    [
      "a whitespace-only narrative",
      { json: async () => ({ ...goodBody, narrative: "   " }) },
      "empty-narrative",
    ],
  ];

  for (const [label, response, reason] of cases) {
    it(`${label} -> ${reason}, and does not throw`, async () => {
      const f = stubFetch(response);
      const out = await fetchFeasibilityNarrative({
        model: modelFixture(),
        config: { ...config, fetchImpl: f.impl },
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe(reason);
    });
  }

  it("REFUSES the server's own no-content apology rather than printing it", async () => {
    // The route's last-resort string comes back with generatedBy "rules-v1".
    // Accepting it would put a one-line apology in the customer's PDF and
    // mark the report as carrying a generated narrative. Our complete
    // skeleton is the better artifact.
    const f = stubFetch({
      json: async () => ({
        narrative:
          "Feasibility narrative unavailable — the reasoning engine returned no content this run. [flood]",
        generatedBy: "rules-v1",
        generatedAt: "2026-09-07T19:00:00.000Z",
      }),
    });
    const out = await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, fetchImpl: f.impl },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("server-reported-no-llm-content");
  });

  it("REFUSES an uncited wall of prose (commitment #1)", async () => {
    // Fluent, plausible, and marks nothing. Every output carries a source
    // citation or it does not ship; the skeleton is cited by construction.
    const f = stubFetch({
      json: async () => ({
        ...goodBody,
        narrative: "This is an excellent parcel with strong development potential.",
      }),
    });
    const out = await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { ...config, fetchImpl: f.impl },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("no-cited-sections");
  });

  it("refuses to call at all when unconfigured, without touching the network", async () => {
    const f = stubFetch({ json: async () => goodBody });
    const out = await fetchFeasibilityNarrative({
      model: modelFixture(),
      config: { baseUrl: "", apiKey: "", fetchImpl: f.impl },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("not-configured");
    expect(f.calls).toHaveLength(0);
  });
});

/**
 * The latency instrument, added 2026-09-08 after doc-repo-79 pointed out that
 * the only visible number was the WHOLE feasibility request (20.2s-41.0s
 * across five counties on identical code). Inside that envelope a 3s
 * narrative call and an 18s one look the same, and an 18s one passes today
 * and fails on any slower day against the 20s timeout.
 *
 * Tested because an emitter nobody calls is the failure this whole session
 * kept finding. Both directions: it must fire on success AND on failure.
 * Success is the load-bearing half — the failures are already known to sit
 * at the timeout, so only the successes say whether there is headroom.
 */
describe("the narrative call reports its own duration", () => {
  function captureLogs(): { lines: unknown[]; restore: () => void } {
    const lines: unknown[] = [];
    const original = console.log;
    console.log = (arg: unknown) => {
      try {
        const parsed = JSON.parse(String(arg));
        if (parsed?.event === "feasibility.narrative_section.call") lines.push(parsed);
      } catch {
        /* not our line */
      }
    };
    return { lines, restore: () => { console.log = original; } };
  }

  it("emits duration, timeout and cited count on SUCCESS", async () => {
    const f = stubFetch({ json: async () => goodBody });
    const cap = captureLogs();
    try {
      await fetchFeasibilityNarrative({
        model: modelFixture(),
        config: { ...config, fetchImpl: f.impl },
      });
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const line = cap.lines[0] as Record<string, unknown>;
    expect(line.outcome).toBe("ok");
    expect(typeof line.durationMs).toBe("number");
    expect(line.timeoutMs).toBe(20_000);
    expect(line.citedCount).toBeGreaterThan(0);
  });

  it("emits on FAILURE too, with the outcome that caused it", async () => {
    const cap = captureLogs();
    try {
      await fetchFeasibilityNarrative({
        model: modelFixture(),
        config: {
          ...config,
          fetchImpl: (async () => {
            throw new Error("simulated timeout");
          }) as unknown as typeof fetch,
        },
      });
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const line = cap.lines[0] as Record<string, unknown>;
    expect(line.outcome).toBe("request-failed");
    expect(String(line.detail)).toContain("simulated timeout");
  });
});
