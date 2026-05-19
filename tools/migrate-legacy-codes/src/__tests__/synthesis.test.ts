import { describe, expect, it } from "vitest";

import { transformBatch } from "../transform.js";
import {
  buildEditionLabelMap,
  buildJurisdictionDisplayNames,
} from "../edition-labels.js";
import { synthesizeEditionsAndCorpora } from "../synthesize-editions.js";
import {
  buildSectionsByEdition,
  sniffCrossReferences,
} from "../synthesize-xrefs.js";
import { ALL_ROWS, SOURCE_NAME_BY_ID } from "./fixtures.js";

describe("synthesize-editions", () => {
  it("emits one edition per (jurisdiction, codeBook) and one corpus per jurisdiction", () => {
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const result = synthesizeEditionsAndCorpora({
      sections: transformed.instances,
      editionLabels: buildEditionLabelMap(),
      jurisdictionDisplayNames: buildJurisdictionDisplayNames(),
    });

    // Bastrop has 1 book; Grand County has 2 (IRC + IWUIC).
    expect(result.editions.length).toBe(3);
    expect(result.corpora.length).toBe(2);

    const bastropCorpus = result.corpora.find(
      (c) => c.jurisdictionTenant === "bastrop_tx",
    );
    expect(bastropCorpus).toBeDefined();
    expect(bastropCorpus!.adoptedEditionIds.length).toBe(1);

    const gcCorpus = result.corpora.find(
      (c) => c.jurisdictionTenant === "grand_county_ut",
    );
    expect(gcCorpus).toBeDefined();
    expect(gcCorpus!.adoptedEditionIds.length).toBe(2);
  });

  it("populates editionLabel via the legacy snapshot", () => {
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const result = synthesizeEditionsAndCorpora({
      sections: transformed.instances,
      editionLabels: buildEditionLabelMap(),
      jurisdictionDisplayNames: buildJurisdictionDisplayNames(),
    });
    const labels = result.editions.map((e) => e.editionLabel);
    expect(labels).toContain("City of Bastrop — Code of Ordinances");
    expect(labels).toContain(
      "2021 IRC Table 301.2(1) — Climatic & Geographic Design Criteria",
    );
    expect(labels).toContain("2006 International Wildland-Urban Interface Code");
  });

  it("emits composition links from corpus -> edition and edition -> section", () => {
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const result = synthesizeEditionsAndCorpora({
      sections: transformed.instances,
      editionLabels: buildEditionLabelMap(),
      jurisdictionDisplayNames: buildJurisdictionDisplayNames(),
    });
    const corpusToEdition = result.compositionLinks.filter(
      (l) =>
        l.fromEntityType === "jurisdiction-corpus" &&
        l.toEntityType === "code-edition",
    );
    const editionToSection = result.compositionLinks.filter(
      (l) =>
        l.fromEntityType === "code-edition" &&
        l.toEntityType === "code-section",
    );
    expect(corpusToEdition.length).toBe(3); // bastrop:1 + grand:2
    expect(editionToSection.length).toBe(transformed.instances.length);
  });
});

describe("synthesize-xrefs", () => {
  it("sniffs § references out of body text and resolves them to section atoms", () => {
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const sectionsByEdition = buildSectionsByEdition(transformed.instances);
    const result = sniffCrossReferences({
      sections: transformed.instances,
      sectionsByEdition,
    });
    // Chapter 14 body cites § 14.5 and § 14.10.
    const chapter14Xrefs = result.crossReferences.filter((x) =>
      x.fromSectionId.endsWith("chapter-14"),
    );
    expect(chapter14Xrefs.length).toBeGreaterThanOrEqual(2);

    // At least one xref should resolve to a target section.
    const resolved = result.crossReferences.filter((x) => x.toSectionId !== "");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
  });

  it("drops cross-references whose target does not resolve in-corpus", () => {
    // Post-2026-05-19 policy: synthesize-xrefs only emits xrefs that
    // resolve to an actual in-corpus section. Refs to external codes
    // (IRC §X, IBC §Y) or to non-existent subsection labels are not
    // emitted. The fixture's Section 504 body cites "Section 504.1"
    // but no Section 504.1 atom exists in the corpus — that ref is
    // dropped + counted in unresolvedCount.
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const sectionsByEdition = buildSectionsByEdition(transformed.instances);
    const result = sniffCrossReferences({
      sections: transformed.instances,
      sectionsByEdition,
    });
    // Every emitted xref must have a non-empty toSectionId.
    for (const xref of result.crossReferences) {
      expect(xref.toSectionId.length).toBeGreaterThan(0);
    }
    // Some refs in the fixture point to "Section 504.1" which doesn't
    // resolve; those should land in unresolvedCount.
    expect(result.unresolvedCount).toBeGreaterThan(0);
  });

  it("emits resolved atom-link edges with the right link type taxonomy", () => {
    const transformed = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const sectionsByEdition = buildSectionsByEdition(transformed.instances);
    const result = sniffCrossReferences({
      sections: transformed.instances,
      sectionsByEdition,
    });
    // Most legacy bodies use "See § X.YZ" -> "see-also".
    const linkTypes = new Set(result.links.map((l) => l.linkType));
    expect(linkTypes.has("see-also")).toBe(true);
  });
});
