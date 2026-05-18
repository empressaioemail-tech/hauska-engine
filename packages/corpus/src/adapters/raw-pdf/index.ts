/**
 * Raw PDF adapter — Stream 1A P2-P3 stub.
 *
 * Per 49 §B.1 + 51 §Stream 1A: "Defer full implementation past first
 * batch — flagged as P3." This adapter implements the contract surface
 * so the conformance suite passes; the body is a no-op that returns
 * empty results until OCR integration lands.
 *
 * OCR provider per Phase 0: Claude vision primary, Tesseract fallback
 * (`_decisions/2026-05-18_substrate_v1_phase_0_close.md`).
 */

import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedCode,
  RawCode,
} from "../types.js";

export interface RawPdfAdapterOptions {
  /**
   * OCR provider hook. Until OCR integration lands, this is a no-op.
   * Signature deliberately permissive: callers provide a Buffer or
   * base64 string; the implementation returns the textual blocks.
   */
  ocr?: (pdfBytesBase64: string) => Promise<string>;
}

export class RawPdfAdapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: "raw-pdf",
    displayName: "Raw PDF (deferred)",
    sourceFamilies: ["pdf"],
    supportsDiscovery: false,
    supportsAmendments: false,
  };

  private readonly ocr?: RawPdfAdapterOptions["ocr"];

  constructor(opts: RawPdfAdapterOptions = {}) {
    this.ocr = opts.ocr;
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
    return {
      metadata: meta,
      contentType: "application/pdf",
      // Stub: real fetch reads the PDF off the source URL (or local
      // filesystem for manual-curation cases) and base64-encodes it.
      body: "",
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    if (!this.ocr) {
      // Defer full implementation per 49 §B.1 / 51 §Stream 1A. Return
      // an empty block stream — Stream 1B treats this as "nothing
      // ingested, jurisdiction not loadable" rather than malformed.
      return { metadata: raw.metadata, blocks: [] };
    }
    // OCR integration is gated on a separate session. When this fires,
    // the OCR output is split into paragraphs (one block per OCR
    // paragraph) and emitted to Stream 1B; heading inference happens
    // in 1B from font-size or layout signals.
    await this.ocr(raw.body);
    return { metadata: raw.metadata, blocks: [] };
  }
}
