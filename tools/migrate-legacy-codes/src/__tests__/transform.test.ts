import { describe, expect, it } from "vitest";

import { transformBatch, transformRow } from "../transform.js";
import { SOURCE_NAME_BY_ID, ALL_ROWS, BASTROP_ROWS } from "./fixtures.js";

describe("transform.transformRow", () => {
  it("maps a legacy row to a CodeSectionAtomInstance with provenance", () => {
    const row = BASTROP_ROWS[0]!;
    const result = transformRow(row, { sourceNameById: SOURCE_NAME_BY_ID });
    expect(result).not.toBeNull();
    const inst = result!.instance;
    expect(inst.entityType).toBe("code-section");
    expect(inst.jurisdictionTenant).toBe("bastrop_tx");
    expect(inst.sectionNumber).toBe("Chapter 14");
    expect(inst.title).toBe("Zoning");
    expect(inst.bodyText).toBe(row.body);
    expect(inst.sourceAdapter).toBe("legacy/bastrop-municode");
    expect(inst.sourceUrl).toBe(row.source_url);
    expect(inst.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inst.contentHash).not.toBe(row.content_hash); // recomputed
    expect(result!.metadataSidecar.legacyCodeAtomId).toBe(row.id);
    expect(result!.metadataSidecar.legacyContentHash).toBe(row.content_hash);
  });

  it("drops rows with null section_number", () => {
    const nullRow = BASTROP_ROWS.find((r) => r.section_number === null)!;
    const result = transformRow(nullRow, { sourceNameById: SOURCE_NAME_BY_ID });
    expect(result).toBeNull();
  });

  it("drops rows with empty body", () => {
    const emptyRow = BASTROP_ROWS.find((r) => r.body === "")!;
    const result = transformRow(emptyRow, { sourceNameById: SOURCE_NAME_BY_ID });
    expect(result).toBeNull();
  });

  it("derives a deterministic entityId from jurisdiction/edition/section", () => {
    const row = BASTROP_ROWS[1]!;
    const a = transformRow(row, { sourceNameById: SOURCE_NAME_BY_ID });
    const b = transformRow(row, { sourceNameById: SOURCE_NAME_BY_ID });
    expect(a!.instance.entityId).toBe(b!.instance.entityId);
    expect(a!.instance.entityId).toContain("bastrop_tx");
  });

  it("normalizes subsection markers when building section IDs", () => {
    const row = { ...BASTROP_ROWS[0]!, section_number: "5.04(b)(2)", body: "x" };
    const a = transformRow(row, { sourceNameById: SOURCE_NAME_BY_ID });
    expect(a!.instance.entityId.endsWith("/5-04")).toBe(true);
  });
});

describe("transform.transformBatch", () => {
  it("dedupes section-id collisions, keeping the earliest fetched_at", () => {
    const row1 = BASTROP_ROWS[0]!;
    const row2 = {
      ...row1,
      id: "duplicate-row",
      body: "different body",
      content_hash: "different-hash",
      fetched_at: new Date(row1.fetched_at.getTime() + 1000),
    };
    const result = transformBatch([row1, row2], {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    expect(result.instances.length).toBe(1);
    expect(result.collisions.length).toBe(1);
    expect(result.collisions[0]!.keptLegacyId).toBe(row1.id);
    expect(result.collisions[0]!.droppedLegacyId).toBe("duplicate-row");
  });

  it("counts null-section drops + empty-body drops separately", () => {
    const result = transformBatch(BASTROP_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    expect(result.droppedNullSection).toBe(1);
    expect(result.droppedEmptyBody).toBe(1);
    expect(result.instances.length).toBe(3);
  });

  it("preserves bastrop + grand county atoms in a single batch", () => {
    const result = transformBatch(ALL_ROWS, {
      sourceNameById: SOURCE_NAME_BY_ID,
    });
    const bastrop = result.instances.filter(
      (i) => i.jurisdictionTenant === "bastrop_tx",
    );
    const gc = result.instances.filter(
      (i) => i.jurisdictionTenant === "grand_county_ut",
    );
    expect(bastrop.length).toBe(3);
    expect(gc.length).toBe(4);
  });
});
