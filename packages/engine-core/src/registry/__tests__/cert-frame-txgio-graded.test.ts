/**
 * Geometry Law / DC-10 pin: cert grades the raw txgio ring. BCAD may be
 * observed for divergence reporting only and must never substitute as the
 * graded frame (OPS-11 cert-frame amendment; engine #292 / 1f2a6e2).
 *
 * Source-shape guard — fails CI if cert-grade-core regresses to
 * `scrubLotLineRing(bcadRing)` as the working ring.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const certGradeCoreSrc = readFileSync(join(here, "../cert-grade-core.ts"), "utf8");

describe("cert-frame Geometry Law pin (txgio graded)", () => {
  it("defines loadTxgioParcelRing as the graded-frame loader", () => {
    expect(certGradeCoreSrc).toMatch(/async function loadTxgioParcelRing/);
    expect(certGradeCoreSrc).toMatch(/FROM txgio_parcel/);
    expect(certGradeCoreSrc).toMatch(
      /Raw txgio_parcel exterior ring[\s\S]{0,80}Geometry Law truth frame/,
    );
  });

  it("never assigns scrubLotLineRing(bcad…) as the graded ring", () => {
    expect(certGradeCoreSrc).not.toMatch(
      /ring\s*=\s*bcadRing\s*\?\s*scrubLotLineRing\s*\(\s*bcadRing\s*\)/,
    );
    expect(certGradeCoreSrc).not.toMatch(
      /const bcadRing = bcad\[0\]\?\.ring;\s*\n\s*ring = bcadRing \? scrubLotLineRing\(bcadRing\)/,
    );
  });

  it("keeps BCAD as divergence-only (observeBcadRingDivergence)", () => {
    expect(certGradeCoreSrc).toMatch(/async function observeBcadRingDivergence/);
    expect(certGradeCoreSrc).toMatch(
      /BCAD is a divergence-reporting instrument only; never substitutes as graded frame/,
    );
  });

  it("dump-block13-offline-fixture reads rings from txgio_parcel", () => {
    const dumpSrc = readFileSync(
      join(here, "../../../scripts/dump-block13-offline-fixture.mjs"),
      "utf8",
    );
    expect(dumpSrc).toMatch(/SELECT geometry FROM txgio_parcel/);
    expect(dumpSrc).toMatch(/no txgio_parcel ring/);
  });
});
