/**
 * ICC Code Connect adapter — Stream 1A, Layer 1 model-code base (ADR-019).
 *
 * Conforms to the `CodeSourceAdapter` contract. Unlike the Municode /
 * raw-PDF adapters, the source is a structured JSON API, so `fetch()`
 * assembles a whole I-Code edition (`IccCodeDocument`) via the
 * `CodeConnectClient` and `normalize()` is a pure JSON walk into the
 * common `NormalizedBlock` stream.
 *
 * Mode follows the injected `CodeConnectClient` (see
 * `code-connect-client.ts`):
 *   - mock         — fixtures wired; hermetic, the conformance + unit
 *                    suites' default, mirroring `RawPdfAdapter`'s stub.
 *   - live         — OAuth2 credentials wired.
 *   - unconfigured — neither; `fetch()` yields an empty body and
 *                    `normalize()` empty blocks, so a bare
 *                    `new IccCodeConnectAdapter()` stays green and inert
 *                    until the credential secret is populated.
 *
 * This adapter produces the standard `NormalizedBlock` stream only; the
 * ADR-019 Layer 1 deep-link footing (a `code-section` whose `bodyText`
 * is the reasoning layer and whose `verbatimTextDeepLink` is set) is the
 * model-code structural extractor's job (Lane E deliverable 2), which
 * consumes this stream.
 */

import {
  CodeConnectClient,
  codeConnectCredentialsFromEnv,
  type CodeConnectFixtures,
  type CodeConnectSection,
  type IccCodeDocument,
} from "./code-connect-client.js";
import { RespectfulFetch } from "../http.js";
import type {
  AdapterCapabilities,
  CodeMetadata,
  CodeReference,
  CodeSourceAdapter,
  NormalizedBlock,
  NormalizedCode,
  RawCode,
} from "../types.js";

export * from "./code-connect-client.js";

/**
 * The synthetic tenant the shared Layer 1 model-code base ingests
 * under. Model codes are not jurisdiction-specific (ADR-019): one
 * `code-edition` per I-Code edition, referenced by every city that
 * adopts it. `"icc-model-code"` is a build-time decision — confirm it
 * against the eventual `jurisdiction-corpus` modeling for Layer 1.
 */
export const ICC_MODEL_CODE_TENANT = "icc-model-code";

/** ICC Code Connect content-type tag on the assembled `RawCode` body. */
const ICC_CONTENT_TYPE = "application/json";

export interface IccCodeConnectAdapterOptions {
  /** Pre-built client (lets tests inject fixtures / stub the network). */
  client?: CodeConnectClient;
  /** OAuth2 credentials — selects live mode when no `client` is given. */
  credentials?: { clientId: string; clientSecret: string };
  /** Fixture set — selects mock mode when no `client` is given. */
  fixtures?: CodeConnectFixtures;
  /** Shared respectful-fetch client. */
  http?: RespectfulFetch;
  /** Tenant the shared model-code base ingests under. */
  modelCodeTenant?: string;
}

const REFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  referenceType:
    | "see"
    | "notwithstanding"
    | "subject-to"
    | "as-defined-in"
    | "amends"
    | "supersedes"
    | "unknown";
}> = [
  { pattern: /\bnotwithstanding\b/i, referenceType: "notwithstanding" },
  { pattern: /\bsubject to\b/i, referenceType: "subject-to" },
  { pattern: /\bas defined in\b/i, referenceType: "as-defined-in" },
  { pattern: /\bin accordance with\b/i, referenceType: "subject-to" },
  { pattern: /\bsee\b/i, referenceType: "see" },
];

/**
 * Model-code cross-reference pattern. I-Code prose cites sister
 * sections by name ("Section R301.2", "Table R301.2(1)", "Chapter 11")
 * rather than the `§` glyph; the capture group is the target label.
 */
const MODEL_CODE_REFERENCE_RE =
  /\b(?:Sections?|Tables?|Chapters?|§)\s+([A-Z]?\d[\w.()-]*)/g;

function inferReferenceType(
  text: string,
):
  | "see"
  | "notwithstanding"
  | "subject-to"
  | "as-defined-in"
  | "amends"
  | "supersedes"
  | "unknown" {
  for (const { pattern, referenceType } of REFERENCE_PATTERNS) {
    if (pattern.test(text)) return referenceType;
  }
  return "unknown";
}

export class IccCodeConnectAdapter implements CodeSourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    name: "icc-code-connect",
    displayName: "ICC Code Connect",
    sourceFamilies: ["icc-code-connect", "icc-icodes"],
    // Code Connect enumerates titles, so discovery is supported.
    supportsDiscovery: true,
    // Model-code base only. Layer 2 jurisdictional amendment overlays
    // are produced by the layered-substrate ingest path, not here.
    supportsAmendments: false,
  };

  private readonly client: CodeConnectClient;
  private readonly modelCodeTenant: string;

  constructor(opts: IccCodeConnectAdapterOptions = {}) {
    this.client =
      opts.client ??
      new CodeConnectClient({
        // When no client is injected, credentials default from the
        // environment; an empty secret leaves the client unconfigured.
        credentials: opts.credentials ?? codeConnectCredentialsFromEnv(),
        fixtures: opts.fixtures,
        http: opts.http,
      });
    this.modelCodeTenant = opts.modelCodeTenant ?? ICC_MODEL_CODE_TENANT;
  }

  /** The resolved client mode — `"live" | "mock" | "unconfigured"`. */
  get mode(): CodeConnectClient["mode"] {
    return this.client.mode;
  }

  async discover(): Promise<ReadonlyArray<CodeReference>> {
    const titles = await this.client.listTitles();
    return titles.map((title) => ({
      sourceId: title.titleId,
      jurisdictionTenant: this.modelCodeTenant,
      editionLabel: `${title.year} ${title.name}`,
      sourceUrl: this.viewerUrlForTitle(title.codeAbbrev, title.year),
    }));
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
    let document: IccCodeDocument | null = null;
    try {
      document = await this.client.fetchCodeDocument(reference.sourceId);
    } catch (err) {
      // Fail soft, mirroring the sibling adapters: an empty body marks
      // the edition not-loadable rather than malformed.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        metadata: { ...meta, extra: { ...(meta.extra ?? {}), fetchError: reason } },
        contentType: ICC_CONTENT_TYPE,
        body: "",
      };
    }
    if (!document) {
      return { metadata: meta, contentType: ICC_CONTENT_TYPE, body: "" };
    }
    return {
      metadata: { ...meta, fetchedAt: new Date().toISOString() },
      contentType: ICC_CONTENT_TYPE,
      body: JSON.stringify(document),
    };
  }

  async normalize(raw: RawCode): Promise<NormalizedCode> {
    if (raw.body.length === 0) {
      return { metadata: raw.metadata, blocks: [] };
    }
    if (!raw.contentType.startsWith(ICC_CONTENT_TYPE)) {
      throw new Error(
        `IccCodeConnectAdapter.normalize: unsupported contentType "${raw.contentType}"`,
      );
    }
    const document = JSON.parse(raw.body) as IccCodeDocument;
    const blocks: NormalizedBlock[] = [];

    for (const { chapter, sections } of document.chapters) {
      blocks.push({
        kind: "heading",
        depth: 1,
        text: `Chapter ${chapter.chapterNumber} ${chapter.heading}`.trim(),
        label: chapter.chapterNumber,
        sourceAnchor: `#${chapter.chapterId}`,
      });
      for (const section of sections) {
        this.emitSectionBlocks(blocks, section);
      }
    }

    return { metadata: raw.metadata, blocks };
  }

  /** Walk one section's content into the block stream. */
  private emitSectionBlocks(
    blocks: NormalizedBlock[],
    section: CodeConnectSection,
  ): void {
    blocks.push({
      kind: "heading",
      depth: 2,
      text: `${section.sectionNumber} ${section.heading}`.trim(),
      label: section.sectionNumber,
      sourceAnchor: `#${section.sectionId}`,
    });

    for (const node of section.content) {
      if (node.kind === "prose") {
        const text = node.text.trim();
        if (text.length === 0) continue;
        blocks.push({ kind: "paragraph", text });
        // Model-code prose cites sister sections inline; lift them into
        // typed cross-reference blocks, exactly as the Municode adapter
        // does for `§`-glyph references. The label char class admits
        // `.` (section numbers are dotted), so a citation ending a
        // sentence captures a trailing period — strip it, mirroring the
        // atomizer's `sniffAffectedSectionLabels` trim.
        for (const match of text.matchAll(MODEL_CODE_REFERENCE_RE)) {
          const label = (match[1] ?? "").replace(/[.,;:]+$/, "");
          if (!label) continue;
          blocks.push({
            kind: "cross-reference",
            referenceText: match[0].replace(/[.,;:]+$/, ""),
            referenceType: inferReferenceType(text),
            targetSectionLabel: label,
            referenceContext: text,
          });
        }
      } else if (node.kind === "table") {
        blocks.push({
          kind: "table",
          ...(node.caption ? { caption: node.caption } : {}),
          headers: node.headers,
          rows: node.rows,
        });
      } else {
        blocks.push({
          kind: "figure",
          ...(node.caption ? { caption: node.caption } : {}),
          ...(node.imageUrl ? { imageUrl: node.imageUrl } : {}),
        });
      }
    }

    // Definitions chapters (IRC/IBC Chapter 2) carry defined terms.
    for (const def of section.definedTerms ?? []) {
      blocks.push({
        kind: "definition",
        term: def.term,
        definitionText: def.definition,
        definedInSectionLabel: section.sectionNumber,
      });
    }
  }

  /**
   * The ICC free Digital Codes viewer URL for an I-Code edition. The
   * deep-link footing target per ADR-019.
   *
   * @assumption The free viewer lives at
   * `https://codes.iccsafe.org/content/{CODE}{YEAR}` (e.g.
   * `IRC2021`). The viewer is a SPA; whether it exposes per-section
   * anchors is an ADR-019 open decision ("deep-link target
   * granularity"). The model-code extractor refines section-level
   * deep-links once the anchor scheme is confirmed.
   */
  private viewerUrlForTitle(codeAbbrev: string, year: number): string {
    return `https://codes.iccsafe.org/content/${codeAbbrev}${year}`;
  }
}
