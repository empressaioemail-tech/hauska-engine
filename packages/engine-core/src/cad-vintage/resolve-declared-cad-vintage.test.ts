import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECLARED_CAD_VINTAGES,
  VINTAGE_GAP_ABSENCE_BASIS,
  classifyCadPropertyMiss,
  resolveDeclaredCadVintage,
} from "./resolve-declared-cad-vintage.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "declared-fixture.json"), "utf8"),
) as Record<string, { taxYear: number; tier: string }>;

describe("resolveDeclaredCadVintage (engine mirror)", () => {
  it("matches frozen fixture (sync with LDT vintage.ts)", () => {
    expect(DECLARED_CAD_VINTAGES).toEqual(fixture);
  });

  it("Tarrant stays 2025 not pilot 2026", () => {
    expect(resolveDeclaredCadVintage("48439").taxYear).toBe(2025);
  });

  it("failing-first: other-vintage-only → vintage-gap", () => {
    expect(
      classifyCadPropertyMiss({
        declaredYearHit: false,
        otherVintageHit: true,
      }),
    ).toBe(VINTAGE_GAP_ABSENCE_BASIS);
  });
});
