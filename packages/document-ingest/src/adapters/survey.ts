/**
 * Survey / plat adapter (typed example).
 *
 * Classifies land-survey / plat documents and mints a typed
 * `survey-record` atom: parcel descriptor, acreage, boundary calls,
 * surveyor, recording reference — a point-to claim referencing the
 * pinned survey blob, which remains the source of truth.
 *
 * Extraction is intentionally a lightweight structured parse over the
 * extracted text (injected extractor, same shape as the generic adapter).
 * It NEVER throws; an unreadable / non-survey body degrades honestly.
 */

import type { SurveyRecordAtomInstance } from "@hauska-engine/atoms";

import { mintDocumentDerivedFields, stableEntityId } from "../mint.js";
import type {
  DocumentAdapter,
  ExtractionContext,
  ExtractionResult,
  PinnedDocument,
} from "../types.js";

export interface SurveyAdapterOptions {
  textExtractor?: (
    base64Body: string,
  ) => Promise<ReadonlyArray<{ page: number; text: string }>>;
  ocr?: (base64Body: string) => Promise<string>;
}

export const SURVEY_ADAPTER_NAME = "document-ingest:survey";
export const SURVEY_DOCUMENT_TYPE = "survey";

const SURVEY_SIGNALS =
  /\b(survey|plat|boundary|bearing|metes and bounds|point of beginning|acre|surveyor|R\.?P\.?L\.?S\.?|record of survey|subdivision plat)\b/i;

export class SurveyAdapter implements DocumentAdapter {
  readonly name = SURVEY_ADAPTER_NAME;
  readonly displayName = "Land Survey / Plat";
  readonly documentType = SURVEY_DOCUMENT_TYPE;

  private readonly textExtractor?: SurveyAdapterOptions["textExtractor"];
  private readonly ocr?: SurveyAdapterOptions["ocr"];

  constructor(opts: SurveyAdapterOptions = {}) {
    this.textExtractor = opts.textExtractor;
    this.ocr = opts.ocr;
  }

  classify(doc: PinnedDocument): number {
    const hay = `${doc.sourceRef ?? ""}`.toLowerCase();
    let score = 0;
    if (/survey|plat/.test(hay)) score += 0.5;
    // Peek at plain-text bodies for signal words.
    const peek = plainPeek(doc);
    if (peek && SURVEY_SIGNALS.test(peek)) score += 0.5;
    return Math.min(score, 0.95);
  }

  async extract(
    doc: PinnedDocument,
    ctx: ExtractionContext,
  ): Promise<ExtractionResult> {
    let text: string;
    try {
      text = await readText(doc, this.textExtractor, this.ocr);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        atoms: [],
        status: "degraded",
        reason: `survey text extraction failed: ${reason}`,
        documentType: this.documentType,
      };
    }
    if (text.trim().length === 0) {
      return {
        atoms: [],
        status: "degraded",
        reason: "no extractable text from survey document",
        documentType: this.documentType,
      };
    }

    const parcelDescriptor =
      matchOne(text, /\b(lot\s+\w+[,\s]+block\s+\w+[^.\n]*)/i) ??
      matchOne(text, /\b(tract\s+[\w-]+)/i) ??
      matchOne(text, /\b(parcel\s+[\w-]+)/i) ??
      "unspecified parcel";
    const acreage = parseAcreage(text);
    const boundaryCalls = matchAll(
      text,
      /\b([NS]\s*\d{1,2}[°\s]\d{1,2}['\s]\d{1,2}"?\s*[EW][^.\n]*)/gi,
      12,
    );
    const surveyor =
      matchOne(text, /\b([A-Z][a-z]+ [A-Z][a-z]+,?\s*R\.?P\.?L\.?S\.?)/) ??
      matchOne(text, /surveyor[:\s]+([^\n.]{3,60})/i) ??
      "";
    const recordingReference =
      matchOne(text, /\b(vol(?:ume)?\.?\s*\d+[,\s]+p(?:age|g)?\.?\s*\d+)/i) ??
      matchOne(text, /\b(instrument\s+(?:no\.?\s*)?[\w-]+)/i) ??
      "";

    const canonicalBody = {
      entityType: "survey-record",
      parcelDescriptor,
      acreage,
      boundaryCalls,
      surveyor,
      recordingReference,
      sourceDocumentCid: doc.cid,
    };
    // A survey record is a claim extracted FROM a document → point-to
    // (no text passed as unit-of-meaning).
    const fields = mintDocumentDerivedFields(doc, ctx, this.name, {
      canonicalBody,
      sourceQuality: this.textExtractor ? "born-digital-pdf" : "ocr",
      extractionConfidence: parcelDescriptor === "unspecified parcel" ? 0.6 : 0.85,
    });
    const entityId = stableEntityId(doc.cid, fields.contentHash);
    const atom: SurveyRecordAtomInstance = {
      ...fields,
      entityType: "survey-record",
      entityId,
      parcelDescriptor,
      acreage,
      boundaryCalls,
      surveyor,
      recordingReference,
      ...(ctx.contextRefs ? { contextRefs: ctx.contextRefs } : {}),
    };
    return { atoms: [atom], status: "ok", documentType: this.documentType };
  }
}

function parseAcreage(text: string): number | null {
  const m = /([\d,]+(?:\.\d+)?)\s*acres?\b/i.exec(text);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function matchOne(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m && m[1] ? m[1].replace(/\s+/g, " ").trim() : null;
}

function matchAll(text: string, re: RegExp, cap: number): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(text)) !== null && out.length < cap) {
    if (m[1]) out.push(m[1].replace(/\s+/g, " ").trim());
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return out;
}

function plainPeek(doc: PinnedDocument): string | null {
  if (doc.encoding === "utf8" || doc.contentType.startsWith("text/")) {
    return doc.encoding === "utf8"
      ? doc.body
      : Buffer.from(doc.body, "base64").toString("utf8");
  }
  return null;
}

async function readText(
  doc: PinnedDocument,
  textExtractor?: SurveyAdapterOptions["textExtractor"],
  ocr?: SurveyAdapterOptions["ocr"],
): Promise<string> {
  if (doc.encoding === "utf8" || doc.contentType.startsWith("text/")) {
    return doc.encoding === "utf8"
      ? doc.body
      : Buffer.from(doc.body, "base64").toString("utf8");
  }
  if (textExtractor) {
    const pages = await textExtractor(doc.body);
    return pages.map((p) => p.text).join("\n");
  }
  if (ocr) {
    return ocr(doc.body);
  }
  return "";
}
