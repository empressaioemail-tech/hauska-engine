import { describe, expect, it } from "vitest";

import {
  WEB_BLOCK_CLOSE,
  WEB_BLOCK_OPEN,
  extractWebFindings,
  findUnauthorizedBuildableFigures,
  generateFeasibilityNarrative,
  splitWebBlock,
} from "../narrative-generator.js";
import type { ParcelReportModel } from "../report-model.js";
import type { GrokSearchClient } from "../../llm/grok-search.js";

const model = {
  parcelNodeId: "48021:27895",
  geometry: { status: "absent", reason: "fixture" },
  drainage: { status: "absent", reason: "fixture" },
  package: { verdict: "v", narrativeSkeleton: "s", openItems: [], dataQuality: { supersededNotes: [] } },
  facts: {
    jurisdiction: { countyName: "Bastrop County", countyFips: "48021", cityLimitsStatus: "unresolved" },
    parcelOwnership: { status: "absent", kind: "clear", reason: "r" },
    flood: { status: "absent", kind: "clear", reason: "r" },
    specialDistricts: { status: "absent", kind: "clear", reason: "r" },
    wellsPipelines: { status: "absent", kind: "clear", reason: "r" },
    terrain: { status: "absent", kind: "clear", reason: "r" },
    utilities: { status: "absent", kind: "clear", reason: "r" },
    hoa: {},
    footprint: { status: "absent", kind: "clear", reason: "r" },
    dischargePoint: { status: "absent", kind: "clear", reason: "r" },
    floodplainAcreage: { status: "absent", kind: "clear", reason: "r" },
    firmPanel: { status: "absent", kind: "clear", reason: "r" },
    soil: { status: "absent", kind: "clear", reason: "r" },
    electricProvider: { status: "absent", kind: "clear", reason: "r" },
    gasProvider: { status: "absent", kind: "clear", reason: "r" },
  },
} as unknown as ParcelReportModel;

function clientReturning(text: string, citations: Array<{ url: string; title?: string }> = []): GrokSearchClient {
  return {
    respondWithSearch: async () => ({ text, citations, searches: [] }),
  };
}

describe("splitWebBlock keeps web prose out of the report body", () => {
  it("separates the delimited block from the narrative", () => {
    const { body, webBlock } = splitWebBlock(
      `Main prose [flood].\n${WEB_BLOCK_OPEN}\n- Listed on the NRHP (https://a.example/x)\n${WEB_BLOCK_CLOSE}`,
    );
    expect(body).toBe("Main prose [flood].");
    expect(webBlock).toContain("NRHP");
  });

  it("an unterminated block still does not leak into the body", () => {
    // The failure direction that matters: a model that opens the block and
    // forgets to close it must not have its web prose land in the report.
    const { body, webBlock } = splitWebBlock(`Body [flood].\n${WEB_BLOCK_OPEN}\n- loose (https://a.example/x)`);
    expect(body).toBe("Body [flood].");
    expect(webBlock).toContain("loose");
  });

  it("no block at all yields no findings", () => {
    expect(splitWebBlock("Just prose [flood].").webBlock).toBeNull();
  });
});

describe("extractWebFindings: a citation the provider never returned is dropped", () => {
  const cited = [{ url: "https://real.example/page", title: "Real" }];

  it("keeps a claim whose URL the search tool actually returned", () => {
    const found = extractWebFindings("- The house is listed (https://real.example/page)", cited);
    expect(found).toHaveLength(1);
    expect(found[0]!.url).toBe("https://real.example/page");
    expect(found[0]!.text).toBe("The house is listed");
  });

  it("DROPS a claim citing a URL the provider never returned", () => {
    // The falsifier for the whole control. The model supplies both the
    // sentence and the URL, so without checking against the provider's own
    // annotation list, a fabricated source prints beside real ones.
    const found = extractWebFindings("- Invented fact (https://fake.example/nope)", cited);
    expect(found).toEqual([]);
  });

  it("drops a claim with no URL at all", () => {
    expect(extractWebFindings("- A bare assertion with no source", cited)).toEqual([]);
  });

  it("returns nothing when the provider cited nothing, even if the block is full", () => {
    expect(extractWebFindings("- Something (https://real.example/page)", [])).toEqual([]);
  });

  it("tolerates trailing punctuation and a trailing slash on the URL", () => {
    const found = extractWebFindings("- Listed (https://real.example/page/).", cited);
    expect(found).toHaveLength(1);
  });
});

describe("generateFeasibilityNarrative fails closed", () => {
  it("REFUSES a narrative that cites no fact key", async () => {
    const out = await generateFeasibilityNarrative(model, {
      client: clientReturning("Beautiful lot with great potential."),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("no-citations");
  });

  it("accepts a narrative that marks a real fact key", async () => {
    const out = await generateFeasibilityNarrative(model, {
      client: clientReturning("The county is resolved [jurisdiction]."),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.citedSections).toContain("jurisdiction");
  });

  it("turns a thrown provider error into a reason, never an exception", async () => {
    const out = await generateFeasibilityNarrative(model, {
      client: {
        respondWithSearch: async () => {
          throw new Error("upstream down");
        },
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("request-failed");
      expect(out.detail).toContain("upstream down");
    }
  });

  it("ignores citations entirely when web search was not requested", async () => {
    // Search off means no web block, even if the provider volunteers URLs.
    const out = await generateFeasibilityNarrative(model, {
      client: clientReturning(
        `Body [jurisdiction].\n${WEB_BLOCK_OPEN}\n- x (https://real.example/p)\n${WEB_BLOCK_CLOSE}`,
        [{ url: "https://real.example/p" }],
      ),
      webSearch: false,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.webFindings).toEqual([]);
  });

  it("carries web findings through when search WAS requested", async () => {
    const out = await generateFeasibilityNarrative(model, {
      client: clientReturning(
        `Body [jurisdiction].\n${WEB_BLOCK_OPEN}\n- Listed on the NRHP (https://real.example/p)\n${WEB_BLOCK_CLOSE}`,
        [{ url: "https://real.example/p" }],
      ),
      webSearch: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.webFindings).toHaveLength(1);
      expect(out.narrativeOverride.text).not.toContain("NRHP");
      expect(out.narrativeOverride.generatedBy).toContain("+web");
    }
  });

  it("does not open a live client under test even with XAI_API_KEY set", async () => {
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "would-be-billed";
    try {
      const out = await generateFeasibilityNarrative(model, {});
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("no-api-key");
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });
});

// P-159 item 3. Silent acceptance of a wrong or invented buildable-area figure
// is the defect (F4). `findUnauthorizedBuildableFigures` is the deterministic
// scan; these tests prove it fires on a genuinely planted bad figure (the
// pre-registered falsifier) and stays quiet on a narrative that either cites
// the correct printed figure or discusses non-buildable square footage.
describe("findUnauthorizedBuildableFigures: the deterministic post-generation check", () => {
  const atomPrinted = { kind: "atom" as const, areaSqFt: 19_052, atomRef: "did:x" };
  const refused = { kind: "refused" as const, reason: "pending — buildable-envelope atom not yet on file" };

  it("FALSIFIER: fires on a planted figure that does not match the printed one", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "The buildable area is approximately 20,349 sq ft, well within the setback lines.",
      atomPrinted,
      30_000,
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("accepts a narrative that cites exactly the printed figure and its percent", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "The buildable envelope covers 19,052 sq ft, or 64% of the lot [geometry].",
      atomPrinted,
      30_000,
    );
    expect(offenders).toEqual([]);
  });

  it("fires on ANY buildable figure at all when the document prints none", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "The buildable envelope covers roughly 12,000 sq ft based on the setbacks on file.",
      refused,
      30_000,
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("passes when the narrative correctly says nothing prints and gives no figure", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "The buildable envelope has not been derived from an atom for this parcel yet, so no figure is available [geometry].",
      refused,
      30_000,
    );
    expect(offenders).toEqual([]);
  });

  it("NOT VACUOUS the other way: a legitimate lot-area or living-area figure outside any buildable sentence never trips it", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "The lot is 30,000 sq ft [geometry]. The home carries 1,820 sq ft of living area built in 1975 [parcelOwnership].",
      refused,
      30_000,
    );
    expect(offenders).toEqual([]);
  });

  it("catches a percent-only figure in a buildable sentence too", () => {
    const offenders = findUnauthorizedBuildableFigures(
      "Roughly 63% of the lot is buildable under the setbacks on file.",
      refused,
      30_000,
    );
    expect(offenders.length).toBeGreaterThan(0);
  });
});

describe("generateFeasibilityNarrative refuses a buildable-figure mismatch (P-159)", () => {
  function modelWithGeometry(printedBuildable: { kind: "atom"; areaSqFt: number; atomRef: string } | { kind: "refused"; reason: string }) {
    return {
      ...model,
      geometry: {
        status: "present",
        model: {
          summary: {
            printedBuildable,
            lotAreaSqFt: 30_000,
            address: undefined,
            countyName: "Bastrop County",
            elevationRangeMeters: { min: 100, max: 105 },
            verticalDatumSummary: "NAVD88 orthometric (USGS 3DEP)",
          },
          contourIntervalMeters: 0.5,
          setback: { honestAbsence: false, front: 15, side: 5, rear: 15, displayLine: "15 / 5 / 15" },
        },
      },
    } as unknown as import("../report-model.js").ParcelReportModel;
  }

  it("FALSIFIER: refuses (printed-figure-mismatch) a narrative that plants a wrong buildable figure", async () => {
    const m = modelWithGeometry({ kind: "atom", areaSqFt: 19_052, atomRef: "did:x" });
    const out = await generateFeasibilityNarrative(m, {
      client: clientReturning(
        "This lot supports a buildable envelope of about 20,349 sq ft under the setbacks on file [geometry].",
      ),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("printed-figure-mismatch");
  });

  it("accepts a narrative that cites the same printed figure the document prints", async () => {
    const m = modelWithGeometry({ kind: "atom", areaSqFt: 19_052, atomRef: "did:x" });
    const out = await generateFeasibilityNarrative(m, {
      client: clientReturning("This lot supports a buildable envelope of 19,052 sq ft [geometry]."),
    });
    expect(out.ok).toBe(true);
  });

  it("refuses ANY buildable figure when the document prints none (no atom on file)", async () => {
    const m = modelWithGeometry({ kind: "refused", reason: "pending — buildable-envelope atom not yet on file" });
    const out = await generateFeasibilityNarrative(m, {
      client: clientReturning("The buildable envelope covers about 12,000 sq ft based on the setbacks [geometry]."),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("printed-figure-mismatch");
  });

  it("still emits a complete report when the check is not tripped: no atom on file, and the narrative correctly states none", async () => {
    const m = modelWithGeometry({ kind: "refused", reason: "pending — buildable-envelope atom not yet on file" });
    const out = await generateFeasibilityNarrative(m, {
      client: clientReturning(
        "The buildable envelope has not been derived from an atom for this parcel yet [geometry].",
      ),
    });
    expect(out.ok).toBe(true);
  });
});
