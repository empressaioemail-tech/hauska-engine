/**
 * Direct unit coverage for `buildCodeTree()`'s heading-label parsing
 * (`splitHeadingLabel()`, not exported — exercised via `buildCodeTree()`
 * against hand-built `NormalizedBlock` streams).
 *
 * Regression guard for the 2026-08-04 OPS-9 S3 Smithville eval fix: two
 * distinct defects combined to silently drop every eCode360 section's
 * title before atomization —
 *
 *   1. `splitHeadingLabel()`'s "§ N.NN.NNN <title>" regex only consumed
 *      an em/en-dash or hyphen as the number/title separator, never a
 *      bare colon. eCode360's `data-full-title` uses a colon
 *      ("§ 1.08.037: General regulations."), so the colon fell into the
 *      title capture group, leaving every parsed title prefixed with a
 *      stray ": ".
 *   2. The eCode360 adapter set `block.label` to the bare number only
 *      ("§ 1.08.037", no title) while `block.text` carried the full
 *      string. `buildCodeTree()` prefers `label` over `text` when
 *      present, so the title was dropped entirely, not just malformed.
 *      Fixed at the extractor level too (falls back to `text` when
 *      `label`'s own parse yields an empty title) so already-captured
 *      artifacts (frozen before the adapter fix) are also covered.
 */

import { describe, expect, it } from "vitest";

import type { NormalizedCode } from "../../adapters/types.js";
import { buildCodeTree } from "../extractor.js";
import type { SectionNode } from "../types.js";

function normalizedFromBlocks(
  blocks: NormalizedCode["blocks"],
): NormalizedCode {
  return {
    metadata: {
      jurisdictionTenant: "test_tx",
      jurisdictionName: "Test, TX",
      editionLabel: "Test Code",
      publicationDate: "",
      sourceAdapter: "test",
      sourceUrl: "https://example.test",
      fetchedAt: new Date().toISOString(),
    },
    blocks,
  };
}

function firstSection(tree: ReturnType<typeof buildCodeTree>): SectionNode {
  const section = tree.children
    .flatMap(function collect(node): SectionNode[] {
      const self = node.kind === "section" ? [node as SectionNode] : [];
      const children = "children" in node ? node.children : [];
      return [...self, ...children.flatMap(collect)];
    })
    .find(() => true);
  if (!section) throw new Error("no section node found in tree");
  return section;
}

describe("buildCodeTree() — splitHeadingLabel colon separator", () => {
  it("parses a colon-separated 'label' heading (eCode360 data-full-title shape) with no stray ':' prefix on the title", () => {
    const normalized = normalizedFromBlocks([
      {
        kind: "heading",
        depth: 5,
        text: "§ 1.08.037: General regulations.",
        label: "§ 1.08.037: General regulations.",
      },
      { kind: "paragraph", text: "No person shall discharge a firearm." },
    ]);
    const tree = buildCodeTree(normalized, {
      headingDepthSchema: { 5: "section" },
    });
    const section = firstSection(tree);
    expect(section.sectionNumber).toBe("1.08.037");
    expect(section.title).toBe("General regulations.");
    expect(section.title.startsWith(":")).toBe(false);
  });

  it("still parses a dash-separated heading (Municode/PDF shape) correctly", () => {
    const normalized = normalizedFromBlocks([
      { kind: "heading", depth: 5, text: "§ 5.04 — Setbacks", label: "§ 5.04 — Setbacks" },
      { kind: "paragraph", text: "Setback distances apply per the table below." },
    ]);
    const tree = buildCodeTree(normalized, {
      headingDepthSchema: { 5: "section" },
    });
    const section = firstSection(tree);
    expect(section.sectionNumber).toBe("5.04");
    expect(section.title).toBe("Setbacks");
  });
});

describe("buildCodeTree() — label/text title-recovery fallback", () => {
  it("recovers the title from `text` when `label` is a bare, title-less locator (already-captured eCode360 artifact shape)", () => {
    const normalized = normalizedFromBlocks([
      {
        kind: "heading",
        depth: 5,
        text: "§ 5.05.001: General requirements.",
        // Bare label — no title after the number. This is the shape an
        // eCode360 artifact captured before the adapter fix carries.
        label: "§ 5.05.001",
      },
      { kind: "paragraph", text: "All persons, firms or corporations..." },
    ]);
    const tree = buildCodeTree(normalized, {
      headingDepthSchema: { 5: "section" },
    });
    const section = firstSection(tree);
    expect(section.sectionNumber).toBe("5.05.001");
    expect(section.title).toBe("General requirements.");
  });

  it("prefers `label` over `text` when `label` itself parses to a non-empty title", () => {
    const normalized = normalizedFromBlocks([
      {
        kind: "heading",
        depth: 5,
        text: "This text should not be used",
        label: "§ 9.01 Real title",
      },
      { kind: "paragraph", text: "Body." },
    ]);
    const tree = buildCodeTree(normalized, {
      headingDepthSchema: { 5: "section" },
    });
    const section = firstSection(tree);
    expect(section.sectionNumber).toBe("9.01");
    expect(section.title).toBe("Real title");
  });
});
