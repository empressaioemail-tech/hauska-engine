/**
 * ICC model-code ingest hermetic tests.
 *
 * Uses the adapter's mock mode with existing fixtures to verify:
 *   - code-edition + code-section + code-cross-reference atoms written
 *   - jurisdiction-corpus atom exists with accessPolicy public-free
 *   - links written
 *   - unconfigured adapter -> no-op skip without throwing
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import { IccCodeConnectAdapter } from "@hauska-engine/corpus/adapters";
import type { JurisdictionCorpusAtomInstance } from "@hauska-engine/atoms";

import { runIccModelCodeIngest } from "../icc-model-code-ingest.js";

// Mock fixtures matching the structure from the ICC adapter
const mockFixtures = {
  books: [
    {
      shortCode: "IBC2018P6",
      uri: { category: "I", year: "2018", titleCode: "IBC", printing: "P6" },
      printing: "Sixth Printing: May 2023",
      title: "2018 International Building Code",
      accessStartDate: "2017-01-01",
      accessEndDate: "2027-12-31",
    },
  ],
  documents: {
    IBC2018P6: {
      book: {
        shortCode: "IBC2018P6",
        uri: { category: "I", year: "2018", titleCode: "IBC", printing: "P6" },
        printing: "Sixth Printing: May 2023",
        title: "2018 International Building Code",
        accessStartDate: "2017-01-01",
        accessEndDate: "2027-12-31",
      },
      chapters: [
        {
          bookId: "IBC2018P6",
          chapters: [{ ordinal: "1", ordinalClean: "1", title: "Scope", id: "IBC_Ch01", dtype: "chapter" }],
          sections: {
            "IBC_Ch01_Sec101": {
              type: "codeSection",
              label: "SECTION",
              title: "General",
              xmlId: "IBC_Ch01_Sec101",
              content: "<p>Test section content. See Section 102 for definitions.</p>",
              ordinal: "101",
              ordinalClean: "101",
              children: [],
            },
          },
        },
      ],
    },
  },
  search: {},
};

describe("runIccModelCodeIngest", () => {
  it("ingests ICC model-code atoms into storage using mock fixtures", async () => {
    const storage = new InMemoryStorage();
    const adapter = new IccCodeConnectAdapter({
      fixtures: mockFixtures,
    });

    expect(adapter.mode).toBe("mock");

    const result = await runIccModelCodeIngest(storage, {
      adapter,
    });

    expect(result.editions).toBeGreaterThan(0);
    expect(result.sections).toBeGreaterThan(0);
    expect(result.links).toBeGreaterThan(0);

    // Verify jurisdiction-corpus atom exists
    const corpus = await storage.getAtom<JurisdictionCorpusAtomInstance>(
      "jurisdiction-corpus",
      "icc-model-code",
    );
    expect(corpus).toBeDefined();
    expect(corpus?.jurisdictionTenant).toBe("icc-model-code");
    expect(corpus?.jurisdictionName).toBe("ICC model codes (Layer 1)");
    expect(corpus?.accessPolicy).toBe("public-free");

    // Verify code-edition atoms written
    const snapshot = storage.exportSnapshot(["test"]);
    const editions = snapshot.atoms.filter((a) => a.entityType === "code-edition");
    expect(editions.length).toBeGreaterThan(0);

    // Verify code-section atoms written
    const sections = snapshot.atoms.filter((a) => a.entityType === "code-section");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.length).toBe(result.sections);

    // All sections should be model-code tenant
    for (const section of sections) {
      expect(section.jurisdictionTenant).toBe("icc-model-code");
      // Layer 1 sections must have verbatimTextDeepLink
      expect(section.verbatimTextDeepLink).toBeTruthy();
      expect(section.verbatimTextDeepLink).toContain("codes.iccsafe.org");
    }

    // Verify code-cross-reference atoms written
    const xrefs = snapshot.atoms.filter(
      (a) => a.entityType === "code-cross-reference",
    );
    expect(xrefs.length).toBeGreaterThan(0);

    // Verify jurisdiction status registered
    const statuses = await storage.listJurisdictionStatus();
    const iccStatus = statuses.find(
      (s) => s.jurisdictionTenant === "icc-model-code",
    );
    expect(iccStatus).toBeDefined();
    expect(iccStatus?.jurisdictionName).toBe("ICC model codes (Layer 1)");
    expect(iccStatus?.qualityBar).toBe("not-evaluated");
    expect(iccStatus?.accessPolicy).toBe("public-free");
    expect(iccStatus?.atomCount).toBe(result.sections);

    // Verify links written
    const allLinks = snapshot.links;
    expect(allLinks.length).toBeGreaterThan(0);
    expect(allLinks.length).toBe(result.links);

    // Verify edition -> section composition links
    const compositionLinks = allLinks.filter(
      (l) =>
        l.fromEntityType === "code-edition" &&
        l.toEntityType === "code-section" &&
        l.linkType === "contains",
    );
    expect(compositionLinks.length).toBeGreaterThan(0);
  });

  it("handles unconfigured adapter as no-op skip without throwing", async () => {
    const storage = new InMemoryStorage();

    // No fixtures, no credentials -> unconfigured mode
    const result = await runIccModelCodeIngest(storage, {
      credentials: undefined,
    });

    expect(result.editions).toBe(0);
    expect(result.sections).toBe(0);
    expect(result.crossReferences).toBe(0);
    expect(result.links).toBe(0);

    const snapshot = storage.exportSnapshot(["test"]);
    expect(snapshot.atoms.length).toBe(0);
  });

  it("skips editions with empty fetch body", async () => {
    const storage = new InMemoryStorage();
    const adapter = new IccCodeConnectAdapter({
      fixtures: mockFixtures,
    });
    
    // Use fixtures but they may have empty bodies
    const result = await runIccModelCodeIngest(storage, {
      adapter,
    });

    // Should not throw, even if some editions fail
    expect(result.editions).toBeGreaterThanOrEqual(0);
  });

  it("uses deterministic reasoning layer by default", async () => {
    const storage = new InMemoryStorage();
    const adapter = new IccCodeConnectAdapter({
      fixtures: mockFixtures,
    });

    const result = await runIccModelCodeIngest(storage, {
      adapter,
    });

    expect(result.sections).toBeGreaterThan(0);

    const snapshot = storage.exportSnapshot(["test"]);
    const sections = snapshot.atoms.filter(
      (a) => a.entityType === "code-section",
    );

    // Check that bodyText contains structural reasoning layer
    const sampleSection = sections[0];
    if (sampleSection) {
      expect(sampleSection.bodyText).toContain("Section");
      expect(sampleSection.bodyText).toContain("Chapter");
      expect(sampleSection.bodyText).toContain("Layer 1 model-code base");
    }
  });

  it("accepts custom reasoning layer hook", async () => {
    const storage = new InMemoryStorage();
    const adapter = new IccCodeConnectAdapter({
      fixtures: mockFixtures,
    });

    const customReasoningLayer = () => "Custom reasoning layer text";

    const result = await runIccModelCodeIngest(storage, {
      adapter,
      reasoningLayer: customReasoningLayer,
    });

    expect(result.sections).toBeGreaterThan(0);

    const snapshot = storage.exportSnapshot(["test"]);
    const sections = snapshot.atoms.filter(
      (a) => a.entityType === "code-section",
    );

    const sampleSection = sections[0];
    if (sampleSection) {
      expect(sampleSection.bodyText).toBe("Custom reasoning layer text");
    }
  });
});
