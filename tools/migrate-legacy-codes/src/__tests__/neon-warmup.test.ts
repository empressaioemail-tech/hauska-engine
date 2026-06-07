import { describe, expect, it } from "vitest";

import type { CodeEditionAtomInstance, CodeSectionAtomInstance } from "@hauska-engine/atoms";
import type { CorpusSnapshot } from "@hauska-engine/storage";

import {
  exportJurisdictionFromSnapshot,
  sectionToJsonlRow,
} from "../snapshot-to-legacy-jsonl.js";
import { ldtContentHash, SUBSTRATE_CODE_BOOK } from "../neon-warmup-types.js";

const edition: CodeEditionAtomInstance = {
  entityType: "code-edition",
  entityId: "round_rock_tx/round-rock-zoning-and-development-code-current-supplement",
  jurisdictionTenant: "round_rock_tx",
  editionLabel: "Round Rock Zoning and Development Code (current supplement)",
  effectiveFrom: "2026-05-26T15:01:39.303Z",
  effectiveTo: null,
  sectionIds: [],
  amendmentIds: [],
  fetchedAt: "2026-05-26T15:01:39.303Z",
  sourceAdapter: "municode-html",
  sourceUrl: "https://library.municode.com/tx/round_rock/codes/code_of_ordinances",
  contentHash: "abc",
};

const sectionWithBody: CodeSectionAtomInstance = {
  entityType: "code-section",
  entityId: "round_rock_tx/round-rock-zoning-and-development-code-current-supplement/1-1",
  jurisdictionTenant: "round_rock_tx",
  codeEditionId: edition.entityId,
  sectionNumber: "1-1",
  title: "Title",
  subsectionPath: null,
  bodyText: "Normative text.",
  fetchedAt: "2026-05-26T15:01:39.303Z",
  sourceAdapter: "municode-html",
  sourceUrl: "https://library.municode.com/tx/round_rock/codes/code_of_ordinances",
  contentHash: "def",
};

const sectionEmpty: CodeSectionAtomInstance = {
  ...sectionWithBody,
  entityId: "round_rock_tx/round-rock-zoning-and-development-code-current-supplement/1",
  sectionNumber: "1",
  bodyText: "",
};

function miniSnapshot(): CorpusSnapshot {
  return {
    format: "hauska-corpus-snapshot/1",
    generatedAt: "2026-05-26T17:26:12.400Z",
    atoms: [edition, sectionWithBody, sectionEmpty],
    links: [],
    jurisdictionStatus: [],
  };
}

describe("neon warmup export", () => {
  it("skips sections with empty bodyText", () => {
    const row = sectionToJsonlRow(sectionEmpty, edition.editionLabel);
    expect(row).toBeNull();
  });

  it("uses LDT content_hash joiner semantics", () => {
    const row = sectionToJsonlRow(sectionWithBody, edition.editionLabel);
    expect(row).not.toBeNull();
    expect(row!.content_hash).toBe(
      ldtContentHash([
        "round_rock_tx",
        SUBSTRATE_CODE_BOOK,
        edition.editionLabel,
        "1-1",
        "Normative text.",
      ]),
    );
  });

  it("exportJurisdictionFromSnapshot matches withBody counts", () => {
    const { rows, stats } = exportJurisdictionFromSnapshot(
      miniSnapshot(),
      "round_rock_tx",
    );
    expect(stats.sectionsTotal).toBe(2);
    expect(stats.rowsExported).toBe(1);
    expect(stats.rowsSkippedEmptyBody).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_book).toBe(SUBSTRATE_CODE_BOOK);
  });
});
