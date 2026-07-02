/**
 * Generic PDF / text adapter.
 *
 * The fallback adapter for any document without a dedicated typed adapter.
 * It extracts text (born-digital via an injected text extractor, or scanned
 * via an injected OCR hook — the same hook shape as the corpus
 * `RawPdfAdapter`) and mints one `document-derived-claim` atom per salient
 * line / paragraph, each a point-to claim referencing the pinned blob.
 *
 * It NEVER throws: an unreadable body yields `status: "degraded"` with a
 * reason and zero atoms (the blob is still pinned upstream).
 *
 * Extractor injection mirrors `RawPdfAdapter`: production wires the real
 * pdfjs / Claude-vision OCR path; tests inject a stub. When neither is
 * wired and the body is not already plain text, the adapter degrades
 * honestly rather than guessing.
 */

import type {
  DocumentDerivedClaimAtomInstance,
  DocumentDerivedAtomInstance,
} from "@hauska-engine/atoms";

import {
  mintDocumentDerivedFields,
  stableEntityId,
} from "../mint.js";
import type {
  DocumentAdapter,
  ExtractionContext,
  ExtractionResult,
  PinnedDocument,
} from "../types.js";

/** Injected text extractors — one for born-digital, one for scanned. */
export interface GenericPdfAdapterOptions {
  /**
   * Born-digital text extractor: given the base64 PDF body, returns page
   * texts. Production wires the pdfjs extractor; tests inject a stub.
   */
  textExtractor?: (
    base64Body: string,
  ) => Promise<ReadonlyArray<{ page: number; text: string }>>;
  /**
   * OCR hook for scanned PDFs / images: given the base64 body, returns
   * plain text. Used when no `textExtractor` is wired.
   */
  ocr?: (base64Body: string) => Promise<string>;
  /** Max claim atoms minted from one document (bounds runaway splits). Default 500. */
  maxClaims?: number;
  /** Min characters for a line to become a claim atom. Default 12. */
  minClaimChars?: number;
}

export const GENERIC_PDF_ADAPTER_NAME = "document-ingest:generic-pdf";
export const GENERIC_PDF_DOCUMENT_TYPE = "generic-pdf";

export class GenericPdfAdapter implements DocumentAdapter {
  readonly name = GENERIC_PDF_ADAPTER_NAME;
  readonly displayName = "Generic PDF / Text";
  readonly documentType = GENERIC_PDF_DOCUMENT_TYPE;

  private readonly textExtractor?: GenericPdfAdapterOptions["textExtractor"];
  private readonly ocr?: GenericPdfAdapterOptions["ocr"];
  private readonly maxClaims: number;
  private readonly minClaimChars: number;

  constructor(opts: GenericPdfAdapterOptions = {}) {
    this.textExtractor = opts.textExtractor;
    this.ocr = opts.ocr;
    this.maxClaims = opts.maxClaims ?? 500;
    this.minClaimChars = opts.minClaimChars ?? 12;
  }

  /**
   * Low non-zero floor: the generic adapter is always a valid fallback but
   * never outscores a confident typed adapter.
   */
  classify(_doc: PinnedDocument): number {
    return 0.1;
  }

  async extract(
    doc: PinnedDocument,
    ctx: ExtractionContext,
  ): Promise<ExtractionResult> {
    let pages: ReadonlyArray<{ page: number; text: string }>;
    try {
      pages = await this.readPages(doc);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        atoms: [],
        status: "degraded",
        reason: `text extraction failed: ${reason}`,
        documentType: this.documentType,
      };
    }

    const totalText = pages.map((p) => p.text).join("").trim();
    if (totalText.length === 0) {
      return {
        atoms: [],
        status: "degraded",
        reason:
          "no extractable text (scanned document without OCR, or empty body)",
        documentType: this.documentType,
      };
    }

    const sourceQuality = this.textExtractor ? "born-digital-pdf" : "ocr";
    const atoms: DocumentDerivedAtomInstance[] = [];

    for (const { page, text } of pages) {
      const lines = splitClaims(text, this.minClaimChars);
      for (const line of lines) {
        if (atoms.length >= this.maxClaims) break;
        atoms.push(this.mintClaim(doc, ctx, page, line, sourceQuality));
      }
      if (atoms.length >= this.maxClaims) break;
    }

    if (atoms.length === 0) {
      return {
        atoms: [],
        status: "empty",
        reason: "text extracted but no salient claims met the minimum length",
        documentType: this.documentType,
      };
    }

    return { atoms, status: "ok", documentType: this.documentType };
  }

  private async readPages(
    doc: PinnedDocument,
  ): Promise<ReadonlyArray<{ page: number; text: string }>> {
    // Already plain text (txt / csv / md upload) — no extractor needed.
    if (doc.encoding === "utf8" || doc.contentType.startsWith("text/")) {
      const text = doc.encoding === "utf8" ? doc.body : decodeBase64(doc.body);
      return [{ page: 1, text }];
    }
    if (this.textExtractor) {
      return this.textExtractor(doc.body);
    }
    if (this.ocr) {
      const text = await this.ocr(doc.body);
      return [{ page: 1, text }];
    }
    // Binary body, no extractor and no OCR wired: honest empty so the
    // caller degrades rather than guessing.
    return [{ page: 1, text: "" }];
  }

  private mintClaim(
    doc: PinnedDocument,
    ctx: ExtractionContext,
    page: number,
    line: string,
    sourceQuality: string,
  ): DocumentDerivedClaimAtomInstance {
    const title = line.length > 80 ? `${line.slice(0, 77)}...` : line;
    // A short line IS its own unit of meaning → embed-with; a long
    // paragraph is a claim FROM the doc → point-to (decision rule).
    const isUnitOfMeaning = line.length <= 240;
    const canonicalBody = {
      entityType: "document-derived-claim",
      documentType: this.documentType,
      title,
      text: line,
      page,
      sourceDocumentCid: doc.cid,
    };
    const fields = mintDocumentDerivedFields(doc, ctx, this.name, {
      canonicalBody,
      sourceQuality,
      text: line,
      isUnitOfMeaning,
      extractionRegion: { page, locator: `page-${page}` },
    });
    const entityId = stableEntityId(doc.cid, fields.contentHash);
    return {
      ...fields,
      entityType: "document-derived-claim",
      entityId,
      title,
      documentType: this.documentType,
      ...(ctx.contextRefs ? { contextRefs: ctx.contextRefs } : {}),
    };
  }
}

/** Split extracted page text into candidate claim lines. */
function splitClaims(text: string, minChars: number): ReadonlyArray<string> {
  return text
    .split(/\r?\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= minChars);
}

function decodeBase64(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}
