/**
 * Raw PDF adapter — Stream 1A.
 *
 * Two text-extraction paths share the same NormalizedBlock surface:
 *
 *   - `textExtractor` hook (default for born-digital PDFs): extracts
 *     selectable text from publisher-embedded text streams. The default
 *     uses `pdfjs-dist` via `pdfjsTextExtractor`; callers can supply a
 *     custom extractor (or stub for tests).
 *   - `ocr` hook (scanned PDFs): runs OCR over rasterized pages per
 *     Phase 0 (Claude vision primary, Tesseract fallback). Selected
 *     when `textExtractor` is not provided and `ocr` is.
 *
 * When `textExtractor` is provided, `fetch()` actually downloads the
 * PDF over HTTP and base64-encodes the body. Without an extractor (and
 * no OCR), the adapter retains the original deferred-stub behavior:
 * empty block stream so Stream 1B treats the source as not-loadable
 * rather than malformed.
 *
 * First raw-PDF jurisdiction onboarded under this adapter: the Bastrop
 * Building Block (B3) Code (April 2025) at
 * `cityofbastrop.org/upload/page/0107/docs/B3/`, per the 2026-05-19
 * Sync 4.5 dispatch.
 */

import { Buffer } from "node:buffer";

import { RespectfulFetch } from "../http.js";
import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedCode,
  RawCode,
} from "../types.js";

import { pdfjsTextExtractor, type PdfTextExtractor, type PdfPageText } from "./pdfjs-extractor.js";
import { pdfPagesToBlocks, type PdfNormalizeOptions } from "./normalize.js";

export type { PdfPageText, PdfTextExtractor } from "./pdfjs-extractor.js";
export { pdfjsTextExtractor } from "./pdfjs-extractor.js";
export { pdfPagesToBlocks } from "./normalize.js";
export type { PdfNormalizeOptions } from "./normalize.js";

export interface RawPdfAdapterOptions {
  /**
   * Born-digital text extractor. Defaults to the pdfjs-dist-backed
   * extractor. Tests inject a stub returning canned page text.
   *
   * When set (or defaulted), `fetch()` downloads the PDF over HTTP and
   * `normalize()` walks the extracted page text via
   * `pdfPagesToBlocks`.
   */
  textExtractor?: PdfTextExtractor;
  /**
   * OCR hook. Used when no `textExtractor` is provided and the source
   * PDF is scanned (no embedded text streams).
   *
   * NOTE: when `textExtractor` is provided, `ocr` is unused.
   */
  ocr?: (pdfBytesBase64: string) => Promise<string>;
  /**
   * Shared respectful-fetch client. The adapter cooperates with sibling
   * Stream 1A adapters on per-host rate-limiting.
   */
  http?: RespectfulFetch;
  /**
   * Optional normalize-time options (e.g., custom ignore regex for
   * header / footer suppression on jurisdiction-specific PDFs).
   */
  normalizeOptions?: PdfNormalizeOptions;
  /**
   * Override the adapter capabilities `name` so the same adapter can be
   * registered under a publisher-specific tag (e.g., `bastrop-b3` for
   * provenance) while sharing the implementation. Defaults to
   * `"raw-pdf"`.
   */
  capabilitiesNameOverride?: string;
  /** Override `displayName`. */
  capabilitiesDisplayNameOverride?: string;
}

export class RawPdfAdapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities;

  private readonly http: RespectfulFetch;
  private readonly textExtractor?: PdfTextExtractor;
  private readonly ocr?: RawPdfAdapterOptions["ocr"];
  private readonly normalizeOptions?: PdfNormalizeOptions;

  constructor(opts: RawPdfAdapterOptions = {}) {
    // No automatic default. Callers wire `textExtractor: pdfjsTextExtractor`
    // (or a stub in tests) explicitly. Constructing `new RawPdfAdapter()`
    // with no opts retains the original deferred-stub behavior so the
    // conformance suite stays green during pre-first-jurisdiction ingest.
    this.textExtractor = opts.textExtractor;
    this.ocr = opts.ocr;
    this.http = opts.http ?? new RespectfulFetch();
    this.normalizeOptions = opts.normalizeOptions;
    this.capabilities = {
      name: opts.capabilitiesNameOverride ?? "raw-pdf",
      displayName: opts.capabilitiesDisplayNameOverride ?? "Raw PDF",
      sourceFamilies: ["pdf"],
      supportsDiscovery: false,
      supportsAmendments: false,
    };
  }

  async discover(): Promise<ReadonlyArray<CodeReference>> {
    return [];
  }

  async metadata(reference: CodeReference): Promise<CodeMetadata> {
    return {
      jurisdictionTenant: reference.jurisdictionTenant,
      jurisdictionName: reference.editionLabel,
      editionLabel: reference.editionLabel,
      publicationDate: "",
      sourceAdapter: this.capabilities.name,
      sourceUrl: reference.sourceUrl,
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetch(reference: CodeReference): Promise<RawCode> {
    const meta = await this.metadata(reference);
    // With either hook configured, fetch() actually pulls bytes off the
    // sourceUrl and base64-encodes them. The deferred-stub path (no
    // extractor + no ocr) keeps the historical empty-body behavior so
    // existing tests / consumers that don't configure either hook stay
    // intact.
    if (!this.textExtractor && !this.ocr) {
      return {
        metadata: meta,
        contentType: "application/pdf",
        body: "",
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.http.fetchBytes(reference.sourceUrl);
    } catch (err) {
      // Surface fetch failures through an empty body — Stream 1B will
      // record the jurisdiction as not-loadable. We preserve the same
      // shape as MunicodeHtmlAdapter's fail-soft behavior.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        metadata: { ...meta, extra: { ...(meta.extra ?? {}), fetchError: reason } },
        contentType: "application/pdf",
        body: "",
      };
    }
    return {
      metadata: { ...meta, fetchedAt: new Date().toISOString() },
      contentType: "application/pdf",
      body: Buffer.from(bytes).toString("base64"),
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    if (raw.body.length === 0) {
      return { metadata: raw.metadata, blocks: [] };
    }
    if (this.textExtractor) {
      const pages = await this.textExtractor(raw.body);
      const blocks = pdfPagesToBlocks(pages, this.normalizeOptions);
      return { metadata: raw.metadata, blocks };
    }
    if (this.ocr) {
      // OCR returns plain text; treat the whole OCR output as a single
      // synthetic page so the same walker handles structure inference.
      const text = await this.ocr(raw.body);
      const pages: PdfPageText[] = [{ pageNumber: 1, text }];
      const blocks = pdfPagesToBlocks(pages, this.normalizeOptions);
      return { metadata: raw.metadata, blocks };
    }
    return { metadata: raw.metadata, blocks: [] };
  }
}
