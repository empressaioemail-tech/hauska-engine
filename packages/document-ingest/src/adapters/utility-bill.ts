/**
 * Utility-bill adapter (typed example).
 *
 * Classifies utility bills (electric / water / gas / sewer) and mints a
 * typed `utility-bill-record` atom: utility type, account id, usage,
 * amount, service period — the operational-overlay data a digital twin
 * consumes. Point-to: the bill PDF remains the source of truth.
 *
 * Structured parse over extracted text (injected extractor). NEVER throws.
 */

import type { UtilityBillRecordAtomInstance } from "@hauska-engine/atoms";

import { mintDocumentDerivedFields, stableEntityId } from "../mint.js";
import type {
  DocumentAdapter,
  ExtractionContext,
  ExtractionResult,
  PinnedDocument,
} from "../types.js";

export interface UtilityBillAdapterOptions {
  textExtractor?: (
    base64Body: string,
  ) => Promise<ReadonlyArray<{ page: number; text: string }>>;
  ocr?: (base64Body: string) => Promise<string>;
}

export const UTILITY_BILL_ADAPTER_NAME = "document-ingest:utility-bill";
export const UTILITY_BILL_DOCUMENT_TYPE = "utility-bill";

const UTILITY_SIGNALS =
  /\b(utility|electric|water|gas|sewer|kwh|kilowatt|account number|billing period|amount due|meter|therms|ccf|gallons)\b/i;

const UTILITY_TYPE_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\b(electric|kwh|kilowatt)\b/i, "electric"],
  [/\b(water|gallons|ccf)\b/i, "water"],
  [/\b(gas|therms)\b/i, "gas"],
  [/\b(sewer|wastewater)\b/i, "sewer"],
  [/\b(trash|refuse|solid waste)\b/i, "trash"],
];

export class UtilityBillAdapter implements DocumentAdapter {
  readonly name = UTILITY_BILL_ADAPTER_NAME;
  readonly displayName = "Utility Bill";
  readonly documentType = UTILITY_BILL_DOCUMENT_TYPE;

  private readonly textExtractor?: UtilityBillAdapterOptions["textExtractor"];
  private readonly ocr?: UtilityBillAdapterOptions["ocr"];

  constructor(opts: UtilityBillAdapterOptions = {}) {
    this.textExtractor = opts.textExtractor;
    this.ocr = opts.ocr;
  }

  classify(doc: PinnedDocument): number {
    const hay = `${doc.sourceRef ?? ""}`.toLowerCase();
    let score = 0;
    if (/bill|utility|invoice/.test(hay)) score += 0.3;
    const peek = plainPeek(doc);
    if (peek && UTILITY_SIGNALS.test(peek)) score += 0.6;
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
        reason: `utility-bill text extraction failed: ${reason}`,
        documentType: this.documentType,
      };
    }
    if (text.trim().length === 0) {
      return {
        atoms: [],
        status: "degraded",
        reason: "no extractable text from utility bill",
        documentType: this.documentType,
      };
    }

    const utilityType = classifyUtilityType(text);
    const accountIdentifier =
      matchOne(text, /account\s*(?:number|no\.?|#)?[:\s]+([\w-]{4,})/i) ?? "";
    const { usageQuantity, usageUnit } = parseUsage(text);
    const amountUsd = parseAmount(text);
    const { periodStart, periodEnd } = parsePeriod(text);

    const canonicalBody = {
      entityType: "utility-bill-record",
      utilityType,
      accountIdentifier,
      usageQuantity,
      usageUnit,
      amountUsd,
      periodStart,
      periodEnd,
      sourceDocumentCid: doc.cid,
    };
    const fields = mintDocumentDerivedFields(doc, ctx, this.name, {
      canonicalBody,
      sourceQuality: this.textExtractor ? "born-digital-pdf" : "ocr",
      extractionConfidence: amountUsd != null && usageQuantity != null ? 0.85 : 0.65,
    });
    const entityId = stableEntityId(doc.cid, fields.contentHash);
    const atom: UtilityBillRecordAtomInstance = {
      ...fields,
      entityType: "utility-bill-record",
      entityId,
      utilityType,
      accountIdentifier,
      usageQuantity,
      usageUnit,
      amountUsd,
      periodStart,
      periodEnd,
      ...(ctx.contextRefs ? { contextRefs: ctx.contextRefs } : {}),
    };
    return { atoms: [atom], status: "ok", documentType: this.documentType };
  }
}

function classifyUtilityType(text: string): string {
  for (const [re, type] of UTILITY_TYPE_MAP) {
    if (re.test(text)) return type;
  }
  return "unknown";
}

function parseUsage(text: string): {
  usageQuantity: number | null;
  usageUnit: string;
} {
  const m =
    /([\d,]+(?:\.\d+)?)\s*(kwh|kilowatt[- ]?hours?|gallons?|gal|ccf|therms?)\b/i.exec(
      text,
    );
  if (!m || !m[1] || !m[2]) return { usageQuantity: null, usageUnit: "" };
  const q = Number(m[1].replace(/,/g, ""));
  return {
    usageQuantity: Number.isFinite(q) ? q : null,
    usageUnit: normalizeUnit(m[2]),
  };
}

function normalizeUnit(raw: string): string {
  const u = raw.toLowerCase();
  if (u.startsWith("kwh") || u.startsWith("kilowatt")) return "kWh";
  if (u.startsWith("gal")) return "gal";
  if (u === "ccf") return "ccf";
  if (u.startsWith("therm")) return "therms";
  return raw;
}

function parseAmount(text: string): number | null {
  const m =
    /(?:amount\s*due|total\s*(?:due|amount)|balance)[:\s]*\$?\s*([\d,]+\.\d{2})/i.exec(
      text,
    ) ?? /\$\s*([\d,]+\.\d{2})/.exec(text);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parsePeriod(text: string): {
  periodStart: string | null;
  periodEnd: string | null;
} {
  const m =
    /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|to|through|–)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(
      text,
    );
  if (!m || !m[1] || !m[2]) return { periodStart: null, periodEnd: null };
  return { periodStart: toIso(m[1]), periodEnd: toIso(m[2]) };
}

function toIso(mdy: string): string | null {
  const parts = mdy.split("/");
  if (parts.length !== 3) return null;
  let [mm, dd, yy] = parts as [string, string, string];
  if (yy.length === 2) yy = `20${yy}`;
  const iso = `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

function matchOne(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m && m[1] ? m[1].trim() : null;
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
  textExtractor?: UtilityBillAdapterOptions["textExtractor"],
  ocr?: UtilityBillAdapterOptions["ocr"],
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
