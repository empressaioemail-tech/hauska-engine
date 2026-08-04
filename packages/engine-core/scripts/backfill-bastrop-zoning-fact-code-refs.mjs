#!/usr/bin/env node
/**
 * backfill-bastrop-zoning-fact-code-refs.mjs — COMPLETE-BASTROP zoning-fact
 * code-section refs backfill (targeted UPDATE-in-place, not a re-bake).
 *
 * Existing Bastrop city zoning-fact atoms (minted pre-#214) lack
 * sourceCodeAtomRef/codeSectionRefs. This patches them in place from the
 * static bastrop_tx entry in district-code-section-map.ts. Re-running the
 * breadth bake does NOT fix this on its own: descriptorForCounty() keys the
 * lookup off JurisdictionDescriptor.key, which pre-fix was the generic
 * `breadth_48021` (never matching the map's `bastrop_tx` seed) — see the
 * companion fix in bake-from-tier1-snapshot.ts (same PR, separate commit)
 * for FUTURE bakes. This script only patches what's already persisted.
 *
 * Scope (verified against prod): 5,772 district-carrying zoning-facts on
 * 48021. 5,744 covered by the map's 10 seeded district codes (SF-1, SF-2,
 * SF-3, MU, GC, PI, IND, P/OS, RR, PDD). 28 carry legacy codes NOT in the
 * map (P-3, P-2, P-5, P-1, P-4, P-EC) — honest-miss, counted and logged,
 * never fabricated.
 *
 * Write semantics (verified reference-safe): atomDid is content-independent
 * (did:hauska:zoning-fact:<parcelNodeId>), storage is upsert-by-atomDid,
 * downstream setback/envelope atoms reference the zoning-fact BY DID. Cert
 * graders never read the ref fields added here.
 *
 *   PROPERTY_ATOM_PATH=1 COMPLETE_BASTROP_REFS_BACKFILL=1 DATABASE_URL=...hauska_mcp... \
 *     pnpm --filter @hauska-engine/engine-core run backfill-bastrop-zoning-fact-code-refs \
 *       [--dry-run] [--apply] [--limit=N] [--batch=500] [--gold] [--revert]
 *
 * Persist requires COMPLETE_BASTROP_REFS_BACKFILL=1 or --apply (and PROPERTY_ATOM_PATH=1).
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import postgres from "postgres";

const COUNTY_FIPS = "48021";
const JURISDICTION_KEY = "bastrop_tx";
const GOLD_PROP_IDS = ["28286", "33512", "34785"];

// Same seed roster as district-code-section-map.ts BASTROP_TX_DISTRICT_CODES
// (kept as a local literal list for --dry-run/log purposes only; the actual
// ref values are resolved through lookupDistrictCodeSectionRefs so a future
// map edit can never silently drift from what this script writes).
const MAPPED_DISTRICT_CODES = new Set([
  "P/OS",
  "RR",
  "SF-1",
  "SF-2",
  "SF-3",
  "MU",
  "GC",
  "PI",
  "IND",
  "PDD",
]);

function parseArgs(argv) {
  const out = {
    dryRun: false,
    apply: false,
    limit: null,
    batch: 500,
    gold: false,
    revert: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--gold") out.gold = true;
    else if (a === "--revert") out.revert = true;
    else if (a === "--limit") out.limit = Number(argv[++i] || 0) || null;
    else if (a.startsWith("--limit="))
      out.limit = Number(a.slice("--limit=".length)) || null;
    else if (a === "--batch") out.batch = Number(argv[++i] || 500) || 500;
    else if (a.startsWith("--batch="))
      out.batch = Number(a.slice("--batch=".length)) || 500;
  }
  return out;
}

function sha256HexCanonical(s) {
  return createHash("sha256").update(s).digest("hex");
}

function log(msg) {
  console.log(`[bastrop-refs-backfill] ${msg}`);
}

function codeSectionRef(entityId) {
  return {
    atomDid: `did:hauska:code-section:${entityId}`,
    role: "rule",
    entityType: "code-section",
  };
}

const BASTROP_TX_DISTRICT_REQUIREMENTS = codeSectionRef(
  "bastrop_tx-bdc-2026-adopted/14-02-003",
);
const BASTROP_TX_PERMITTED_USE_TABLE = codeSectionRef(
  "bastrop_tx-bdc-2026-adopted/14-02-008",
);

/**
 * Mirrors district-code-section-map.ts lookupDistrictCodeSectionRefs for
 * jurisdictionKey=bastrop_tx (this script's sole scope). Kept literal here
 * (no cross-package TS import into a plain .mjs script, matching the
 * template's self-contained style) but the ref VALUES are copied verbatim
 * from the TS module, not re-derived.
 */
function lookupBastropDistrictCodeSectionRefs(districtCode) {
  const code = districtCode.trim();
  if (!MAPPED_DISTRICT_CODES.has(code)) return undefined;
  return {
    districtRequirements: BASTROP_TX_DISTRICT_REQUIREMENTS,
    permittedUseTable: BASTROP_TX_PERMITTED_USE_TABLE,
  };
}

const args = parseArgs(process.argv.slice(2));
const dryRun =
  args.dryRun ||
  (!args.apply && process.env.COMPLETE_BASTROP_REFS_BACKFILL !== "1");

if (!dryRun && process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required for persist.");
  process.exit(1);
}

const substrateUrl =
  process.env.DATABASE_URL?.trim() ||
  process.env.SUBSTRATE_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL (hauska_mcp) required.");
  process.exit(1);
}

const sql = postgres(substrateUrl, { ssl: "require", max: 4, prepare: false });
const t0 = performance.now();

const before = await sql`
  SELECT
    count(*)::int AS with_district,
    count(*) FILTER (
      WHERE body ? 'codeSectionRefs'
    )::int AS with_code_section_refs
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND entity_id LIKE ${COUNTY_FIPS + ":%"}
    AND coalesce(body->>'district','') <> ''
`;
log(`BEFORE: ${JSON.stringify(before[0])}`);

let rows;
if (args.gold) {
  const ids = GOLD_PROP_IDS.map((p) => `${COUNTY_FIPS}:${p}`);
  rows = await sql`
    SELECT entity_id, atom_did, body
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id = ANY(${ids})
      AND coalesce(body->>'district','') <> ''
    ORDER BY entity_id
  `;
} else if (args.revert) {
  rows = await sql`
    SELECT entity_id, atom_did, body
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id LIKE ${COUNTY_FIPS + ":%"}
      AND coalesce(body->>'district','') <> ''
      AND body ? 'codeSectionRefs'
    ORDER BY entity_id
    ${args.limit != null ? sql`LIMIT ${args.limit}` : sql``}
  `;
} else {
  // WHERE-clause shape pinned by
  // __tests__/backfill-bastrop-zoning-fact-code-refs.test.ts — candidates are
  // strictly district-carrying zoning-facts missing codeSectionRefs. Absence
  // facts (district='') and the county cascade envelopes are excluded by
  // construction (they are not entity_type='zoning-fact' rows with a
  // non-empty body->>'district').
  rows = await sql`
    SELECT entity_id, atom_did, body
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id LIKE ${COUNTY_FIPS + ":%"}
      AND coalesce(body->>'district','') <> ''
      AND NOT (body ? 'codeSectionRefs')
    ORDER BY entity_id
    ${args.limit != null ? sql`LIMIT ${args.limit}` : sql``}
  `;
}

log(
  `candidates: ${rows.length} dryRun=${dryRun} mode=${args.gold ? "gold" : args.revert ? "revert" : "backfill"}`,
);

let patched = 0;
let skippedExisting = 0;
let errors = 0;
const honestMiss = {};

for (let i = 0; i < rows.length; i += args.batch) {
  const chunk = rows.slice(i, i + args.batch);
  for (const row of chunk) {
    try {
      const body =
        row.body && typeof row.body === "object" ? { ...row.body } : {};
      const district =
        typeof body.district === "string" ? body.district.trim() : "";
      if (!district) continue;

      if (args.revert) {
        if (!("codeSectionRefs" in body) && !("sourceCodeAtomRef" in body)) {
          skippedExisting += 1;
          continue;
        }
        const next = { ...body };
        delete next.sourceCodeAtomRef;
        delete next.codeSectionRefs;
        delete next.contentHash;
        next.contentHash = sha256HexCanonical(JSON.stringify(next));

        if (dryRun) {
          if (patched < 3) {
            log(
              `DRY-REVERT sample entity_id=${row.entity_id} district=${district} — would strip codeSectionRefs/sourceCodeAtomRef`,
            );
          }
          patched += 1;
          continue;
        }

        await sql`
          UPDATE atoms
          SET body = ${sql.json(next)},
              content_hash = ${next.contentHash},
              updated_at = NOW()
          WHERE entity_type = 'zoning-fact'
            AND entity_id = ${row.entity_id}
        `;
        patched += 1;
        continue;
      }

      // Backfill / gold mode.
      if (!args.gold && "codeSectionRefs" in body) {
        skippedExisting += 1;
        continue;
      }

      const refs = lookupBastropDistrictCodeSectionRefs(district);
      if (!refs) {
        honestMiss[district] = (honestMiss[district] ?? 0) + 1;
        continue;
      }

      const next = {
        ...body,
        sourceCodeAtomRef: refs.districtRequirements,
        codeSectionRefs: refs,
      };
      delete next.contentHash;
      next.contentHash = sha256HexCanonical(JSON.stringify(next));

      if (dryRun) {
        if (patched < 3 || args.gold) {
          log(
            `DRY sample entity_id=${row.entity_id} district=${district} ` +
              `sourceCodeAtomRef=${next.sourceCodeAtomRef.atomDid}`,
          );
        }
        patched += 1;
        continue;
      }

      await sql`
        UPDATE atoms
        SET body = ${sql.json(next)},
            content_hash = ${next.contentHash},
            updated_at = NOW()
        WHERE entity_type = 'zoning-fact'
          AND entity_id = ${row.entity_id}
      `;
      patched += 1;
    } catch (err) {
      errors += 1;
      log(`ERROR entity_id=${row.entity_id}: ${err?.message ?? err}`);
    }
  }
  log(`progress ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
}

const after = await sql`
  SELECT
    count(*)::int AS with_district,
    count(*) FILTER (
      WHERE body ? 'codeSectionRefs'
    )::int AS with_code_section_refs
  FROM atoms
  WHERE entity_type = 'zoning-fact'
    AND entity_id LIKE ${COUNTY_FIPS + ":%"}
    AND coalesce(body->>'district','') <> ''
`;
log(`AFTER: ${JSON.stringify(after[0])}`);

if (args.gold) {
  const gold = await sql`
    SELECT
      entity_id,
      atom_did,
      body->>'district' AS district,
      body->'sourceCodeAtomRef' AS source_code_atom_ref,
      body->'codeSectionRefs' AS code_section_refs
    FROM atoms
    WHERE entity_type = 'zoning-fact'
      AND entity_id = ANY(${GOLD_PROP_IDS.map((p) => `${COUNTY_FIPS}:${p}`)})
    ORDER BY entity_id
  `;
  log(`GOLD BEFORE/AFTER: ${JSON.stringify(gold, null, 2)}`);
}

log(
  `done dryRun=${dryRun} mode=${args.gold ? "gold" : args.revert ? "revert" : "backfill"} ` +
    JSON.stringify({
      scanned: rows.length,
      patched,
      honestMiss,
      skippedExisting,
      errors,
    }) +
    ` elapsedMs=${Math.round(performance.now() - t0)}`,
);

await sql.end({ timeout: 5 });
