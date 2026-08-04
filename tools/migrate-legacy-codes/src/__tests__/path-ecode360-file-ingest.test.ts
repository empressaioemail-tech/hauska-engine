/**
 * OPS-9 S3 ingest — depth-schema + orchestrator tests for the eCode360
 * File path, run against `__fixtures__/smithville-ecode360-slice.json`
 * (an 81-block real slice cut from
 * `smithville-normalized-2026-08-04.json`: the depth-1 synthetic ToC
 * heading, Division 1 + Division 2 in full — depth-3 headings with
 * their depth-5 sections — and the Part I / Part II depth-4 slice with
 * its depth-5 sections). CI never needs the full 1.3MB artifact; this
 * fixture is committed and small (21.8KB).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { NormalizedCode } from "@hauska-engine/corpus/adapters";
import { buildCodeTree } from "@hauska-engine/corpus/extraction";
import { InMemoryStorage } from "@hauska-engine/storage";

import {
  ECODE360_DEPTH_SCHEMA,
  runPathEcode360FileIngest,
} from "../path-ecode360-file-ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE: NormalizedCode = JSON.parse(
  readFileSync(
    join(__dirname, "..", "__fixtures__", "smithville-ecode360-slice.json"),
    "utf-8",
  ),
) as NormalizedCode;

describe("ECODE360_DEPTH_SCHEMA", () => {
  it("maps depth 5 to 'section' — the load-bearing mapping (836 of 845 headings in the full artifact)", () => {
    expect(ECODE360_DEPTH_SCHEMA?.[5]).toBe("section");
  });

  it("maps every depth present in the fixture to a schema entry (no depth falls through to the section-of-last-resort default)", () => {
    const depthsInFixture = new Set(
      FIXTURE.blocks
        .filter((b) => b.kind === "heading")
        .map((b) => (b as { depth: number }).depth),
    );
    expect(depthsInFixture).toEqual(new Set([1, 3, 4, 5]));
    for (const d of depthsInFixture) {
      expect(ECODE360_DEPTH_SCHEMA?.[d]).toBeDefined();
    }
  });

  it("buildCodeTree() yields structural kind 'section' for every depth-5 heading in the fixture, preserving all 23 sections", () => {
    const tree = buildCodeTree(FIXTURE, {
      headingDepthSchema: ECODE360_DEPTH_SCHEMA,
    });

    function collectSections(
      nodes: ReadonlyArray<{ kind: string; children?: unknown[] }>,
    ): Array<{ kind: string }> {
      const out: Array<{ kind: string }> = [];
      for (const n of nodes) {
        if (n.kind === "section") out.push(n);
        if (Array.isArray(n.children)) {
          out.push(
            ...collectSections(
              n.children as ReadonlyArray<{ kind: string; children?: unknown[] }>,
            ),
          );
        }
      }
      return out;
    }

    const sections = collectSections(
      tree.children as ReadonlyArray<{ kind: string; children?: unknown[] }>,
    );
    const depth5Count = FIXTURE.blocks.filter(
      (b) => b.kind === "heading" && (b as { depth: number }).depth === 5,
    ).length;
    expect(depth5Count).toBe(23);
    expect(sections).toHaveLength(23);
    for (const s of sections) expect(s.kind).toBe("section");
  });

  /**
   * The fixture's only depth-1 heading is the synthetic whole-document
   * "Table of Contents - ..." heading, which `buildCodeTree()`'s stack
   * logic keeps open as the root chapter container for everything that
   * follows (depth 3/4/5 all nest *inside* it, not as root-level
   * siblings) — this is pre-existing `buildCodeTree()` stack behavior,
   * unrelated to this schema; the walk below matches that shape rather
   * than assuming a flat root.
   */
  function collectByKind(
    nodes: ReadonlyArray<{ kind: string; children?: unknown[] }>,
    kind: string,
  ): Array<{ kind: string; children?: unknown[] }> {
    const out: Array<{ kind: string; children?: unknown[] }> = [];
    for (const n of nodes) {
      if (n.kind === kind) out.push(n);
      if (Array.isArray(n.children)) {
        out.push(
          ...collectByKind(
            n.children as ReadonlyArray<{ kind: string; children?: unknown[] }>,
            kind,
          ),
        );
      }
    }
    return out;
  }

  it("buildCodeTree() nests depth-5 sections under depth-3 division containers (Division 1 / Division 2), not flattened past them", () => {
    const tree = buildCodeTree(FIXTURE, {
      headingDepthSchema: ECODE360_DEPTH_SCHEMA,
    });
    const divisions = collectByKind(
      tree.children as ReadonlyArray<{ kind: string; children?: unknown[] }>,
      "division",
    );
    expect(divisions).toHaveLength(2);
    for (const div of divisions) {
      expect(
        (div.children ?? []).some(
          (c) => (c as { kind: string }).kind === "section",
        ),
      ).toBe(true);
    }
  });

  it("buildCodeTree() nests the Part I / Part II depth-4 headings as 'article' containers, each carrying their own sections", () => {
    const tree = buildCodeTree(FIXTURE, {
      headingDepthSchema: ECODE360_DEPTH_SCHEMA,
    });
    const articles = collectByKind(
      tree.children as ReadonlyArray<{ kind: string; children?: unknown[] }>,
      "article",
    );
    expect(articles).toHaveLength(2);
    for (const art of articles) {
      expect(
        (art.children ?? []).some(
          (c) => (c as { kind: string }).kind === "section",
        ),
      ).toBe(true);
    }
  });
});

describe("runPathEcode360FileIngest()", () => {
  it("atomizes the fixture into code-section atoms with the smithville_tx tenant override (not the artifact's own 'smithville-tx' metadata) and platform-internal accessPolicy", async () => {
    const storage = new InMemoryStorage();
    const { report, atomization } = await runPathEcode360FileIngest({
      storage,
      jurisdictionTenant: "smithville_tx",
      jurisdictionName: "Smithville, TX",
      editionLabel: "Smithville Code of Ordinances (eCode360)",
      normalized: FIXTURE,
      normalizedFilePath: "unused-when-normalized-is-provided",
      accessPolicy: "platform-internal",
    });

    expect(report.sectionsIngested).toBe(23);
    expect(report.accessPolicy).toBe("platform-internal");
    expect(atomization.jurisdictionCorpus.jurisdictionTenant).toBe(
      "smithville_tx",
    );
    expect(atomization.jurisdictionCorpus.accessPolicy).toBe(
      "platform-internal",
    );
    for (const s of atomization.sections) {
      expect(s.entityType).toBe("code-section");
      expect(s.jurisdictionTenant).toBe("smithville_tx");
      expect(s.entityId.startsWith("smithville_tx/")).toBe(true);
    }
  });

  it("includes the known section 1.02.001 with its real body text AND title carried through (2026-08-04 OPS-9 S3 fix)", async () => {
    // FIXED (was: title silently empty — see the eval failure this
    // caused below). `buildCodeTree()`'s heading case calls
    // `splitHeadingLabel(block.label ?? block.text)`, preferring
    // `block.label` when present. eCode360 headings used to carry a
    // `label` truncated to "§ 1.02.001" (number only, no title text
    // after it); the human-readable title ("Form of government.") lived
    // only in `block.text` ("§ 1.02.001: Form of government."), which
    // was never consulted once `label` was present. Fixed two ways:
    // (1) `ECode360Adapter.normalize()` now sets `label` to the full
    // `data-full-title` string (matching `NormalizedBlock.label`'s own
    // doc-comment contract, "e.g. § 5.04 Setbacks" — the whole heading,
    // not just the locator), so future crawls carry the title in
    // `label` directly; (2) `buildCodeTree()`'s `splitHeadingLabel` call
    // now falls back to parsing `block.text` whenever `label`'s own
    // parse yields an empty title, so already-captured artifacts
    // (frozen before the adapter fix, like this fixture and the live
    // Smithville normalized JSON) also recover the title. Diagnosed via
    // the Smithville curated-query eval: two queries whose expected
    // section's body text never restates its own boilerplate title
    // ("General regulations." / "General requirements.") lost the
    // top-3 retrieval bar (86.7% vs 90% required) because the title
    // words were never in the indexed search snippet at all.
    const storage = new InMemoryStorage();
    const { atomization } = await runPathEcode360FileIngest({
      storage,
      jurisdictionTenant: "smithville_tx",
      jurisdictionName: "Smithville, TX",
      editionLabel: "Smithville Code of Ordinances (eCode360)",
      normalized: FIXTURE,
      normalizedFilePath: "unused-when-normalized-is-provided",
      accessPolicy: "platform-internal",
    });
    const formOfGov = atomization.sections.find(
      (s) => s.sectionNumber === "1.02.001",
    );
    expect(formOfGov).toBeDefined();
    expect(formOfGov?.title).toBe("Form of government.");
    expect(formOfGov?.bodyText).toMatch(/Revised Civil Statutes/i);
    expect(formOfGov?.bodyText.length).toBeGreaterThan(0);
  });

  it("writes atoms to the provided storage port (jurisdiction-corpus + edition + sections all present)", async () => {
    const storage = new InMemoryStorage();
    const { report } = await runPathEcode360FileIngest({
      storage,
      jurisdictionTenant: "smithville_tx",
      jurisdictionName: "Smithville, TX",
      editionLabel: "Smithville Code of Ordinances (eCode360)",
      normalized: FIXTURE,
      normalizedFilePath: "unused-when-normalized-is-provided",
      accessPolicy: "platform-internal",
    });
    const corpus = await storage.getAtom(
      "jurisdiction-corpus",
      "smithville_tx",
    );
    expect(corpus).toBeDefined();
    const edition = await storage.getAtom(
      "code-edition",
      report.editionEntityId,
    );
    expect(edition).toBeDefined();
    if (edition?.entityType === "code-edition") {
      expect(edition.sectionIds).toHaveLength(23);
    }
  });
});
