/**
 * Bastrop BDC (Ord. 2026-06 / Chapter 14) → fill existing stub edition
 * `bastrop_tx-bdc-2026-adopted`, close repealed B3, advance currentEditionId.
 *
 * WDLL: `_inbox/2026-07-29_BASTROP_BDC_setback_correction_WDLL.md` items 4–5.
 * Decision CORRECTION B: edition currency is first-class.
 *
 * Why a dedicated parser (not RawPdfAdapter caps-prefixed): BDC body
 * headings are title-case (`Sec. 14.02.003 District Requirements`), so
 * the B3 caps-prefixed walker (`isMostlyCapsLine`) emits zero sections.
 * This splitter is scoped to Chapter 14 `Sec. N.N.NNN` body headings and
 * remaps into the existing K1 stub entityId (does not invent a new edition).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AtomLink,
  CodeEditionAtomInstance,
  CodeSectionAtomInstance,
  JurisdictionCorpusAtomInstance,
} from "@hauska-engine/atoms";
import { pdfjsTextExtractor } from "@hauska-engine/corpus/adapters";
import { ingestEditionBundle, parseEditionBundle } from "@hauska-engine/corpus/edition-history";
import {
  InMemoryStorage,
  isCorpusSnapshot,
  type CorpusSnapshot,
} from "@hauska-engine/storage";

export const BDC_EDITION_ENTITY_ID = "bastrop_tx-bdc-2026-adopted";
export const B3_EDITION_ENTITY_ID = "bastrop_tx/bastrop-b3-code-april-2025";
export const IBC_EDITION_ENTITY_ID = "bastrop_tx-ibc-2018-adopted";
export const BASTROP_TENANT = "bastrop_tx";

/** Match IBC-boundary calendar day already in snapshot; WDLL item 5. */
export const B3_EFFECTIVE_TO = "2026-04-13T23:59:59.000Z";
export const BDC_EFFECTIVE_FROM = "2026-04-14T00:00:00.000Z";

export const BDC_ORDINANCE_PDF_URL =
  "https://www.cityofbastrop.org/page/open/18744/0/ORDINANCE%20NO.%202026-06%20B3%20Code%20Repeal%20and%20Bastrop%20Development%20Code%20Adoption.pdf";

const TOC_DOT_LEADERS = /\.{2,}/;
const TOC_PAGE_TAIL = /\s\d{1,4}$/;
const BODY_SEC_RE = /^Sec\.\s+(\d+\.\d+\.\d+)\s+(.*?)\s*$/i;

export interface ParsedBdcSection {
  sectionNumber: string;
  title: string;
  bodyText: string;
  pageStart: number;
}

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

function slugSectionNumber(sectionNumber: string): string {
  return sectionNumber.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function isTocLine(line: string): boolean {
  if (TOC_DOT_LEADERS.test(line)) return true;
  // Long Sec. lines ending in a bare page number are TOC entries.
  if (TOC_PAGE_TAIL.test(line) && line.length > 50) return true;
  return false;
}

/**
 * Split extracted PDF pages into Chapter 14 section atoms.
 * Skips ordinance preamble "Section N." and TOC pages (4–8).
 */
export function parseChapter14Sections(
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
): ParsedBdcSection[] {
  type Heading = {
    sectionNumber: string;
    title: string;
    pageStart: number;
    globalOffset: number;
  };

  const headings: Heading[] = [];
  let cursor = 0;
  const pageOffsets: number[] = [];
  const fullParts: string[] = [];

  for (const page of pages) {
    pageOffsets.push(cursor);
    fullParts.push(page.text);
    const pageText = page.text;
    // Skip dedicated TOC pages (Chapter 14 TOC sits on pages 4–8).
    const skipTocPage = page.pageNumber >= 4 && page.pageNumber <= 8;
    const lines = pageText.split(/\n/);
    let lineOffset = 0;
    for (const raw of lines) {
      const line = raw.trim();
      const abs = cursor + lineOffset;
      if (!skipTocPage && !isTocLine(line)) {
        const m = line.match(BODY_SEC_RE);
        if (m?.[1]) {
          const title = (m[2] ?? "")
            .replace(TOC_DOT_LEADERS, "")
            .replace(TOC_PAGE_TAIL, "")
            .trim();
          headings.push({
            sectionNumber: m[1],
            title: title || `Section ${m[1]}`,
            pageStart: page.pageNumber,
            globalOffset: abs,
          });
        }
      }
      lineOffset += raw.length + 1;
    }
    cursor += pageText.length + 2; // account for join separator
  }

  // Deduplicate: first body occurrence wins (TOC already skipped).
  const seen = new Set<string>();
  const unique: Heading[] = [];
  for (const h of headings) {
    if (seen.has(h.sectionNumber)) continue;
    // Chapter 14 only — ordinance preamble uses "Section 1." etc.
    if (!h.sectionNumber.startsWith("14.")) continue;
    seen.add(h.sectionNumber);
    unique.push(h);
  }

  const fullText = fullParts.join("\n\n");
  const sections: ParsedBdcSection[] = [];
  for (let i = 0; i < unique.length; i++) {
    const h = unique[i]!;
    const next = unique[i + 1];
    const start = h.globalOffset;
    const end = next ? next.globalOffset : fullText.length;
    let body = fullText.slice(start, end).trim();
    // Drop the heading line itself from bodyText (keep following prose).
    const firstNl = body.indexOf("\n");
    if (firstNl >= 0) body = body.slice(firstNl + 1).trim();
    sections.push({
      sectionNumber: h.sectionNumber,
      title: h.title,
      bodyText: body,
      pageStart: h.pageStart,
    });
  }
  return sections;
}

export function buildBdcSectionAtoms(
  parsed: ReadonlyArray<ParsedBdcSection>,
  opts: { fetchedAt: string; sourceUrl: string },
): CodeSectionAtomInstance[] {
  return parsed.map((s) => {
    const entityId = `${BDC_EDITION_ENTITY_ID}/${slugSectionNumber(s.sectionNumber)}`;
    return {
      entityType: "code-section",
      entityId,
      jurisdictionTenant: BASTROP_TENANT,
      codeEditionId: BDC_EDITION_ENTITY_ID,
      sectionNumber: s.sectionNumber,
      title: s.title,
      subsectionPath: null,
      bodyText: s.bodyText,
      fetchedAt: opts.fetchedAt,
      sourceAdapter: "bastrop-bdc-pdf",
      sourceUrl: opts.sourceUrl,
      contentHash: hashContent(
        "code-section",
        entityId,
        s.sectionNumber,
        s.title,
        s.bodyText,
      ),
    };
  });
}

export interface BastropBdcIngestReport {
  sectionsIngested: number;
  bdcEditionEntityId: string;
  currentEditionId: string | null;
  b3EffectiveTo: string | null;
  ibcUndisturbed: {
    entityId: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    stillAdopted: boolean;
  };
  sectionSample: ReadonlyArray<{
    entityId: string;
    sectionNumber: string;
    title: string;
    bodyLen: number;
  }>;
  hasDimensionalStandards: boolean;
}

/**
 * Load committed snapshot, fill BDC stub with Chapter 14 sections, close
 * B3, advance currentEditionId, leave IBC untouched, rewrite snapshot.
 */
export async function ingestBastropBdcIntoSnapshot(args: {
  snapshotPath: string;
  localPdfPath: string;
  sourceUrl?: string;
  outPath?: string;
}): Promise<{ report: BastropBdcIngestReport; snapshot: CorpusSnapshot }> {
  const sourceUrl = args.sourceUrl ?? BDC_ORDINANCE_PDF_URL;
  const outPath = args.outPath ?? args.snapshotPath;
  const fetchedAt = new Date().toISOString();

  const wire = JSON.parse(readFileSync(args.snapshotPath, "utf8")) as unknown;
  if (!isCorpusSnapshot(wire)) {
    throw new Error(`not a corpus snapshot: ${args.snapshotPath}`);
  }

  const pdfBody = readFileSync(args.localPdfPath).toString("base64");
  const pages = await pdfjsTextExtractor(pdfBody);
  const parsed = parseChapter14Sections(pages);
  if (parsed.length === 0) {
    throw new Error("Chapter 14 parse produced zero sections");
  }
  const sections = buildBdcSectionAtoms(parsed, { fetchedAt, sourceUrl });
  const hasDimensional = sections.some((s) => s.sectionNumber === "14.02.003");
  if (!hasDimensional) {
    throw new Error("missing Sec. 14.02.003 dimensional standards section");
  }

  const storage = await InMemoryStorage.fromSnapshot(wire);

  // Capture IBC before mutation for undisturbed assert.
  const ibcBefore = await storage.getAtom("code-edition", IBC_EDITION_ENTITY_ID);
  if (!ibcBefore || ibcBefore.entityType !== "code-edition") {
    throw new Error(`IBC edition missing from snapshot: ${IBC_EDITION_ENTITY_ID}`);
  }
  const ibcBeforeJson = JSON.stringify(ibcBefore);

  const b3Before = await storage.getAtom("code-edition", B3_EDITION_ENTITY_ID);
  if (!b3Before || b3Before.entityType !== "code-edition") {
    throw new Error(`B3 edition missing: ${B3_EDITION_ENTITY_ID}`);
  }

  const bdcBefore = await storage.getAtom("code-edition", BDC_EDITION_ENTITY_ID);
  if (!bdcBefore || bdcBefore.entityType !== "code-edition") {
    throw new Error(`BDC stub missing: ${BDC_EDITION_ENTITY_ID}`);
  }

  const bundle = parseEditionBundle({
    format: "hauska-edition-bundle/1",
    generatedAt: fetchedAt,
    jurisdictionTenant: BASTROP_TENANT,
    jurisdictionName: "Bastrop, TX",
    provenance:
      "WDLL 2026-07-29 BDC STEP1: fill bastrop_tx-bdc-2026-adopted + supersede B3",
    entries: [
      {
        edition: {
          entityId: B3_EDITION_ENTITY_ID,
          editionLabel: b3Before.editionLabel,
          effectiveFrom: b3Before.effectiveFrom,
          effectiveTo: B3_EFFECTIVE_TO,
          sourceAdapter: b3Before.sourceAdapter,
          sourceUrl: b3Before.sourceUrl,
        },
      },
      {
        edition: {
          entityId: BDC_EDITION_ENTITY_ID,
          editionLabel: bdcBefore.editionLabel,
          effectiveFrom: BDC_EFFECTIVE_FROM,
          effectiveTo: null,
          sourceAdapter: "bastrop-bdc-pdf",
          sourceUrl,
        },
        adoptionOrdinance: {
          ordinanceId: "2026-06",
          effectiveDate: BDC_EFFECTIVE_FROM,
          authority: "City of Bastrop",
          title: "Ordinance No. 2026-06 — B3 Code Repeal and Bastrop Development Code Adoption",
          sourceUrl,
        },
      },
    ],
  });

  const ingestResult = await ingestEditionBundle(storage, bundle, { sections });

  // Preserve B3 sectionIds (ingest rewrite must not wipe them).
  const b3AfterWrite = await storage.getAtom("code-edition", B3_EDITION_ENTITY_ID);
  if (b3AfterWrite?.entityType === "code-edition") {
    const restored: CodeEditionAtomInstance = {
      ...b3AfterWrite,
      sectionIds: b3Before.sectionIds,
      amendmentIds: b3Before.amendmentIds,
      effectiveTo: B3_EFFECTIVE_TO,
      contentHash: hashContent(
        "code-edition",
        B3_EDITION_ENTITY_ID,
        b3Before.editionLabel,
        b3Before.effectiveFrom,
        B3_EFFECTIVE_TO,
        ...b3Before.sectionIds,
      ),
    };
    await storage.writeAtom(restored);
  }

  // Preserve BDC amendment link to Ord. 2026-06 if ingest rebuilt it.
  const bdcAfter = await storage.getAtom("code-edition", BDC_EDITION_ENTITY_ID);
  if (bdcAfter?.entityType === "code-edition") {
    const amendmentIds = [
      ...new Set([...bdcBefore.amendmentIds, ...bdcAfter.amendmentIds]),
    ];
    await storage.writeAtom({
      ...bdcAfter,
      amendmentIds,
      effectiveFrom: BDC_EFFECTIVE_FROM,
      sourceAdapter: "bastrop-bdc-pdf",
      sourceUrl,
    });
  }

  // Reaffirm currentEditionId after B3 sectionIds restore (still open? no — closed).
  const corpus = await storage.getAtom("jurisdiction-corpus", BASTROP_TENANT);
  if (!corpus || corpus.entityType !== "jurisdiction-corpus") {
    throw new Error("bastrop_tx jurisdiction-corpus missing after ingest");
  }
  const corpusUpdated: JurisdictionCorpusAtomInstance = {
    ...corpus,
    currentEditionId: BDC_EDITION_ENTITY_ID,
    lastRefreshedAt: fetchedAt,
    fetchedAt,
    sourceAdapter: "bastrop-bdc-pdf",
    sourceUrl,
  };
  await storage.writeAtom(corpusUpdated);

  // Ensure contains links for new sections exist (ingest already wrote them;
  // dedupe on export is fine).
  const extraLinks: AtomLink[] = sections.map((s) => ({
    fromEntityType: "code-edition",
    fromEntityId: BDC_EDITION_ENTITY_ID,
    toEntityType: "code-section",
    toEntityId: s.entityId,
    linkType: "contains",
  }));
  await storage.writeAtomLinks(extraLinks);

  const ibcAfter = await storage.getAtom("code-edition", IBC_EDITION_ENTITY_ID);
  if (!ibcAfter || ibcAfter.entityType !== "code-edition") {
    throw new Error("IBC edition disappeared during BDC ingest");
  }
  if (JSON.stringify(ibcAfter) !== ibcBeforeJson) {
    throw new Error("IBC edition was mutated during BDC ingest — aborting");
  }

  const snapshot = storage.exportSnapshot([
    ...(wire.provenance ?? []),
    "bastrop-bdc-chapter14-ingest:WDLL-4-5 fill stub + currentEditionId→BDC",
  ]);

  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const finalCorpus = await storage.getAtom(
    "jurisdiction-corpus",
    BASTROP_TENANT,
  );
  const finalB3 = await storage.getAtom("code-edition", B3_EDITION_ENTITY_ID);
  const finalBdc = await storage.getAtom("code-edition", BDC_EDITION_ENTITY_ID);

  const report: BastropBdcIngestReport = {
    sectionsIngested: sections.length,
    bdcEditionEntityId: BDC_EDITION_ENTITY_ID,
    currentEditionId:
      finalCorpus?.entityType === "jurisdiction-corpus"
        ? finalCorpus.currentEditionId
        : ingestResult.currentEditionId,
    b3EffectiveTo:
      finalB3?.entityType === "code-edition" ? finalB3.effectiveTo : null,
    ibcUndisturbed: {
      entityId: IBC_EDITION_ENTITY_ID,
      effectiveFrom: ibcAfter.effectiveFrom,
      effectiveTo: ibcAfter.effectiveTo,
      stillAdopted:
        finalCorpus?.entityType === "jurisdiction-corpus" &&
        finalCorpus.adoptedEditionIds.includes(IBC_EDITION_ENTITY_ID),
    },
    sectionSample: sections.slice(0, 15).map((s) => ({
      entityId: s.entityId,
      sectionNumber: s.sectionNumber,
      title: s.title,
      bodyLen: s.bodyText.length,
    })),
    hasDimensionalStandards:
      finalBdc?.entityType === "code-edition" &&
      finalBdc.sectionIds.some((id) => id.endsWith("/14-02-003")),
  };

  if (report.currentEditionId !== BDC_EDITION_ENTITY_ID) {
    throw new Error(
      `currentEditionId not flipped to BDC (got ${report.currentEditionId})`,
    );
  }
  if (!report.hasDimensionalStandards) {
    throw new Error("BDC edition missing 14.02.003 in sectionIds");
  }
  if (!report.ibcUndisturbed.stillAdopted) {
    throw new Error("IBC dropped from adoptedEditionIds");
  }

  return { report, snapshot };
}

function resolveRepoPath(p: string): string {
  if (p.includes(":") || p.startsWith("/") || p.startsWith("\\\\")) return p;
  // migrate-legacy-codes cwd is tools/migrate-legacy-codes when run via pnpm --filter.
  const repoRoot = resolve(process.cwd(), "../..");
  return resolve(repoRoot, p);
}

/** CLI entry used by migrate-legacy-codes. */
export async function runBastropBdcCli(opts: {
  snapshot: string;
  pdf: string;
  out?: string;
}): Promise<void> {
  const snap = resolveRepoPath(opts.snapshot);
  const pdf = resolveRepoPath(opts.pdf);
  const out = opts.out ? resolveRepoPath(opts.out) : snap;
  const { report } = await ingestBastropBdcIntoSnapshot({
    snapshotPath: snap,
    localPdfPath: pdf,
    outPath: out,
  });
  console.log(JSON.stringify({ bastropBdcIngest: report }, null, 2));
}
