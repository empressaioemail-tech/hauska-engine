/**
 * Engine top-level integration test for the mock branch.
 *
 * Covers:
 *   - all surviving findings carry stamped `finding:{submissionId}:{ulid}` atom ids
 *   - `producer === "mock"` and the clock honors the injected `now`
 *   - mock fixture does not emit the blocker without a code-section
 *   - mock fixture suppresses everything when neither code nor source is supplied
 *   - validator's stripped tokens accumulate on `invalidCitations`
 *   - discard rule trips when every citation gets stripped AND no elementRef
 *   - resolveFindingLlmMode default is `mock`, env-overridable to `anthropic`
 *   - anthropic mode without an injected client fails fast with a typed error
 *   - anthropic mode with a stub client round-trips through the validator
 *
 * No DB, no live network — the anthropic branch uses a hand-rolled
 * `Anthropic`-shaped stub so the engine call resolves deterministically.
 */

import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  generateFindings,
  resolveFindingLlmMode,
  FindingGeneratorError,
  type GenerateFindingsInput,
} from "../index";

function makeInput(
  overrides: Partial<GenerateFindingsInput> = {},
): GenerateFindingsInput {
  return {
    submission: {
      id: overrides.submission?.id ?? "sub-1",
      jurisdiction: overrides.submission?.jurisdiction ?? "Bastrop, TX",
      projectName: overrides.submission?.projectName ?? "Test Project",
      note: overrides.submission?.note ?? null,
    },
    briefingNarrative: overrides.briefingNarrative,
    sources: overrides.sources ?? [
      {
        id: "src-zoning",
        layerKind: "qgis-zoning",
        sourceKind: "manual-upload",
        provider: "Bastrop UDC",
        snapshotDate: "2026-01-01",
        note: null,
      },
    ],
    codeSections: overrides.codeSections ?? [
      {
        atomId: "code-bastrop-udc-4-3-2-b",
        label: "Bastrop UDC §4.3.2.B",
      },
    ],
    bimElements: overrides.bimElements ?? [
      { ref: "wall:north-side-l2", label: "North wall, L2" },
    ],
  };
}

describe("generateFindings (mock mode)", () => {
  it("returns findings with stamped atom ids of shape `finding:{submissionId}:{ulid}`", async () => {
    const fixedNow = new Date("2026-05-01T12:00:00.000Z");
    const result = await generateFindings(makeInput(), {
      mode: "mock",
      now: () => fixedNow,
      ulid: () => "ULIDABCDEF",
    });
    expect(result.producer).toBe("mock");
    expect(result.generatedAt).toEqual(fixedNow);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.atomId.startsWith("finding:sub-1:")).toBe(true);
      expect(f.aiGeneratedAt).toEqual(fixedNow);
    }
  });

  it("emits the blocker only when both a code-section and a briefing-source are provided", async () => {
    const result = await generateFindings(
      makeInput({
        codeSections: [],
        sources: [],
      }),
      { mode: "mock" },
    );
    // No code, no source → mock fixture has nothing to cite.
    expect(result.findings).toHaveLength(0);
  });

  it("emits the concern + advisory when only a code-section is provided", async () => {
    const result = await generateFindings(
      makeInput({ sources: [] }),
      { mode: "mock" },
    );
    const severities = result.findings.map((f) => f.severity).sort();
    // Blocker requires a source; concern + advisory only need code.
    expect(severities).toEqual(["advisory", "concern"]);
  });

  it("invalidCitations is empty when every citation resolves", async () => {
    const result = await generateFindings(makeInput(), { mode: "mock" });
    expect(result.invalidCitations).toEqual([]);
    expect(result.discardedFindings).toEqual([]);
  });

  it("stamps each finding with its submission id verbatim", async () => {
    const result = await generateFindings(
      makeInput({
        submission: {
          id: "sub-deadbeef-1234",
          jurisdiction: "Boulder, CO",
          projectName: null,
          note: null,
        },
      }),
      { mode: "mock" },
    );
    for (const f of result.findings) {
      expect(f.submissionId).toBe("sub-deadbeef-1234");
      expect(f.atomId.startsWith("finding:sub-deadbeef-1234:")).toBe(true);
    }
  });
});

describe("generateFindings: validator + discard pipeline", () => {
  /**
   * Construct a hand-rolled Anthropic client stub that returns one
   * canned text block. The text content is the raw JSON the engine's
   * parser will consume.
   */
  function makeStubClient(json: string): Anthropic {
    return {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: "text", text: json }],
        })),
      },
    } as unknown as Anthropic;
  }

  it("strips tokens whose ids are not in the input's reference blocks", async () => {
    const json = JSON.stringify({
      findings: [
        {
          severity: "blocker",
          category: "setback",
          text: `Cited rule [[CODE:code-real-1]] and bogus ref [[CODE:code-fake-999]] together.`,
          citations: [
            { kind: "code-section", atomId: "code-real-1" },
            { kind: "code-section", atomId: "code-fake-999" },
          ],
          confidence: 0.9,
          lowConfidence: false,
          elementRef: "wall:x",
          sourceRef: null,
        },
      ],
    });
    const result = await generateFindings(
      makeInput({
        codeSections: [{ atomId: "code-real-1", label: "Real Rule" }],
        bimElements: [{ ref: "wall:x", label: "Wall X" }],
      }),
      { mode: "anthropic", anthropicClient: makeStubClient(json) },
    );
    expect(result.findings).toHaveLength(1);
    const survivor = result.findings[0]!;
    expect(survivor.text).not.toContain("code-fake-999");
    expect(survivor.text).toContain("code-real-1");
    // Stripped citations are pruned from the surviving citations array.
    expect(survivor.citations).toEqual([
      { kind: "code-section", atomId: "code-real-1" },
    ]);
    expect(result.invalidCitations).toEqual(["[[CODE:code-fake-999]]"]);
  });

  it("discards a finding when every citation is stripped AND no elementRef anchors it", async () => {
    const json = JSON.stringify({
      findings: [
        {
          severity: "advisory",
          category: "other",
          text:
            // ≥50 chars after the token is stripped, so the discard
            // reason is "no_valid_citations_or_anchor", not too-short.
            `An entirely-fabricated citation [[CODE:code-bogus]] anchors this otherwise content-free advisory.`,
          citations: [{ kind: "code-section", atomId: "code-bogus" }],
          confidence: 0.4,
          lowConfidence: true,
          elementRef: null,
          sourceRef: null,
        },
      ],
    });
    const result = await generateFindings(
      makeInput({ codeSections: [], sources: [], bimElements: [] }),
      { mode: "anthropic", anthropicClient: makeStubClient(json) },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.discardedFindings).toHaveLength(1);
    expect(result.discardedFindings[0]!.reason).toBe(
      "no_valid_citations_or_anchor",
    );
    expect(result.invalidCitations).toEqual(["[[CODE:code-bogus]]"]);
  });

  it("survives a finding with no valid citations when elementRef anchors it", async () => {
    const json = JSON.stringify({
      findings: [
        {
          severity: "advisory",
          category: "other",
          text: `Reviewer should examine wall:x against the cited fragment [[CODE:code-bogus]].`,
          citations: [{ kind: "code-section", atomId: "code-bogus" }],
          confidence: 0.4,
          lowConfidence: true,
          elementRef: "wall:x",
          sourceRef: null,
        },
      ],
    });
    const result = await generateFindings(
      makeInput({
        codeSections: [],
        sources: [],
        bimElements: [{ ref: "wall:x", label: "Wall X" }],
      }),
      { mode: "anthropic", anthropicClient: makeStubClient(json) },
    );
    // The elementRef anchors the finding even though every citation
    // was stripped. The finding survives but its citations array is
    // empty (matches the cleaned text).
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.citations).toEqual([]);
    expect(result.findings[0]!.elementRef).toBe("wall:x");
    expect(result.discardedFindings).toEqual([]);
  });

  it("discards a finding whose post-strip text is shorter than FINDING_MIN_TEXT_LENGTH", async () => {
    const json = JSON.stringify({
      findings: [
        {
          severity: "advisory",
          category: "other",
          // After [[CODE:code-real]] is preserved, post-strip text
          // length is well under 50 chars.
          text: `Tiny [[CODE:code-real]].`,
          citations: [{ kind: "code-section", atomId: "code-real" }],
          confidence: 0.6,
          lowConfidence: false,
          elementRef: "wall:x",
          sourceRef: null,
        },
      ],
    });
    const result = await generateFindings(
      makeInput({
        codeSections: [{ atomId: "code-real", label: "Real Rule" }],
        bimElements: [{ ref: "wall:x", label: "Wall X" }],
      }),
      { mode: "anthropic", anthropicClient: makeStubClient(json) },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.discardedFindings).toHaveLength(1);
    expect(result.discardedFindings[0]!.reason).toBe("text_too_short");
  });
});

describe("resolveFindingLlmMode", () => {
  it("defaults to mock when AIR_FINDING_LLM_MODE is unset", () => {
    const original = process.env.AIR_FINDING_LLM_MODE;
    delete process.env.AIR_FINDING_LLM_MODE;
    try {
      expect(resolveFindingLlmMode()).toBe("mock");
    } finally {
      if (original !== undefined) process.env.AIR_FINDING_LLM_MODE = original;
    }
  });

  it("returns anthropic when AIR_FINDING_LLM_MODE === 'anthropic'", () => {
    const original = process.env.AIR_FINDING_LLM_MODE;
    process.env.AIR_FINDING_LLM_MODE = "anthropic";
    try {
      expect(resolveFindingLlmMode()).toBe("anthropic");
    } finally {
      if (original === undefined) delete process.env.AIR_FINDING_LLM_MODE;
      else process.env.AIR_FINDING_LLM_MODE = original;
    }
  });

  it("returns grok when AIR_FINDING_LLM_MODE === 'grok'", () => {
    const original = process.env.AIR_FINDING_LLM_MODE;
    process.env.AIR_FINDING_LLM_MODE = "grok";
    try {
      expect(resolveFindingLlmMode()).toBe("grok");
    } finally {
      if (original === undefined) delete process.env.AIR_FINDING_LLM_MODE;
      else process.env.AIR_FINDING_LLM_MODE = original;
    }
  });

  it("treats unknown env values as mock (defensive default)", () => {
    const original = process.env.AIR_FINDING_LLM_MODE;
    process.env.AIR_FINDING_LLM_MODE = "openai";
    try {
      expect(resolveFindingLlmMode()).toBe("mock");
    } finally {
      if (original === undefined) delete process.env.AIR_FINDING_LLM_MODE;
      else process.env.AIR_FINDING_LLM_MODE = original;
    }
  });
});

describe("generateFindings: anthropic mode error paths", () => {
  it("fails fast with a typed error when no client is injected", async () => {
    await expect(
      generateFindings(makeInput(), { mode: "anthropic" }),
    ).rejects.toBeInstanceOf(FindingGeneratorError);
    await expect(
      generateFindings(makeInput(), { mode: "anthropic" }),
    ).rejects.toMatchObject({ code: "anthropic_call_failed" });
  });
});

describe("generateFindings: grok mode error paths", () => {
  it("fails fast when no grok client is injected", async () => {
    await expect(
      generateFindings(makeInput(), { mode: "grok" }),
    ).rejects.toMatchObject({ code: "anthropic_call_failed" });
  });
});
