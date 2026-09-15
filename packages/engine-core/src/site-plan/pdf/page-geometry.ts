import { CHROME_MARGIN } from "./report-chrome-tokens.js";

/**
 * US Letter, PDF points (72/in). Standard sheet is 816x1056 px @96dpi
 * (report-chrome.css `--ss-sheet-w`/`--ss-sheet-h`) — unchanged by P-228.
 *
 * Margins are the P-228 frame's own geometry (`report-chrome-tokens.ts`'s
 * `CHROME_MARGIN`, itself a direct mirror of `report-chrome.css`'s
 * `--ss-sheet-mt/mx/mb`). Pulled into their own module (rather than living
 * in render.ts, where they used to be declared) so `report-chrome.ts` can
 * read them without render.ts <-> report-chrome.ts becoming a import
 * cycle — render.ts re-exports these under the same names it always has,
 * so dossier.ts / feasibility.ts / flood-drainage.ts need no import changes.
 */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MARGIN_TOP = CHROME_MARGIN.top;
export const MARGIN_X = CHROME_MARGIN.x;
export const MARGIN_BOTTOM = CHROME_MARGIN.bottom;
