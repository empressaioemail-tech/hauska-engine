import { describe, expect, it } from "vitest";

import {
  WEB_BLOCK_CLOSE,
  WEB_BLOCK_OPEN,
  extractWebFindings,
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
