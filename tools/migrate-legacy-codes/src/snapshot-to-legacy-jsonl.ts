import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CodeEditionAtomInstance, CodeSectionAtomInstance } from "@hauska-engine/atoms";
import { isCorpusSnapshot, type CorpusSnapshot } from "@hauska-engine/storage";

import {
  ldtContentHash,
  SUBSTRATE_CODE_BOOK,
  type NeonWarmupJsonlRow,
} from "./neon-warmup-types.js";

export interface ExportSnapshotJurisdictionResult {
  jurisdictionKey: string;
  outPath: string;
  sectionsTotal: number;
  rowsExported: number;
  rowsSkippedEmptyBody: number;
  editionLabel: string;
}

function editionLabelById(
  atoms: ReadonlyArray<CodeEditionAtomInstance>,
  jurisdictionKey: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const ed of atoms) {
    if (ed.jurisdictionTenant !== jurisdictionKey) continue;
    map.set(ed.entityId, ed.editionLabel);
  }
  return map;
}

export function sectionToJsonlRow(
  section: CodeSectionAtomInstance,
  editionLabel: string,
): NeonWarmupJsonlRow | null {
  const body = section.bodyText?.trim() ?? "";
  if (!body) return null;
  const sectionNumber = section.sectionNumber?.trim() ?? "";
  if (!sectionNumber) return null;

  const edition = editionLabel;
  const content_hash = ldtContentHash([
    section.jurisdictionTenant,
    SUBSTRATE_CODE_BOOK,
    edition,
    sectionNumber,
    body,
  ]);

  return {
    jurisdiction_key: section.jurisdictionTenant,
    code_book: SUBSTRATE_CODE_BOOK,
    edition,
    section_number: sectionNumber,
    section_title: section.title?.trim() ? section.title : null,
    parent_section: section.subsectionPath,
    body,
    body_html: null,
    source_url: section.sourceUrl,
    content_hash,
    fetched_at: section.fetchedAt,
    metadata: {
      substrateEntityId: section.entityId,
      substrateContentHash: section.contentHash,
      sourceAdapter: section.sourceAdapter,
    },
  };
}

export function exportJurisdictionFromSnapshot(
  snapshot: CorpusSnapshot,
  jurisdictionKey: string,
): { rows: NeonWarmupJsonlRow[]; stats: Omit<ExportSnapshotJurisdictionResult, "outPath" | "jurisdictionKey"> } {
  const editions = editionLabelById(
    snapshot.atoms.filter((a): a is CodeEditionAtomInstance => a.entityType === "code-edition"),
    jurisdictionKey,
  );
  const sections = snapshot.atoms.filter(
    (a): a is CodeSectionAtomInstance =>
      a.entityType === "code-section" && a.jurisdictionTenant === jurisdictionKey,
  );
  const editionLabel =
    [...editions.values()][0] ??
    `${jurisdictionKey.replace(/_/g, " ")} substrate corpus`;

  const rows: NeonWarmupJsonlRow[] = [];
  let rowsSkippedEmptyBody = 0;
  for (const section of sections) {
    const row = sectionToJsonlRow(section, editionLabel);
    if (!row) {
      rowsSkippedEmptyBody++;
      continue;
    }
    rows.push(row);
  }
  return {
    rows,
    stats: {
      sectionsTotal: sections.length,
      rowsExported: rows.length,
      rowsSkippedEmptyBody,
      editionLabel,
    },
  };
}

export async function readCorpusSnapshot(path: string): Promise<CorpusSnapshot> {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isCorpusSnapshot(raw)) {
    throw new Error(`not a corpus snapshot: ${path}`);
  }
  return raw;
}

export async function writeJsonl(
  outPath: string,
  rows: ReadonlyArray<NeonWarmupJsonlRow>,
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(outPath, body, "utf8");
}

export async function exportSnapshotJurisdictionToFile(options: {
  snapshotPath: string;
  jurisdictionKey: string;
  outPath: string;
}): Promise<ExportSnapshotJurisdictionResult> {
  const snapshot = await readCorpusSnapshot(options.snapshotPath);
  const { rows, stats } = exportJurisdictionFromSnapshot(snapshot, options.jurisdictionKey);
  await writeJsonl(options.outPath, rows);
  return {
    jurisdictionKey: options.jurisdictionKey,
    outPath: options.outPath,
    ...stats,
  };
}

/** Count non-empty lines in a JSONL file (for operator verification). */
export async function countJsonlRows(path: string): Promise<number> {
  let n = 0;
  const rl = createInterface({
    input: createReadStream(path, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) n++;
  }
  return n;
}

export function defaultPilotJsonlPath(repoRoot: string, jurisdictionKey: string): string {
  return join(
    repoRoot,
    "tools/migrate-legacy-codes/tmp/neon-warmup-pilot",
    `${jurisdictionKey}.jsonl`,
  );
}
