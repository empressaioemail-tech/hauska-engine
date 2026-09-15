/**
 * SMART SITE brand mark — the CANONICAL asset, parsed.
 *
 * WHY THIS FILE EXISTS (P-239). The masthead mark used to be a set of hand-typed
 * numbers in report-chrome.ts, copied by eye from `_design/report-chrome/logo-*.svg`
 * on doc_repo — which were themselves a redrawing of the real asset that nobody
 * compared against it. Two layers of redrawing, each defensible in isolation, and the
 * result was measurably not the brand. The whole class of defect is "a constant that
 * claims to represent a file, sitting where nothing can compare it to that file".
 *
 * So: no geometry constant is authored here. The canonical SVG text is inlined below
 * verbatim and PARSED. Stroke weights, radii, tick extents, the wordmark's size,
 * baseline and tracking are all READ from that text. There is nothing to keep in sync
 * by hand, because there is no second copy of the numbers.
 *
 * WHY INLINED RATHER THAN read off disk. This package builds with `tsc -b`, which
 * emits .js to dist/ and copies no .svg. A runtime `readFileSync` would resolve
 * against a dist tree the asset never reaches. The .svg files ARE vendored next to
 * this file (they are the artifact a human diffs, and the thing PROVENANCE.json
 * hashes), and `brand-provenance.test.ts` asserts the inlined text below is
 * byte-identical to them and that they still hash to the recorded sha256. Drift in
 * any direction fails the suite rather than shipping quietly.
 *
 * DO NOT EDIT THE SVG TEXT BELOW. hauska-map owns it. To take a newer brand, re-copy
 * from the source repo and follow the refresh procedure in PROVENANCE.json.
 *
 * Source: empressaioemail-tech/hauska-map @ b3601384537afe61a816c41689bffaee2ca9450c
 *   apps/property-explorer/docs/smart-site-brand/logo/smart-site-lockup.svg
 *   apps/property-explorer/docs/smart-site-brand/logo/smart-site-mark-crosshair.svg
 */

/** VERBATIM `smart-site-lockup.svg`. Mark + "SMART SITE" wordmark, 320x76. */
export const SMART_SITE_LOCKUP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 76" fill="none">\n' +
  '  <circle cx="38" cy="38" r="30" stroke="#ffffff" stroke-width="4"></circle>\n' +
  '  <circle cx="38" cy="38" r="6" fill="#E8963B"></circle>\n' +
  '  <line x1="38" y1="0" x2="38" y2="18" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="38" y1="58" x2="38" y2="76" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="0" y1="38" x2="18" y2="38" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="58" y1="38" x2="76" y2="38" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <text x="86" y="48" font-family="Oxygen, sans-serif" font-weight="700" font-size="34" letter-spacing="0.5" fill="#ffffff">SMART <tspan fill="#F5B95C">SITE</tspan></text>\n' +
  "</svg>";

/** VERBATIM `smart-site-mark-crosshair.svg`. Ring only, 76x76. */
export const SMART_SITE_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 76" fill="none">\n' +
  '  <circle cx="38" cy="38" r="30" stroke="#ffffff" stroke-width="4"></circle>\n' +
  '  <circle cx="38" cy="38" r="6" fill="#E8963B"></circle>\n' +
  '  <line x1="38" y1="0" x2="38" y2="18" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="38" y1="58" x2="38" y2="76" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="0" y1="38" x2="18" y2="38" stroke="#ffffff" stroke-width="4"></line>\n' +
  '  <line x1="58" y1="38" x2="76" y2="38" stroke="#ffffff" stroke-width="4"></line>\n' +
  "</svg>";

/** A tick, in the SVG's own top-down native units. */
export interface BrandTick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The wordmark, in the SVG's own top-down native units. */
export interface BrandWordmark {
  /** Left edge of the first glyph. */
  x: number;
  /** TEXT BASELINE, not a box top — SVG `y` on a <text> is the baseline. */
  baselineY: number;
  fontSize: number;
  /** SVG `letter-spacing`, in native units (NOT em). */
  letterSpacing: number;
  fontWeight: number;
  /** Leading run, canonically "SMART " including its trailing space. */
  leadText: string;
  leadFill: string;
  /** <tspan> run, canonically "SITE". */
  accentText: string;
  accentFill: string;
}

/** The mark, in the SVG's own top-down native units. */
export interface BrandMark {
  /** [minX, minY, width, height]. */
  viewBox: readonly [number, number, number, number];
  /** viewBox height — the box every coordinate below is expressed against. */
  nativeHeight: number;
  nativeWidth: number;
  centerX: number;
  centerY: number;
  ringRadius: number;
  ringStrokeWidth: number;
  ringStroke: string;
  dotRadius: number;
  dotFill: string;
  ticks: readonly BrandTick[];
  wordmark?: BrandWordmark;
}

const attrNum = (attrs: string, name: string): number | undefined => {
  const raw = new RegExp(`${name}="([0-9.\\-]+)"`).exec(attrs)?.[1];
  return raw === undefined ? undefined : Number(raw);
};
const attrStr = (attrs: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]+)"`).exec(attrs)?.[1];

function required(value: number | undefined, what: string): number {
  // Fail closed: never default a geometry value whose correct value is unknown.
  // A silently-zeroed radius draws a mark that is wrong in a way nobody can see.
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`smart-site-brand: could not read ${what} from the canonical SVG. Refusing to draw a guessed mark.`);
  }
  return value;
}

/** Indexed access that REFUSES rather than yielding undefined. `packages/retrieval`
 * typechecks these sources under `noUncheckedIndexedAccess`, and a `!` there would
 * assert away exactly the case this parser exists to catch. */
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`smart-site-brand: missing ${what} in the canonical SVG.`);
  return v;
}

/**
 * Parses a Smart Site crosshair SVG into typed geometry.
 *
 * Deliberately NOT a general SVG parser. It understands exactly the shape the two
 * canonical files have — a stroked ring, a filled dot, four axis-aligned ticks and an
 * optional two-run wordmark — and THROWS on anything else rather than returning a
 * partial mark. If hauska-map ever ships a structurally different logo, this refuses
 * loudly at the first render instead of quietly drawing three ticks.
 */
export function parseSmartSiteSvg(svg: string): BrandMark {
  const vbRaw = /viewBox="([0-9.\-\s]+)"/.exec(svg)?.[1];
  if (vbRaw === undefined) throw new Error("smart-site-brand: no viewBox in the canonical SVG.");
  const vb = vbRaw.trim().split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) {
    throw new Error(`smart-site-brand: unreadable viewBox "${vbRaw}".`);
  }
  const [vbMinX, vbMinY, vbW, vbH] = [
    at(vb, 0, "viewBox min-x"),
    at(vb, 1, "viewBox min-y"),
    at(vb, 2, "viewBox width"),
    at(vb, 3, "viewBox height"),
  ];

  const circles = [...svg.matchAll(/<circle\b([^>]*?)\/?>/g)].map((m, i) => at(m, 1, `circle ${i} attributes`));
  const filled = circles.filter((a) => {
    const f = attrStr(a, "fill");
    return f !== undefined && f !== "none";
  });
  const stroked = circles.filter((a) => {
    const f = attrStr(a, "fill");
    return f === undefined || f === "none";
  });
  if (stroked.length !== 1 || filled.length !== 1) {
    throw new Error(
      `smart-site-brand: expected exactly one stroked ring and one filled dot, got ${stroked.length}/${filled.length}.`,
    );
  }
  const ringAttrs = at(stroked, 0, "ring attributes");
  const dotAttrs = at(filled, 0, "dot attributes");

  const lines = [...svg.matchAll(/<line\b([^>]*?)\/?>/g)].map((m, i) => at(m, 1, `tick ${i} attributes`));
  if (lines.length !== 4) {
    throw new Error(`smart-site-brand: expected exactly 4 crosshair ticks, got ${lines.length}.`);
  }
  const ticks: BrandTick[] = lines.map((a) => ({
    x1: required(attrNum(a, "x1"), "tick x1"),
    y1: required(attrNum(a, "y1"), "tick y1"),
    x2: required(attrNum(a, "x2"), "tick x2"),
    y2: required(attrNum(a, "y2"), "tick y2"),
  }));

  let wordmark: BrandWordmark | undefined;
  const textMatch = /<text\b([^>]*)>([\s\S]*?)<\/text>/.exec(svg);
  if (textMatch) {
    const attrs = at(textMatch, 1, "wordmark attributes");
    const inner = at(textMatch, 2, "wordmark content");
    const tspan = /<tspan[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/tspan>/.exec(inner);
    if (!tspan) {
      throw new Error("smart-site-brand: wordmark present but its accent <tspan> is missing.");
    }
    const lead = inner.slice(0, inner.indexOf("<tspan"));
    wordmark = {
      x: required(attrNum(attrs, "x"), "wordmark x"),
      baselineY: required(attrNum(attrs, "y"), "wordmark baseline y"),
      fontSize: required(attrNum(attrs, "font-size"), "wordmark font-size"),
      letterSpacing: attrNum(attrs, "letter-spacing") ?? 0,
      fontWeight: attrNum(attrs, "font-weight") ?? 400,
      leadText: lead,
      leadFill: attrStr(attrs, "fill") ?? "#ffffff",
      accentText: at(tspan, 2, "wordmark accent text"),
      accentFill: at(tspan, 1, "wordmark accent fill"),
    };
  }

  return {
    viewBox: [vbMinX, vbMinY, vbW, vbH] as const,
    nativeWidth: vbW,
    nativeHeight: vbH,
    centerX: required(attrNum(ringAttrs, "cx"), "ring cx"),
    centerY: required(attrNum(ringAttrs, "cy"), "ring cy"),
    ringRadius: required(attrNum(ringAttrs, "r"), "ring r"),
    ringStrokeWidth: required(attrNum(ringAttrs, "stroke-width"), "ring stroke-width"),
    ringStroke: attrStr(ringAttrs, "stroke") ?? "#ffffff",
    dotRadius: required(attrNum(dotAttrs, "r"), "dot r"),
    dotFill: attrStr(dotAttrs, "fill") ?? "#E8963B",
    ticks,
    wordmark,
  };
}

/** The canonical lockup (mark + wordmark), parsed once at module load. */
export const SMART_SITE_LOCKUP: BrandMark = parseSmartSiteSvg(SMART_SITE_LOCKUP_SVG);

/** The canonical mark alone, parsed once at module load. */
export const SMART_SITE_MARK: BrandMark = parseSmartSiteSvg(SMART_SITE_MARK_SVG);
