/**
 * Report manifests (P-120 reports re-cut, R4).
 *
 * A manifest names which sections a product renders and nothing else. It
 * cannot carry a fact value: `ReportSectionId` is a closed string-literal
 * union, and `ReportManifest` has no index signature, so a caller who tries
 * to smuggle a fact onto a manifest literal (e.g. `{ ...FEASIBILITY_MANIFEST,
 * zoningDistrict: "R-6" }`) fails TypeScript's excess-property check at
 * compile time — see `__tests__/report-manifest.type-test.ts` for the
 * `@ts-expect-error` fixture that proves it. This is the whole control for
 * the two-products-disagree-about-one-fact defect class: the type makes the
 * failure mode unreachable rather than policing it with a runtime checker.
 *
 * Only `FEASIBILITY_MANIFEST` has a real renderer behind it this round
 * (`pdf/feasibility.ts`, R5). `SITE_PLAN_MANIFEST`, `X_RAY_MANIFEST` and
 * `FLOOD_MANIFEST` are defined here per the WDLL's own "shape" section and
 * used to prove `composeParcelReport`'s identity property (R1) without
 * cutting those products over — that is R6/R7, a different lane's scope.
 */

export type ReportSectionId =
  | "cover"
  | "fact-digest"
  | "drawing"
  | "summary"
  | "aerial"
  | "flood-cover"
  | "catchment"
  | "ponding"
  | "flow-paths"
  | "package";

export type ReportProduct = "site-plan" | "x-ray" | "flood" | "feasibility";

export interface ReportManifest {
  readonly product: ReportProduct;
  readonly sections: ReadonlyArray<ReportSectionId>;
}

function manifest(product: ReportProduct, sections: ReadonlyArray<ReportSectionId>): ReportManifest {
  return Object.freeze({ product, sections: Object.freeze([...sections]) });
}

export const SITE_PLAN_MANIFEST: ReportManifest = manifest("site-plan", ["drawing", "summary", "aerial"]);

export const X_RAY_MANIFEST: ReportManifest = manifest("x-ray", [
  "cover",
  "fact-digest",
  "drawing",
  "summary",
  "aerial",
]);

export const FLOOD_MANIFEST: ReportManifest = manifest("flood", [
  "flood-cover",
  "catchment",
  "ponding",
  "flow-paths",
]);

export const FEASIBILITY_MANIFEST: ReportManifest = manifest("feasibility", [
  "cover",
  "fact-digest",
  "drawing",
  "summary",
  "aerial",
  "flood-cover",
  "catchment",
  "ponding",
  "flow-paths",
  "package",
]);

export function manifestIncludes(manifest: ReportManifest, section: ReportSectionId): boolean {
  return manifest.sections.includes(section);
}
