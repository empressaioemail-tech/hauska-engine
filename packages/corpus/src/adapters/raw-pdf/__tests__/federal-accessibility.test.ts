import { describe, expect, it } from "vitest";

import { buildCodeTree, reportExtractionQuality } from "../../../extraction/index.js";
import { pdfPagesToBlocks } from "../normalize.js";

const ADA_PAGE = {
  pageNumber: 41,
  text: [
    "ADA CHAPTER 1: APPLICATION AND ADMINISTRATION",
    "101.1 General. Accessibility requirements apply to sites and buildings.",
    "203.1 General. Exceptions to accessibility requirements apply here.",
    "404.2.3 Maneuvering Clearances. Doors shall comply.",
    "609.1 General. Grab bars shall comply.",
    "See Section 609.2 for grab bar specifications.",
    "206.2.1 Site Arrival Points. Accessible routes shall connect arrival points.",
  ].join("\n"),
};

const FHA_PAGE = {
  pageNumber: 40,
  text: [
    "PART TWO: CHAPTER 1",
    "1.10",
    "Accessible Primary Use Entrance",
    "See Section 1.3 for the accessible route requirement.",
    "PART TWO: CHAPTER 4",
    "4.1",
    "Accessible Route Into and Through the Covered Unit",
    "See Section 1.10 for entrances.",
  ].join("\n"),
};

describe("federal-accessibility heading convention", () => {
  it("walks ADA section numbers into a viable tree", () => {
    const blocks = pdfPagesToBlocks([ADA_PAGE], {
      headingConvention: "federal-accessibility",
    });
    const tree = buildCodeTree({
      metadata: {
        jurisdictionTenant: "federal-accessibility-standards",
        jurisdictionName: "Federal Accessibility Standards",
        editionLabel: "2010 ADA Standards for Accessible Design",
        publicationDate: "",
        sourceAdapter: "raw-pdf",
        sourceUrl: "https://example/ada.pdf",
        fetchedAt: new Date().toISOString(),
      },
      blocks,
    });
    const quality = reportExtractionQuality(tree);
    expect(quality.totalSections).toBeGreaterThanOrEqual(3);
    expect(quality.totalCrossReferences).toBeGreaterThan(0);
  });

  it("walks FHA chapter-decimal sections with title on the next line", () => {
    const blocks = pdfPagesToBlocks([FHA_PAGE], {
      headingConvention: "federal-accessibility",
    });
    const tree = buildCodeTree({
      metadata: {
        jurisdictionTenant: "federal-accessibility-standards",
        jurisdictionName: "Federal Accessibility Standards",
        editionLabel: "Fair Housing Act Design Manual (April 1998)",
        publicationDate: "",
        sourceAdapter: "raw-pdf",
        sourceUrl: "https://example/fha.pdf",
        fetchedAt: new Date().toISOString(),
      },
      blocks,
    });
    const quality = reportExtractionQuality(tree);
    expect(quality.totalSections).toBeGreaterThan(1);
    expect(quality.totalCrossReferences).toBeGreaterThan(0);
  });
});
