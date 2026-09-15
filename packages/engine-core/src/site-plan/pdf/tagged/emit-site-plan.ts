/**
 * OPT-IN tagged site-plan export (504.2.2).
 *
 * NOTHING CALLS THIS BY DEFAULT. It is a second, additive entry point beside
 * `emitPdfSitePlan`, which is untouched and still the only path any existing
 * caller reaches. Selecting the accessible export is an explicit act by a
 * caller that wants it, per the operator ruling of 2026-08-20: the existing
 * generator is working software and its behaviour does not change.
 *
 * The pipeline is: render exactly as today, then rewrite the finished bytes
 * (`tagPdfBytes`). No geometry, font, colour or coordinate is recomputed; the
 * two outputs place every glyph at the same coordinate, which the accompanying
 * test asserts by comparing the drawn operands of both documents.
 */
import type { SitePlanModel } from "../../site-model.js";
import { countyDisplayName } from "../format.js";
import { emitPdfSitePlan, type EmitPdfSitePlanOptions, type PdfSitePlanResult } from "../render.js";
import { tagPdfBytes, type TagPdfResult } from "./tag-pdf.js";

/**
 * Natural language of the sheet text. Every string the renderer emits is
 * authored English and there is no localisation path; when one is added this
 * becomes a model field rather than a default.
 */
export const SITE_PLAN_LANGUAGE = "en-US";

/**
 * Document title. Composed from model values only. A parcel with no address on
 * file is titled by parcel id, never by a placeholder, which is the same rule
 * the printed sheet header follows.
 */
export function sitePlanDocumentTitle(model: SitePlanModel): string {
  const summary = model.summary;
  const county = countyDisplayName(summary.countyName);
  const where = summary.address ?? `parcel ${summary.parcelNodeId}`;
  return `Site plan: ${where}${county ? `, ${county}` : ""} (parcel ${summary.parcelNodeId})`;
}

export interface TaggedSitePlanResult {
  /** Tagged PDF bytes. */
  bytes: Uint8Array;
  /** Everything the untouched renderer reported, minus its (untagged) bytes. */
  render: Omit<PdfSitePlanResult, "bytes">;
  /** What the tagging pass wrote, including its declared limitations. */
  tagging: Omit<TagPdfResult, "bytes">;
  /** The untagged bytes, so a caller can keep or compare the default output. */
  untaggedBytes: Uint8Array;
}

export async function emitTaggedPdfSitePlan(
  model: SitePlanModel,
  options: EmitPdfSitePlanOptions = {},
): Promise<TaggedSitePlanResult> {
  const render = await emitPdfSitePlan(model, options);
  const tagged = await tagPdfBytes(render.bytes, {
    title: sitePlanDocumentTitle(model),
    language: SITE_PLAN_LANGUAGE,
  });
  const { bytes: renderBytes, ...renderRest } = render;
  const { bytes: taggedBytes, ...taggingRest } = tagged;
  return {
    bytes: taggedBytes,
    render: renderRest,
    tagging: taggingRest,
    untaggedBytes: renderBytes,
  };
}
