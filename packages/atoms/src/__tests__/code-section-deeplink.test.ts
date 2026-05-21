/**
 * Conformance suite for the ADR-019 `code-section` deep-link extension
 * (Lane E E1.C). A Layer 1 model-code base section on the interim
 * deep-link footing carries `verbatimTextDeepLink` — its verbatim
 * normative text is deep-linked, not hosted, and `bodyText` holds the
 * reasoning layer. A hosted (Layer 2 / Layer 3) section leaves the
 * field absent and `bodyText` is the verbatim text.
 */

import { describe, expect, it } from "vitest";

import { bootstrapEngineAtomRegistry, type InstanceLookup } from "../registry.js";
import {
  CODE_SECTION_SCHEMA,
  isDeepLinkFootingSection,
  type CodeSectionAtomInstance,
} from "../instances.js";

function hostedSection(
  overrides: Partial<CodeSectionAtomInstance> = {},
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId: "hutto_tx/hutto-udc/10-101",
    jurisdictionTenant: "hutto_tx",
    codeEditionId: "hutto_tx/hutto-udc-march-2024",
    sectionNumber: "10.101",
    title: "Purpose",
    subsectionPath: null,
    bodyText: "This Unified Development Code is adopted to promote ...",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "hutto-udc-pdf",
    sourceUrl: "https://www.huttotx.gov/DocumentCenter/View/3779",
    contentHash: "hostedhash1",
    ...overrides,
  };
}

function deepLinkSection(
  overrides: Partial<CodeSectionAtomInstance> = {},
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId: "icc/irc-2021/r301-2",
    jurisdictionTenant: "icc",
    codeEditionId: "icc/irc-2021",
    sectionNumber: "R301.2",
    title: "Climatic and geographic design criteria",
    subsectionPath: null,
    // Reasoning layer, NOT the verbatim normative text.
    bodyText:
      "Establishes that structural design must meet locally adopted " +
      "climatic and geographic criteria; the jurisdiction supplies the " +
      "ground snow load, wind speed, seismic category and related values.",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "icc-viewer",
    sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1",
    contentHash: "deeplinkhash1",
    verbatimTextDeepLink:
      "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning#IRC2021P1_Ch03_SecR301.2",
    ...overrides,
  };
}

function lookupFor(inst: CodeSectionAtomInstance): InstanceLookup {
  return {
    async get(entityType, entityId) {
      if (entityType === "code-section" && entityId === inst.entityId) {
        return inst as never;
      }
      return null;
    },
  };
}

function resolveOrThrow(
  registry: ReturnType<typeof bootstrapEngineAtomRegistry>,
  entityType: string,
) {
  const result = registry.resolve(entityType);
  if (!result.ok) throw result.error;
  return result.registration;
}

describe("code-section — deep-link schema", () => {
  it("accepts a hosted section with no verbatimTextDeepLink", () => {
    expect(CODE_SECTION_SCHEMA.safeParse(hostedSection()).success).toBe(true);
  });

  it("accepts a deep-link-footing section with a URL", () => {
    expect(CODE_SECTION_SCHEMA.safeParse(deepLinkSection()).success).toBe(true);
  });

  it("rejects a non-URL verbatimTextDeepLink", () => {
    const bad = deepLinkSection({ verbatimTextDeepLink: "not-a-url" });
    expect(CODE_SECTION_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty codeEditionId", () => {
    expect(
      CODE_SECTION_SCHEMA.safeParse(hostedSection({ codeEditionId: "" }))
        .success,
    ).toBe(false);
  });
});

describe("code-section — isDeepLinkFootingSection", () => {
  it("is true for a Layer 1 deep-link section", () => {
    expect(isDeepLinkFootingSection(deepLinkSection())).toBe(true);
  });

  it("is false for a hosted section", () => {
    expect(isDeepLinkFootingSection(hostedSection())).toBe(false);
  });

  it("is false when the deep-link is an empty string", () => {
    expect(
      isDeepLinkFootingSection(hostedSection({ verbatimTextDeepLink: "" })),
    ).toBe(false);
  });
});

describe("code-section — @ts-expect-error widening rejection", () => {
  it("rejects a non-string verbatimTextDeepLink at compile time", () => {
    // @ts-expect-error — verbatimTextDeepLink is a string when present
    const bad: CodeSectionAtomInstance = { ...hostedSection(), verbatimTextDeepLink: 42 };
    void bad;
    expect(true).toBe(true);
  });
});

describe("code-section — registry registration is unchanged", () => {
  it("resolves a hosted section to a contextSummary", async () => {
    const inst = hostedSection();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "code-section");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.typed.sectionNumber).toBe("10.101");
  });

  it("resolves a deep-link section to a contextSummary", async () => {
    const inst = deepLinkSection();
    const registry = bootstrapEngineAtomRegistry({ lookup: lookupFor(inst) });
    const reg = resolveOrThrow(registry, "code-section");
    const summary = await reg.contextSummary(inst.entityId, { audience: "ai" });
    expect(summary.typed.sectionNumber).toBe("R301.2");
    expect(summary.typed.codeEditionId).toBe("icc/irc-2021");
  });
});
