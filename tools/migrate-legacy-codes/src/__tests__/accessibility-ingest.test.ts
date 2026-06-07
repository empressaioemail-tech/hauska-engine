/**
 * Federal accessibility standards ingest — hermetic Path PDF tests.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAtomDid } from "@hauska-engine/atoms";
import type { PdfTextExtractor } from "@hauska-engine/corpus/adapters";
import { evaluate } from "@hauska-engine/corpus/eval";
import { InMemoryStorage } from "@hauska-engine/storage";

import { ADA_2010_FIXTURE_PAGES } from "../__fixtures__/ada-2010-pages.js";
import { FHA_DESIGN_MANUAL_FIXTURE_PAGES } from "../__fixtures__/fha-design-manual-pages.js";
import {
  ADA_2010_EDITION_LABEL,
  FEDERAL_ACCESSIBILITY_NORMALIZE_OPTIONS,
  FEDERAL_ACCESSIBILITY_TENANT,
  FHA_DESIGN_MANUAL_EDITION_LABEL,
} from "../accessibility-standards.js";
import {
  buildAda2010CuratedQueries,
  ADA_2010_QUALITY_BAR,
} from "../ada-2010-curated-queries.js";
import {
  buildFhaDesignManualCuratedQueries,
  FHA_DESIGN_MANUAL_QUALITY_BAR,
} from "../fha-design-manual-curated-queries.js";
import { runPathPdfIngest } from "../path-pdf-ingest.js";

const stubExtractor =
  (pages: ReadonlyArray<{ pageNumber: number; text: string }>): PdfTextExtractor =>
  async () => pages;

const STUB_PDF = (() => {
  const dir = mkdtempSync(join(tmpdir(), "hauska-accessibility-"));
  const path = join(dir, "stub.pdf");
  writeFileSync(path, "%PDF-1.4 stub\n");
  return path;
})();

describe("accessibility standards Path PDF ingest", () => {
  it("ingests ADA 2010 with public-free accessPolicy and passes curated eval", async () => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: FEDERAL_ACCESSIBILITY_TENANT,
      jurisdictionName: "Federal Accessibility Standards",
      editionLabel: ADA_2010_EDITION_LABEL,
      pdfUrl: "https://www.ada.gov/assets/pdfs/2010-design-standards.pdf",
      localPdfPath: STUB_PDF,
      textExtractor: stubExtractor(ADA_2010_FIXTURE_PAGES),
      capabilitiesName: "doj-ada-2010-pdf",
      normalizeOptions: FEDERAL_ACCESSIBILITY_NORMALIZE_OPTIONS,
      accessPolicy: "public-free",
    });

    expect(ingest.report.accessPolicy).toBe("public-free");
    expect(ingest.report.sectionsIngested).toBeGreaterThanOrEqual(5);
    expect(ingest.report.extractionQuality.hasMinimumViableStructure).toBe(
      true,
    );

    const queries = buildAda2010CuratedQueries();
    const sectionDids = new Set(
      ingest.atomization.sections.map((s) =>
        buildAtomDid("code-section", s.entityId).raw,
      ),
    );
    for (const q of queries) {
      expect(sectionDids.has(q.expectedAtomDid)).toBe(true);
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: FEDERAL_ACCESSIBILITY_TENANT,
      queries,
      thresholds: ADA_2010_QUALITY_BAR,
    });
    expect(report.passed).toBe(true);
    expect(report.scores.top3Score).toBe(1);
    expect(report.scores.sectionNumScore).toBe(1);
  });

  it("ingests FHA Design Manual with public-free accessPolicy and passes curated eval", async () => {
    const storage = new InMemoryStorage();
    const ingest = await runPathPdfIngest({
      storage,
      jurisdictionTenant: FEDERAL_ACCESSIBILITY_TENANT,
      jurisdictionName: "Federal Accessibility Standards",
      editionLabel: FHA_DESIGN_MANUAL_EDITION_LABEL,
      pdfUrl:
        "https://www.huduser.gov/portal/publications/PDF/FAIRHOUSING/fairfull.pdf",
      localPdfPath: STUB_PDF,
      textExtractor: stubExtractor(FHA_DESIGN_MANUAL_FIXTURE_PAGES),
      capabilitiesName: "hud-fha-design-manual-pdf",
      normalizeOptions: FEDERAL_ACCESSIBILITY_NORMALIZE_OPTIONS,
      accessPolicy: "public-free",
    });

    expect(ingest.report.accessPolicy).toBe("public-free");
    expect(ingest.report.sectionsIngested).toBeGreaterThanOrEqual(5);
    expect(ingest.report.extractionQuality.hasMinimumViableStructure).toBe(
      true,
    );

    const queries = buildFhaDesignManualCuratedQueries();
    const sectionDids = new Set(
      ingest.atomization.sections.map((s) =>
        buildAtomDid("code-section", s.entityId).raw,
      ),
    );
    for (const q of queries) {
      expect(sectionDids.has(q.expectedAtomDid)).toBe(true);
    }

    const report = await evaluate({
      storage,
      jurisdictionTenant: FEDERAL_ACCESSIBILITY_TENANT,
      queries,
      thresholds: FHA_DESIGN_MANUAL_QUALITY_BAR,
    });
    expect(report.passed).toBe(true);
    expect(report.scores.top3Score).toBe(1);
    expect(report.scores.sectionNumScore).toBe(1);
  });
});
