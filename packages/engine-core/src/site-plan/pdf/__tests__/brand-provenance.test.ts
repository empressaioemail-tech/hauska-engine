import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SMART_SITE_LOCKUP,
  SMART_SITE_LOCKUP_SVG,
  SMART_SITE_MARK,
  SMART_SITE_MARK_SVG,
  parseSmartSiteSvg,
} from "../brand/smart-site-brand.js";

/**
 * P-239. The defect this file exists to prevent: a brand constant that CLAIMS to
 * represent a file, sitting where nothing can compare it to that file. The PDF
 * masthead carried hand-typed numbers eyeballed from a redrawing of a redrawing
 * for exactly that reason — nobody could have caught it, because the canonical
 * numbers were in another repo.
 *
 * Three artifacts must agree or the suite fails:
 *   1. the vendored .svg on disk
 *   2. its sha256 in PROVENANCE.json
 *   3. the SVG text inlined in smart-site-brand.ts
 *
 * Editing any one alone is loud. That is the whole control.
 */

const BRAND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "brand");

interface ProvenanceFile {
  path: string;
  sourcePath: string;
  blob: string;
  sha256: string;
  usedBy: string;
}
interface Provenance {
  source: { repo: string; commit: string };
  files: ProvenanceFile[];
  paperSubstitutions: Array<{ element: string; canonical: string; onPaper: string; contrastOnPaper: number }>;
}

const provenance: Provenance = JSON.parse(readFileSync(join(BRAND_DIR, "PROVENANCE.json"), "utf8"));

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** WCAG 2.x relative luminance / contrast ratio. */
function contrastRatio(aHex: string, bHex: string): number {
  const lum = (h: string): number => {
    const c = h.replace("#", "");
    const ch = [0, 2, 4]
      .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(aHex), lum(bHex)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

const PAPER = "#FCFBF9"; // --ss-paper

describe("vendored brand assets are locked to hauska-map", () => {
  it("records a real source commit", () => {
    expect(provenance.source.repo).toBe("empressaioemail-tech/hauska-map");
    expect(provenance.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.files).toHaveLength(2);
  });

  for (const f of provenance.files) {
    it(`${f.path} on disk still hashes to its recorded sha256`, () => {
      // readFileSync as a BUFFER: hashing a decoded string would hide a CRLF
      // rewrite, which is the exact failure .gitattributes eol=lf guards against.
      const bytes = readFileSync(join(BRAND_DIR, f.path));
      expect(sha256(bytes)).toBe(f.sha256);
    });
  }

  it("the SVG text inlined in smart-site-brand.ts is byte-identical to the vendored files", () => {
    expect(SMART_SITE_LOCKUP_SVG).toBe(readFileSync(join(BRAND_DIR, "smart-site-lockup.svg"), "utf8"));
    expect(SMART_SITE_MARK_SVG).toBe(readFileSync(join(BRAND_DIR, "smart-site-mark-crosshair.svg"), "utf8"));
  });

  it("DIVERGENCE TEST: a one-character edit to the asset breaks the hash", () => {
    // Verify the check by violating it. A lock only observed passing has not
    // been observed working.
    const real = readFileSync(join(BRAND_DIR, "smart-site-lockup.svg"), "utf8");
    const tampered = real.replace('stroke-width="4"', 'stroke-width="3"');
    expect(tampered).not.toBe(real); // not vacuous: the replace actually fired
    expect(sha256(Buffer.from(tampered, "utf8"))).not.toBe(provenance.files[0].sha256);
  });
});

describe("canonical geometry, read from the asset", () => {
  it("the lockup is the 320x76 canonical box", () => {
    expect(SMART_SITE_LOCKUP.viewBox).toEqual([0, 0, 320, 76]);
    expect(SMART_SITE_MARK.viewBox).toEqual([0, 0, 76, 76]);
  });

  it("carries canon stroke weight, dot radius and ring radius", () => {
    for (const art of [SMART_SITE_LOCKUP, SMART_SITE_MARK]) {
      expect(art.ringStrokeWidth).toBe(4);
      expect(art.dotRadius).toBe(6);
      expect(art.ringRadius).toBe(30);
      expect(art.centerX).toBe(38);
      expect(art.centerY).toBe(38);
      expect(art.dotFill).toBe("#E8963B");
    }
  });

  it("has four ticks, all 18 long — the mark is SYMMETRIC", () => {
    // The shipped redrawing was not: N/S/W were 14 and E was 34, because a
    // 76-unit coordinate space was mixed into a 96-unit one. This is the
    // assertion that would have caught it.
    for (const art of [SMART_SITE_LOCKUP, SMART_SITE_MARK]) {
      expect(art.ticks).toHaveLength(4);
      const lengths = art.ticks.map((t) => Math.hypot(t.x2 - t.x1, t.y2 - t.y1));
      expect(lengths).toEqual([18, 18, 18, 18]);
    }
  });

  it("every tick STRADDLES the ring edge — none floats detached", () => {
    // The shipped redrawing left three of four ticks hanging 4 units clear of
    // the ring, which is what stopped it reading as a crosshair at all.
    for (const art of [SMART_SITE_LOCKUP, SMART_SITE_MARK]) {
      for (const t of art.ticks) {
        const dA = Math.hypot(t.x1 - art.centerX, t.y1 - art.centerY);
        const dB = Math.hypot(t.x2 - art.centerX, t.y2 - art.centerY);
        const straddles = (dA - art.ringRadius) * (dB - art.ringRadius) < 0;
        expect(straddles, `tick ${JSON.stringify(t)} must cross r=${art.ringRadius}`).toBe(true);
      }
    }
  });

  it("carries the canonical two-tone wordmark", () => {
    const w = SMART_SITE_LOCKUP.wordmark;
    expect(w).toBeDefined();
    expect(w!.x).toBe(86);
    expect(w!.baselineY).toBe(48);
    expect(w!.fontSize).toBe(34);
    expect(w!.letterSpacing).toBe(0.5);
    expect(w!.fontWeight).toBe(700);
    expect(w!.leadText).toBe("SMART ");
    expect(w!.accentText).toBe("SITE");
    expect(w!.accentFill).toBe("#F5B95C");
  });

  it("the mark-only asset carries NO wordmark", () => {
    expect(SMART_SITE_MARK.wordmark).toBeUndefined();
  });
});

describe("the parser fails closed", () => {
  // A parser that returns a partial mark is how a wrong logo ships quietly.
  it("refuses an SVG with no viewBox", () => {
    expect(() => parseSmartSiteSvg("<svg></svg>")).toThrow(/viewBox/);
  });

  it("refuses a mark with the wrong number of ticks", () => {
    const threeTicks = SMART_SITE_MARK_SVG.replace(
      '  <line x1="58" y1="38" x2="76" y2="38" stroke="#ffffff" stroke-width="4"></line>\n',
      "",
    );
    expect(threeTicks).not.toBe(SMART_SITE_MARK_SVG); // not vacuous
    expect(() => parseSmartSiteSvg(threeTicks)).toThrow(/4 crosshair ticks, got 3/);
  });

  it("refuses a mark with no filled dot", () => {
    const noDot = SMART_SITE_MARK_SVG.replace('  <circle cx="38" cy="38" r="6" fill="#E8963B"></circle>\n', "");
    expect(noDot).not.toBe(SMART_SITE_MARK_SVG);
    expect(() => parseSmartSiteSvg(noDot)).toThrow(/one stroked ring and one filled dot/);
  });

  it("refuses a ring with an unreadable stroke-width rather than defaulting it", () => {
    const noStroke = SMART_SITE_MARK_SVG.replace(
      '<circle cx="38" cy="38" r="30" stroke="#ffffff" stroke-width="4">',
      '<circle cx="38" cy="38" r="30" stroke="#ffffff">',
    );
    expect(noStroke).not.toBe(SMART_SITE_MARK_SVG);
    expect(() => parseSmartSiteSvg(noStroke)).toThrow(/stroke-width/);
  });

  it("DETECTS drift rather than absorbing it", () => {
    // The redrawing's own numbers, fed to the parser: it must report them as
    // what they are, not normalise them back to canon.
    const redrawn = SMART_SITE_MARK_SVG.replace(/stroke-width="4"/g, 'stroke-width="3"').replace(
      'r="6" fill="#E8963B"',
      'r="5" fill="#E8963B"',
    );
    const art = parseSmartSiteSvg(redrawn);
    expect(art.ringStrokeWidth).toBe(3);
    expect(art.dotRadius).toBe(5);
    expect(art.ringStrokeWidth).not.toBe(SMART_SITE_MARK.ringStrokeWidth);
  });
});

describe("paper colour substitutions are justified, not asserted", () => {
  it("canonical white is invisible on paper, which is why ink substitutes", () => {
    expect(contrastRatio("#ffffff", PAPER)).toBeLessThan(1.05);
    expect(contrastRatio("#2A2A28", PAPER)).toBeGreaterThan(4.5);
  });

  it("canonical #F5B95C fails even the 3:1 large-text floor on paper", () => {
    expect(contrastRatio("#F5B95C", PAPER)).toBeLessThan(3.0);
  });

  it("--ss-print-gold clears LARGE text but NOT normal text", () => {
    const r = contrastRatio("#B87116", PAPER);
    expect(r).toBeGreaterThanOrEqual(3.0); // AA large text — the wordmark qualifies
    expect(r).toBeLessThan(4.5); // and this is why it must never be used for body copy
  });

  it("PROVENANCE.json's recorded ratios are the measured ones", () => {
    // A recorded contrast figure nothing recomputes is how "4.6:1" survived in
    // report-chrome-tokens.ts while the real value was 3.752:1.
    for (const s of provenance.paperSubstitutions) {
      expect(contrastRatio(s.onPaper, PAPER)).toBeCloseTo(s.contrastOnPaper, 2);
    }
  });
});
