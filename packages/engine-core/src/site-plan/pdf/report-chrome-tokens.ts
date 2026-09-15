import { rgb, type RGB } from "pdf-lib";

import { pt } from "./template-tokens.js";

/**
 * Print/paper tokens for the report CHROME (masthead, running header,
 * footer) — Option 1a "Rule", `_design/report-chrome/README.md` on
 * doc_repo main. Kept SEPARATE from `template-tokens.ts` (the drawing/
 * ds-industry token set) the same way the spec keeps `print-tokens.css`
 * alongside `pe-tokens.css`: two token sets for two different grounds.
 * This repo has no CSS pipeline (pdf-lib draws PDF points directly), so
 * this file is that separation's TS equivalent — the one place the frame
 * resolves colour/size/geometry from. Never inline a hex or px value the
 * spec already named; add it here.
 *
 * Left column below is the CSS custom property each constant carries
 * forward, so a value can be diffed against `report-chrome.css` directly.
 */

function hex(h: string): RGB {
  const clean = h.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/** Paper colour tokens (report-chrome.css `:root`). */
export const PRINT = {
  paper: hex("#FCFBF9"), // --ss-paper
  paperAlt: hex("#F0EEE8"), // --ss-paper-alt
  ink: hex("#2A2A28"), // --ss-print-ink (also the 1.5px structural rule)
  t2: hex("#45423D"), // --ss-print-t2
  meta: hex("#57544E"), // --ss-print-meta (mono meta, footer copy — 7.4:1)
  label: hex("#6B6862"), // --ss-print-label (5.6:1)
  quiet: hex("#8F8B83"), // --ss-print-quiet — placeholders only, never live copy
  line: hex("#CFCBC1"), // --ss-print-line — 1px hairline separator
  blue: hex("#3C6396"), // --ss-print-blue — links only, 6.3:1
  warn: hex("#8A5A12"), // --ss-print-warn

  // Gold is paper-only (two rulings, report-chrome README "Two rulings to
  // carry forward"). ss-gold is 2.293:1 on paper and fails as text; the
  // wordmark letterforms take ss-print-gold, the ring dot keeps true gold.
  // Never add a gold rule, sheet counter or accent anywhere else in the frame.
  //
  // CONTRAST FIGURE CORRECTED (P-239). This line read "(4.6:1)" from the day it
  // landed. Measured against --ss-paper #FCFBF9 by the WCAG relative-luminance
  // formula, #B87116 is 3.752:1 — it does NOT meet the 4.5:1 normal-text floor
  // it was recorded as meeting. It DOES meet the 3:1 LARGE-text floor, and the
  // wordmark is the only thing that wears it, at ~17.9pt bold (above the
  // 14pt-bold large-text threshold), so the colour stays and only the claim
  // changes. Do not reuse this hue for body copy, labels or meta on the
  // strength of the old number. Canonical #F5B95C is 1.695:1 here and fails
  // even the large-text floor, which is why a paper substitution exists at all.
  gold: hex("#E8963B"), // --ss-gold — ring dot only (2.293:1; a filled mark, not text)
  printGold: hex("#B87116"), // --ss-print-gold — wordmark "SITE" letterforms only (3.752:1, AA large text)
} as const;

/** Page geometry (report-chrome.css `:root`), px @96dpi -> PDF points. */
export const CHROME_MARGIN = {
  top: pt(40), // --ss-sheet-mt
  x: pt(48), // --ss-sheet-mx — the type column edge; nothing bleeds past it
  bottom: pt(30), // --ss-sheet-mb
} as const;

/** Masthead (sheet 1 of the document only). */
export const MASTHEAD = {
  // logoWidth: the canonical lockup is 320x76, so at logoHeight it renders
  // 320/76 * 40 = 168.42px wide. The old pt(175) was 420/96 * 40, derived from
  // the redrawn asset's box rather than the real one (P-239). NOTE: nothing
  // reads this token — drawMastheadWordmark returns its own measured width and
  // the doctype sets flush right — so it is corrected rather than relied on.
  logoWidth: pt((320 / 76) * 40),
  logoHeight: pt(40),
  doctypeSize: pt(12),
  doctypeTracking: 0.16,
  doctypePaddingBottom: pt(3),
  ruleWeight: pt(1.5),
  ruleGap: pt(14),
  addressSize: pt(26),
  addressLineHeight: 1.05,
  addressTracking: -0.005,
  subjectGap: pt(7), // .ss-subject { gap: 7px }
  subjectMetaSize: pt(12.5),
  subjectMetaTracking: 0.02,
  docidLabelSize: pt(10),
  docidLabelTracking: 0.16,
  docidGap: pt(6),
  docidValueSize: pt(13),
  docidValueTracking: 0.02,
  hairlineWeight: pt(1),
  hairlineMarginTop: pt(14),
  bodyStart: pt(28),
} as const;

/** Running header (sheets 2..N of the document). */
export const RUNHEAD = {
  markSize: pt(20),
  markGap: pt(11), // .ss-runhead__left { gap: 11px }
  doctypeSize: pt(11),
  doctypeTracking: 0.16,
  metaSize: pt(11),
  metaTracking: 0.02,
  ruleGapBelow: pt(10),
  bodyStart: pt(26),
} as const;

/** Footer (every sheet). */
export const FOOTER = {
  hairlineGap: pt(9),
  rowGap: pt(28), // .ss-footer__row { gap: 28px }
  legalSize: pt(9.5),
  legalLineHeight: 1.5,
  legalMaxWidth: pt(430),
  metaSize: pt(9.5),
  metaTracking: 0.03,
  metaGap: pt(24), // .ss-footer__meta { gap: 24px }
} as const;

/**
 * Deep-link host. `smartsite.app` is a confirmed PARKED domain (measured by
 * the doc_repo integration seat 2026-09-15: 114 bytes, no Vercel headers,
 * body is only a `/lander` redirect — HTTP 200, so a status-code check alone
 * does not catch it). `smartsite.cloud` serves the real application and is
 * the only host this frame ever prints. See report-chrome.ts for how a
 * caller-supplied liveViewUrl on the wrong host is corrected, and how the
 * fallback link is built when no liveViewUrl is supplied at all.
 */
export const DEEP_LINK_HOST = "smartsite.cloud";
export const PARKED_DEEP_LINK_HOST = "smartsite.app";
