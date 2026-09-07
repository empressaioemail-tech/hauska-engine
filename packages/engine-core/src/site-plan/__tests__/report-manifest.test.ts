import { describe, expect, it } from "vitest";

import {
  FEASIBILITY_MANIFEST,
  FLOOD_MANIFEST,
  SITE_PLAN_MANIFEST,
  X_RAY_MANIFEST,
  manifestIncludes,
} from "../report-manifest.js";

/**
 * R4 — the manifest names sections and cannot carry fact values. The
 * compiler-refusal half of this control is proven in
 * `../report-manifest.compile-check.ts` (a real src/ file `tsc --noEmit`
 * type-checks; `__tests__/**` is excluded from tsconfig and vitest does not
 * type-check at all, so a `@ts-expect-error` fixture here would prove
 * nothing). These are the runtime shape checks.
 */
describe("report manifests", () => {
  it("every manifest is a plain, frozen sections list — no fact-shaped payload riding along", () => {
    for (const m of [SITE_PLAN_MANIFEST, X_RAY_MANIFEST, FLOOD_MANIFEST, FEASIBILITY_MANIFEST]) {
      expect(Object.keys(m).sort()).toEqual(["product", "sections"]);
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.sections)).toBe(true);
      expect(m.sections.length).toBeGreaterThan(0);
    }
  });

  it("feasibility is the only manifest carrying the package layer", () => {
    expect(manifestIncludes(FEASIBILITY_MANIFEST, "package")).toBe(true);
    expect(manifestIncludes(SITE_PLAN_MANIFEST, "package")).toBe(false);
    expect(manifestIncludes(X_RAY_MANIFEST, "package")).toBe(false);
    expect(manifestIncludes(FLOOD_MANIFEST, "package")).toBe(false);
  });

  it("feasibility's sections are a superset of x-ray's and flood's — the manifest that contains everything", () => {
    for (const section of X_RAY_MANIFEST.sections) {
      expect(FEASIBILITY_MANIFEST.sections).toContain(section);
    }
    for (const section of FLOOD_MANIFEST.sections) {
      expect(FEASIBILITY_MANIFEST.sections).toContain(section);
    }
  });
});
