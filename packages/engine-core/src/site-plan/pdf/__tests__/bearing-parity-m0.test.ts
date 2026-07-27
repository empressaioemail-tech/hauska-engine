/**
 * QA5 M0 — single shared bearing formula.
 *
 * PDF annotation-placement MUST import-and-re-export from
 * geometry/gis-property-line-tags (same module boundary-edge atoms use).
 * A re-inlined copy of formatGisBearing / formatPropertyLineTag is the
 * pr-151-c1 fork shape — this test fails if that fork reappears.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computePropertyLineTagsFromLocalEnuEndpoints,
  formatGisBearing as formatGisBearingAtom,
  formatPropertyLineTag as formatPropertyLineTagAtom,
  PROPERTY_LINE_TAGS_HONESTY as PROPERTY_LINE_TAGS_HONESTY_ATOM,
} from "../../../geometry/gis-property-line-tags.js";
import {
  formatGisBearing as formatGisBearingPdf,
  formatPropertyLineTag as formatPropertyLineTagPdf,
  PROPERTY_LINE_TAGS_HONESTY as PROPERTY_LINE_TAGS_HONESTY_PDF,
} from "../annotation-placement.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANNOTATION_SOURCE = join(HERE, "..", "annotation-placement.ts");

/** Known local-ENU segment — NE quadrant, non-cardinal. */
const KNOWN = {
  a: { x: 0, y: 0 },
  b: { x: 10, y: 30 },
  lengthFeet: 104.3,
} as const;

describe("QA5 M0 bearing formula single-source guard", () => {
  it("annotation-placement.ts imports gis-property-line-tags (no silent fork)", () => {
    const src = readFileSync(ANNOTATION_SOURCE, "utf8").replace(/\r\n/g, "\n");

    expect(
      src,
      "PDF path must import the shared geometry module",
    ).toMatch(/from\s+["']\.\.\/\.\.\/geometry\/gis-property-line-tags\.js["']/);

    expect(
      src,
      "must re-export formatGisBearingShared — not re-implement",
    ).toMatch(/formatGisBearing\s+as\s+formatGisBearingShared/);

    expect(
      src,
      "must re-export formatPropertyLineTagShared — not re-implement",
    ).toMatch(/formatPropertyLineTag\s+as\s+formatPropertyLineTagShared/);

    expect(
      src,
      "must re-export PROPERTY_LINE_TAGS_HONESTY_SHARED — not re-implement",
    ).toMatch(/PROPERTY_LINE_TAGS_HONESTY\s+as\s+PROPERTY_LINE_TAGS_HONESTY_SHARED/);

    // Fork telltales from the inlined pr-151-c1 copy:
    expect(src, "must not inline atan2 bearing math").not.toMatch(
      /Math\.atan2\s*\(\s*dxMeters/,
    );
    expect(src, "must not declare a local formatGisBearing body").not.toMatch(
      /export\s+function\s+formatGisBearing\s*\(/,
    );
    expect(src, "must not hardcode honesty string inline").not.toMatch(
      /Property-line tags:\s*GIS-approximate from county parcel ring/,
    );
  });

  it("PDF path and atom path agree on a known segment (byte-identical tag)", () => {
    const pdfTag = formatPropertyLineTagPdf({
      a: { x: KNOWN.a.x, y: KNOWN.a.y },
      b: { x: KNOWN.b.x, y: KNOWN.b.y },
      lengthFeet: KNOWN.lengthFeet,
    });
    const atomTag = formatPropertyLineTagAtom({
      a: { x: KNOWN.a.x, y: KNOWN.a.y },
      b: { x: KNOWN.b.x, y: KNOWN.b.y },
      lengthFeet: KNOWN.lengthFeet,
    });
    expect(pdfTag).toBe(atomTag);

    const dx = KNOWN.b.x - KNOWN.a.x;
    const dy = KNOWN.b.y - KNOWN.a.y;
    expect(formatGisBearingPdf(dx, dy)).toBe(formatGisBearingAtom(dx, dy));

    const atom = computePropertyLineTagsFromLocalEnuEndpoints(
      [KNOWN.a.x, KNOWN.a.y],
      [KNOWN.b.x, KNOWN.b.y],
    );
    expect(formatGisBearingPdf(dx, dy)).toBe(atom.bearing);
    expect(pdfTag).toBe(`${atom.bearing}  ${KNOWN.lengthFeet.toFixed(1)}'`);

    expect(PROPERTY_LINE_TAGS_HONESTY_PDF).toBe(PROPERTY_LINE_TAGS_HONESTY_ATOM);
  });
});
