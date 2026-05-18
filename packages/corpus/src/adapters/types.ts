/**
 * Adapter contract — Stream 1A.
 *
 * Every code-source adapter (Municode HTML, eCode360, raw PDF, jurisdiction
 * direct, manual-curation) implements the same four-method interface:
 *
 *   discover()         → list available editions for a source
 *   fetch(reference)   → pull raw content for one edition
 *   metadata(reference)→ source-level metadata (jurisdiction, edition string,
 *                        publication date, source URL)
 *   normalize(raw)     → convert source-specific format into the common
 *                        intermediate structure consumed by Stream 1B
 *
 * The normalized intermediate is a flat ordered stream of typed
 * `NormalizedBlock` items plus document-level metadata. Stream 1B walks
 * this stream to infer the structural tree (chapter / article / section /
 * subsection / definition / cross-reference / amendment / note).
 *
 * The contract is **locked at Sync 2** (this signal is the trigger).
 * Adapter implementations conform to it; the conformance suite in
 * `__fixtures__/conformance.ts` runs the same assertions against every
 * adapter so divergence surfaces in CI rather than at first-city test.
 */

/**
 * A pointer to one edition of one jurisdiction's code, in the form the
 * adapter understands. The opaque `sourceId` is whatever the adapter
 * needs to look the edition up again later (a Municode microsite slug,
 * an eCode360 doc-id, a file path for raw-PDF).
 */
export interface CodeReference {
  /** Adapter's own identifier for this edition. */
  sourceId: string;

  /** Human-recognizable jurisdiction tenant (e.g., `bastrop-tx`). */
  jurisdictionTenant: string;

  /** Human-recognizable edition label (e.g., `"2024 Bastrop UDC"`). */
  editionLabel: string;

  /**
   * Adapter-specific source URL. Used for provenance — every atom this
   * adapter produces carries this in its history layer.
   */
  sourceUrl: string;
}

/**
 * Document-level metadata returned by `metadata(reference)`. Mirrors the
 * provenance fields every atom this adapter produces will carry.
 */
export interface CodeMetadata {
  jurisdictionTenant: string;
  jurisdictionName: string;
  editionLabel: string;

  /** ISO-8601 date string. Empty when the source does not publish one. */
  publicationDate: string;

  /** Adapter name (e.g., `"municode-html"`). */
  sourceAdapter: string;

  /** Source URL (canonical link for citation). */
  sourceUrl: string;

  /** ISO-8601 timestamp when fetch() completed for this reference. */
  fetchedAt: string;

  /** Free-form. Some adapters carry per-source notes (e.g., region codes). */
  extra?: Record<string, string>;
}

/**
 * Raw fetch output. The adapter does not interpret content — it carries
 * source bytes (HTML text, PDF bytes encoded base64, JSON string) plus
 * a content-type tag so `normalize()` can dispatch.
 */
export interface RawCode {
  metadata: CodeMetadata;

  /**
   * Content-type tag. Adapter-defined but common values include:
   *   "text/html"          (Municode HTML, eCode360 HTML fallback)
   *   "application/json"   (eCode360 API)
   *   "application/pdf"    (raw PDF; body is base64)
   *   "text/plain"         (manual-curation escape hatch)
   */
  contentType: string;

  /** Raw source content. Encoding depends on contentType. */
  body: string;

  /**
   * Optional secondary asset map. Some sources fan out (HTML page index +
   * per-section pages). The adapter carries them all here; `normalize()`
   * reconciles them into a single block stream.
   */
  assets?: Record<string, { contentType: string; body: string }>;
}

/**
 * Typed source-block categories the adapter emits during normalization.
 *
 * The schema deliberately stays low-level: structural inference (which
 * heading is a chapter vs. an article, what section number a paragraph
 * belongs to) happens in Stream 1B, not here. Adapters classify
 * primitives; extraction infers hierarchy.
 */
export type NormalizedBlockKind =
  /** A heading line. The adapter records depth (1..6) and visible text. */
  | "heading"
  /** A run of body prose under the current heading scope. */
  | "paragraph"
  /** A definition entry. Used by glossary sections + inline definitions. */
  | "definition"
  /** A typed citation to another part of the code or an external doc. */
  | "cross-reference"
  /** A table block. Carries rows opaquely for downstream rendering. */
  | "table"
  /** A figure / image / diagram caption + URL. */
  | "figure"
  /** A non-normative note / comment / commentary. */
  | "note"
  /** An amendment metadata block. Drives B.5 version-tracking. */
  | "amendment-record";

/**
 * One typed block emitted by `normalize()`. Adapters produce an ordered
 * stream; Stream 1B walks the stream once to build the structural tree.
 */
export type NormalizedBlock =
  | {
      kind: "heading";
      /** 1 = top-level chapter; 6 = deepest subsection heading. */
      depth: number;
      text: string;
      /** If the source labels the heading (e.g. "§ 5.04 Setbacks"), carry it. */
      label?: string;
      /** Adapter-specific anchor — usually a deep-link fragment. */
      sourceAnchor?: string;
    }
  | {
      kind: "paragraph";
      text: string;
      /** Adapter-detected subsection label (e.g. "(b)(2)") if the source marks it. */
      subsectionLabel?: string;
    }
  | {
      kind: "definition";
      term: string;
      definitionText: string;
      /** If the source localizes the definition to a section, carry the label. */
      definedInSectionLabel?: string;
    }
  | {
      kind: "cross-reference";
      /** As-printed citation text ("see § 5.04(b)"). */
      referenceText: string;
      /** Initial taxonomy seed per ADR-010 §Link taxonomy. */
      referenceType:
        | "see"
        | "notwithstanding"
        | "subject-to"
        | "as-defined-in"
        | "amends"
        | "supersedes"
        | "unknown";
      /**
       * Best-effort parse of the target section label ("5.04(b)"). Stream 1B
       * resolves this to a target atom CID once the corpus is atomized.
       */
      targetSectionLabel?: string;
      /** Optional surrounding sentence/clause for retrieval signal. */
      referenceContext?: string;
    }
  | {
      kind: "table";
      /** Optional caption. */
      caption?: string;
      /** Header row labels. */
      headers: ReadonlyArray<string>;
      /** Body rows; one inner array per row. */
      rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | {
      kind: "figure";
      caption?: string;
      imageUrl?: string;
    }
  | {
      kind: "note";
      /** Adapter-detected note category (`historical`, `editor`, `commentary`, etc.). */
      noteType: string;
      text: string;
    }
  | {
      kind: "amendment-record";
      ordinanceId: string;
      effectiveDate: string;
      authority: string;
      affectedSectionLabels: ReadonlyArray<string>;
      amendmentText: string;
    };

/**
 * Output of `normalize()`. Carries the document metadata alongside the
 * block stream so consumers don't have to round-trip through the
 * adapter.
 */
export interface NormalizedCode {
  metadata: CodeMetadata;
  blocks: ReadonlyArray<NormalizedBlock>;
}

/**
 * Adapter capability descriptor. Surfaced via `capabilities` so
 * discovery surfaces / job runners can route work to capable adapters.
 */
export interface AdapterCapabilities {
  /** Stable identifier used in atom provenance (e.g., `"municode-html"`). */
  name: string;
  /** Human-readable label. */
  displayName: string;
  /** Source families this adapter handles. */
  sourceFamilies: ReadonlyArray<string>;
  /** Whether discover() enumerates without prior input. */
  supportsDiscovery: boolean;
  /** Whether the adapter handles amendments (B.5 ingestion path). */
  supportsAmendments: boolean;
}

/**
 * The adapter contract every implementation honors.
 */
export interface CodeSourceAdapter {
  capabilities: AdapterCapabilities;

  /**
   * List available code editions this adapter can fetch. Pass options
   * (e.g., `{ region: "TX" }`) to scope. Adapters that cannot enumerate
   * (raw-PDF, manual-curation) return an empty array and document
   * `supportsDiscovery: false`.
   */
  discover(
    options?: Record<string, unknown>,
  ): Promise<ReadonlyArray<CodeReference>>;

  /**
   * Pull raw content for one reference. Implementations honor the
   * adapter's respectful-crawl-rate policy and document any
   * jurisdiction-specific rate limits.
   */
  fetch(reference: CodeReference): Promise<RawCode>;

  /**
   * Source-level metadata for one reference. Often a subset of `fetch()`
   * — adapters that can read headers cheaply implement this without
   * fetching the body.
   */
  metadata(reference: CodeReference): Promise<CodeMetadata>;

  /**
   * Convert raw source content into the common intermediate consumed by
   * Stream 1B. Pure function: same input always yields the same output.
   */
  normalize(raw: RawCode): Promise<NormalizedCode>;
}

/**
 * Convenience for adapter implementations: a typed-block iterable
 * builder. Adapters that build the block stream by appending can use
 * this to avoid hand-rolling an array.
 */
export class BlockStream {
  private readonly blocks: NormalizedBlock[] = [];

  push(block: NormalizedBlock): this {
    this.blocks.push(block);
    return this;
  }

  collect(): ReadonlyArray<NormalizedBlock> {
    return this.blocks;
  }
}
