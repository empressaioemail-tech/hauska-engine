/**
 * Conformance suite for ADR-019 effective-rule composition (Lane E
 * E1.B). Covers the pure `composeEffectiveSection` algorithm across
 * every overlay operation and ordering case, plus the storage-backed
 * `resolveEffectiveRule` / `HybridRetrieval.resolveEffectiveRule` path
 * and the `getJurisdictionalOverlays` storage query it rests on.
 */

import { describe, expect, it } from "vitest";

import type {
  CodeSectionAtomInstance,
  JurisdictionalOverlayAmendmentInstance,
  OverlayOperation,
} from "@hauska-engine/atoms";
import { InMemoryStorage } from "@hauska-engine/storage";

import { composeEffectiveSection, resolveEffectiveRule } from "../effective-rule.js";
import { HybridRetrieval } from "../index.js";

const BASE_SECTION_ID = "icc/irc-2021/r301-2";

function baseSection(
  overrides: Partial<CodeSectionAtomInstance> = {},
): CodeSectionAtomInstance {
  return {
    entityType: "code-section",
    entityId: BASE_SECTION_ID,
    jurisdictionTenant: "icc",
    codeEditionId: "icc/irc-2021",
    sectionNumber: "R301.2",
    title: "Climatic and geographic design criteria",
    subsectionPath: null,
    bodyText: "Structural design shall meet the climatic design criteria.",
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "icc-viewer",
    sourceUrl: "https://codes.iccsafe.org/content/IRC2021/chapter-3",
    contentHash: "basehash1",
    ...overrides,
  };
}

function overlay(
  operation: OverlayOperation,
  overrides: Partial<JurisdictionalOverlayAmendmentInstance> = {},
): JurisdictionalOverlayAmendmentInstance {
  return {
    entityType: "code-amendment",
    entityId: `hutto_tx/overlay/irc-2021/r301-2/${operation}`,
    jurisdictionTenant: "hutto_tx",
    amendmentScope: "jurisdictional-overlay",
    ordinanceId: `O-2022-${operation}`,
    effectiveDate: "2022-09-15",
    authority: "Hutto City Council",
    affectedSectionIds: [BASE_SECTION_ID],
    amendmentText: `Section R301.2 is ${operation}d locally.`,
    baseEditionId: "icc/irc-2021",
    overlayOperation: operation,
    fetchedAt: "2026-05-21T00:00:00Z",
    sourceAdapter: "ecode360-html",
    sourceUrl: "https://ecode360.com/HU6354",
    contentHash: `overlayhash-${operation}`,
    ...overrides,
  };
}

describe("composeEffectiveSection — pure composition", () => {
  it("base section, no overlays → base-only, base text governs", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [],
    });
    expect(eff.resolution).toBe("base-only");
    expect(eff.baseTextGoverns).toBe(true);
    expect(eff.baseEditionId).toBe("icc/irc-2021");
    expect(eff.compositionNote).toContain("without local amendment");
  });

  it("no base, no overlays → base-only, base text does not govern", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: null,
      overlays: [],
    });
    expect(eff.resolution).toBe("base-only");
    expect(eff.baseTextGoverns).toBe(false);
  });

  it("modify overlay → modified, base text still governs", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [overlay("modify")],
    });
    expect(eff.resolution).toBe("modified");
    expect(eff.baseTextGoverns).toBe(true);
    expect(eff.overlays).toHaveLength(1);
  });

  it("replace overlay → replaced, base text no longer governs", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [overlay("replace")],
    });
    expect(eff.resolution).toBe("replaced");
    expect(eff.baseTextGoverns).toBe(false);
  });

  it("delete overlay → deleted, base text no longer governs", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [overlay("delete")],
    });
    expect(eff.resolution).toBe("deleted");
    expect(eff.baseTextGoverns).toBe(false);
  });

  it("add overlay with no base → added", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: null,
      overlays: [overlay("add")],
    });
    expect(eff.resolution).toBe("added");
    expect(eff.baseTextGoverns).toBe(false);
  });

  it("sorts overlays ascending by effectiveDate; latest drives resolution", () => {
    const early = overlay("modify", {
      entityId: "hutto_tx/overlay/a",
      effectiveDate: "2020-01-01",
    });
    const late = overlay("replace", {
      entityId: "hutto_tx/overlay/b",
      effectiveDate: "2023-01-01",
    });
    // Pass out of order — composition must sort.
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [late, early],
    });
    expect(eff.overlays.map((o) => o.effectiveDate)).toEqual([
      "2020-01-01",
      "2023-01-01",
    ]);
    expect(eff.resolution).toBe("replaced");
  });

  it("a replace anywhere in the chain stops base text governing even if the latest op is modify", () => {
    const replaceFirst = overlay("replace", {
      entityId: "hutto_tx/overlay/r",
      effectiveDate: "2021-01-01",
    });
    const modifyLater = overlay("modify", {
      entityId: "hutto_tx/overlay/m",
      effectiveDate: "2024-01-01",
    });
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [replaceFirst, modifyLater],
    });
    expect(eff.resolution).toBe("modified");
    expect(eff.baseTextGoverns).toBe(false);
  });

  it("composition note names the latest ordinance + operation", () => {
    const eff = composeEffectiveSection({
      jurisdictionTenant: "hutto_tx",
      baseSection: baseSection(),
      overlays: [overlay("modify")],
    });
    expect(eff.compositionNote).toContain("O-2022-modify");
    expect(eff.compositionNote).toContain("modify");
  });
});

describe("getJurisdictionalOverlays — storage query", () => {
  async function seeded(): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      baseSection(),
      overlay("modify", { entityId: "hutto_tx/o1", effectiveDate: "2022-01-01" }),
      overlay("replace", { entityId: "hutto_tx/o2", effectiveDate: "2020-01-01" }),
      // Different jurisdiction — must not be returned.
      overlay("modify", {
        entityId: "round_rock_tx/o1",
        jurisdictionTenant: "round_rock_tx",
      }),
      // Different base section — must not be returned.
      overlay("modify", {
        entityId: "hutto_tx/o-other",
        affectedSectionIds: ["icc/irc-2021/r302-1"],
      }),
    ]);
    return storage;
  }

  it("returns only the jurisdiction's overlays for the target base section, date-sorted", async () => {
    const storage = await seeded();
    const overlays = await storage.getJurisdictionalOverlays(
      "hutto_tx",
      BASE_SECTION_ID,
    );
    expect(overlays.map((o) => o.entityId)).toEqual([
      "hutto_tx/o2",
      "hutto_tx/o1",
    ]);
  });

  it("excludes temporal amendments", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([
      baseSection(),
      {
        entityType: "code-amendment",
        entityId: "hutto_tx/temporal-1",
        jurisdictionTenant: "hutto_tx",
        amendmentScope: "temporal",
        ordinanceId: "O-2023-temporal",
        effectiveDate: "2023-01-01",
        authority: "Hutto City Council",
        affectedSectionIds: [BASE_SECTION_ID],
        amendmentText: "Temporal amendment.",
        replacesSectionContentHash: null,
        fetchedAt: "2026-05-21T00:00:00Z",
        sourceAdapter: "ecode360-html",
        sourceUrl: "https://ecode360.com/HU6354",
        contentHash: "temphash",
      },
    ]);
    const overlays = await storage.getJurisdictionalOverlays(
      "hutto_tx",
      BASE_SECTION_ID,
    );
    expect(overlays).toHaveLength(0);
  });
});

describe("resolveEffectiveRule + HybridRetrieval — storage-backed", () => {
  it("resolves base section composed with a jurisdiction overlay", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([baseSection(), overlay("modify")]);

    const eff = await resolveEffectiveRule(storage, {
      jurisdictionTenant: "hutto_tx",
      baseSectionId: BASE_SECTION_ID,
    });
    expect(eff.baseSection?.sectionNumber).toBe("R301.2");
    expect(eff.resolution).toBe("modified");
    expect(eff.overlays).toHaveLength(1);
    expect(eff.baseTextGoverns).toBe(true);
  });

  it("HybridRetrieval.resolveEffectiveRule resolves base-only when no overlay exists", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([baseSection()]);
    const retrieval = new HybridRetrieval(storage);

    const eff = await retrieval.resolveEffectiveRule({
      jurisdictionTenant: "round_rock_tx",
      baseSectionId: BASE_SECTION_ID,
    });
    expect(eff.resolution).toBe("base-only");
    expect(eff.overlays).toHaveLength(0);
    expect(eff.baseSection?.sectionNumber).toBe("R301.2");
  });

  it("resolves to deleted when the jurisdiction strikes the base section", async () => {
    const storage = new InMemoryStorage();
    await storage.writeAtoms([baseSection(), overlay("delete")]);
    const retrieval = new HybridRetrieval(storage);

    const eff = await retrieval.resolveEffectiveRule({
      jurisdictionTenant: "hutto_tx",
      baseSectionId: BASE_SECTION_ID,
    });
    expect(eff.resolution).toBe("deleted");
    expect(eff.baseTextGoverns).toBe(false);
  });
});
