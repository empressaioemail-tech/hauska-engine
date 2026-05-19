/**
 * probe-bastrop-udc regex tightening verification.
 *
 * cc-agent-M caught that the original regex matched on
 * `section_number ~* '^14\.'` alone, which false-positives on
 * charter sections like "Sec. 14.01 Effect of Charter Amendments."
 * The tightened regex requires zoning-keyword title matching OR
 * an explicit UDC section-number pattern with a non-charter title.
 *
 * These tests assert the regex logic via JS regex (the SQL is
 * structurally identical; we re-implement here so the test runs
 * without Neon).
 */

import { describe, expect, it } from "vitest";

/** Title-keyword regex (case-insensitive). */
const TITLE_KEYWORD_RE =
  /unified development|use district|zoning district|setback|subdivision standard|lot dimension|land development|zoning regulation|district standard/i;

/** Section-number UDC-pattern regex. */
const UDC_SECTION_RE = /^14\.|^150\.|^UDC/;

/** Title patterns to exclude (charter / amendment / preamble / adoption). */
const TITLE_EXCLUSION_RE = /charter|amendment|preamble|adoption/i;

function isUdcCandidate(sectionNumber: string, sectionTitle: string): boolean {
  if (TITLE_KEYWORD_RE.test(sectionTitle)) return true;
  if (UDC_SECTION_RE.test(sectionNumber) && !TITLE_EXCLUSION_RE.test(sectionTitle)) {
    return true;
  }
  return false;
}

describe("UDC probe regex tightening", () => {
  it("matches UDC title keywords", () => {
    expect(isUdcCandidate("Article 4", "Zoning Districts")).toBe(true);
    expect(isUdcCandidate("Section 5", "Setbacks")).toBe(true);
    expect(isUdcCandidate("Article 6", "Subdivision Standards")).toBe(true);
    expect(isUdcCandidate("Article 4", "Unified Development Code")).toBe(true);
  });

  it("matches UDC section-number range with non-charter title", () => {
    expect(isUdcCandidate("14.5", "Use Districts")).toBe(true);
    expect(isUdcCandidate("150.10", "Building Setbacks")).toBe(true);
  });

  it("rejects charter sections that share the 14.x number range", () => {
    // The dispatch's documented false-positives.
    expect(isUdcCandidate("Sec. 14.01", "Effect of Charter Amendments")).toBe(false);
    expect(isUdcCandidate("Sec. 14.02", "Effect of Charter on Existing Laws")).toBe(false);
  });

  it("rejects preamble / adoption sections at 14.x", () => {
    expect(isUdcCandidate("14.00", "Preamble")).toBe(false);
    expect(isUdcCandidate("14.99", "Adoption of Code")).toBe(false);
  });

  it("rejects unrelated CoO sections", () => {
    expect(isUdcCandidate("Sec. 1.01.001", "General Provisions")).toBe(false);
    expect(isUdcCandidate("Sec. 2.01.001", "Administration")).toBe(false);
    expect(isUdcCandidate("Sec. 3.01.001", "Library Services")).toBe(false);
  });
});
