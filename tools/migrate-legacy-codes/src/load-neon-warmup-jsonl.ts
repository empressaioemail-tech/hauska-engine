import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import postgres from "postgres";

import {
  parseJsonlLine,
  substrateSourceName,
  type NeonWarmupJsonlRow,
} from "./neon-warmup-types.js";

export interface LoadNeonWarmupResult {
  jurisdictionKey: string;
  sourceName: string;
  sourceId: string;
  linesRead: number;
  inserted: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  dryRun: boolean;
}

async function ensureSubstrateSource(
  sql: postgres.Sql,
  jurisdictionKey: string,
): Promise<string> {
  const sourceName = substrateSourceName(jurisdictionKey);
  const display = jurisdictionKey
    .replace(/_tx$/, ", TX")
    .replace(/_ut$/, ", UT")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const existing = await sql<{ id: string }[]>`
    SELECT id FROM code_atom_sources WHERE source_name = ${sourceName} LIMIT 1
  `;
  if (existing.length > 0) return existing[0].id;

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO code_atom_sources (
      source_name, label, source_type, license_type, base_url, notes
    ) VALUES (
      ${sourceName},
      ${`${display} — hauska-engine substrate warmup`},
      ${"substrate_export"},
      ${"platform-internal"},
      ${null},
      ${"PB-001 Neon warmup pilot batch; idempotent load via migrate-legacy-codes load-neon-warmup-jsonl"}
    )
    ON CONFLICT (source_name) DO UPDATE SET label = EXCLUDED.label
    RETURNING id
  `;
  return inserted[0].id;
}

async function insertRow(
  sql: postgres.Sql,
  sourceId: string,
  row: NeonWarmupJsonlRow,
): Promise<"inserted" | "duplicate"> {
  const fetchedAt = row.fetched_at ? new Date(row.fetched_at) : new Date();
  const ins = await sql<{ id: string }[]>`
    INSERT INTO code_atoms (
      source_id, jurisdiction_key, code_book, edition,
      section_number, section_title, parent_section,
      body, body_html, embedding, embedding_model, embedded_at,
      content_hash, source_url, fetched_at, metadata
    ) VALUES (
      ${sourceId},
      ${row.jurisdiction_key},
      ${row.code_book},
      ${row.edition},
      ${row.section_number},
      ${row.section_title},
      ${row.parent_section},
      ${row.body},
      ${row.body_html},
      ${null},
      ${null},
      ${null},
      ${row.content_hash},
      ${row.source_url},
      ${fetchedAt},
      ${row.metadata ? sql.json(row.metadata) : null}
    )
    ON CONFLICT (content_hash) DO NOTHING
    RETURNING id
  `;
  return ins.length > 0 ? "inserted" : "duplicate";
}

export async function loadNeonWarmupJsonlFile(options: {
  databaseUrl: string;
  jsonlPath: string;
  jurisdictionKey?: string;
  dryRun?: boolean;
}): Promise<LoadNeonWarmupResult> {
  const sql = postgres(options.databaseUrl, {
    max: 1,
    onnotice: () => {},
    ssl: options.databaseUrl.includes("sslmode=require") ? "require" : false,
  });

  let jurisdictionKey = options.jurisdictionKey ?? "";
  let sourceId = "";
  let linesRead = 0;
  let inserted = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  try {
    const rl = createInterface({
      input: createReadStream(options.jsonlPath, "utf8"),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      linesRead++;

      let row: NeonWarmupJsonlRow;
      try {
        row = parseJsonlLine(trimmed);
      } catch {
        skippedInvalid++;
        continue;
      }

      if (!jurisdictionKey) jurisdictionKey = row.jurisdiction_key;
      if (row.jurisdiction_key !== jurisdictionKey) {
        throw new Error(
          `jurisdiction mismatch on line ${linesRead}: expected ${jurisdictionKey}, got ${row.jurisdiction_key}`,
        );
      }

      if (options.dryRun) continue;

      if (!sourceId) {
        sourceId = await ensureSubstrateSource(sql, jurisdictionKey);
      }

      const outcome = await insertRow(sql, sourceId, row);
      if (outcome === "inserted") inserted++;
      else skippedDuplicate++;
    }

    if (!jurisdictionKey) {
      throw new Error(`no rows in ${options.jsonlPath}`);
    }

    if (!options.dryRun && !sourceId) {
      sourceId = await ensureSubstrateSource(sql, jurisdictionKey);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return {
    jurisdictionKey,
    sourceName: substrateSourceName(jurisdictionKey),
    sourceId: sourceId || "(dry-run)",
    linesRead,
    inserted,
    skippedDuplicate,
    skippedInvalid,
    dryRun: options.dryRun ?? false,
  };
}
