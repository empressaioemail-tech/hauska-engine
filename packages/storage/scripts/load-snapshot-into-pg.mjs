/**
 * One-time / offline loader: commit the code-corpus snapshot into Postgres
 * so retrieval-api can serve Postgres-only (G2) without losing Codex atoms.
 *
 * NEVER run this inside the Cloud Run boot path — it JSON.parses the
 * snapshot with an elevated heap. Operator/planner runs it once against
 * substrate Neon, then deploys postgres-serve retrieval.
 *
 * Usage:
 *   DATABASE_URL='postgres://.../hauska_mcp?sslmode=require' \
 *     NODE_OPTIONS=--max-old-space-size=4096 \
 *     node packages/storage/scripts/load-snapshot-into-pg.mjs \
 *       [--snapshot path] [--batch 200] [--dry-run]
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function parseArgs(argv) {
  const out = {
    snapshot: resolve(
      repoRoot,
      "services/retrieval-api/corpus/snapshot.json",
    ),
    batch: 200,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--snapshot") out.snapshot = resolve(argv[++i]);
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

function buildAtomDid(entityType, entityId) {
  return `did:hauska:${entityType}:${entityId}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUBSTRATE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL (or SUBSTRATE_DATABASE_URL) required");
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      event: "load-snapshot.start",
      snapshot: args.snapshot,
      batch: args.batch,
      dryRun: args.dryRun,
      heapMib: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }),
  );

  const raw = await readFile(args.snapshot, "utf8");
  const snap = JSON.parse(raw);
  if (snap.format !== "hauska-corpus-snapshot/1") {
    throw new Error(`unexpected snapshot format: ${snap.format}`);
  }

  const atoms = snap.atoms ?? [];
  const links = snap.links ?? [];
  const jurisdictions = snap.jurisdictionStatus ?? [];

  console.log(
    JSON.stringify({
      event: "load-snapshot.parsed",
      atoms: atoms.length,
      links: links.length,
      jurisdictions: jurisdictions.length,
      generatedAt: snap.generatedAt,
      heapMib: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }),
  );

  if (args.dryRun) {
    console.log(JSON.stringify({ event: "load-snapshot.dry-run-ok" }));
    return;
  }

  const sql = postgres(databaseUrl, {
    ssl: "require",
    max: 4,
    connect_timeout: 30,
  });

  let written = 0;
  for (let i = 0; i < atoms.length; i += args.batch) {
    const chunk = atoms.slice(i, i + args.batch);
    await sql.begin(async (tx) => {
      for (const inst of chunk) {
        const atomDid = buildAtomDid(inst.entityType, inst.entityId);
        const sectionNumber =
          inst.entityType === "code-section" ? inst.sectionNumber ?? null : null;
        const subsectionPath =
          inst.entityType === "code-section" ? inst.subsectionPath ?? null : null;
        const accessPolicy = inst.accessPolicy ?? "public-free";
        await tx`
          INSERT INTO atoms (
            atom_did, cid, content_hash, entity_type, entity_id,
            jurisdiction_tenant, section_number, subsection_path,
            source_adapter, source_url, fetched_at, body, access_policy
          ) VALUES (
            ${atomDid},
            ${"snapshot-load:" + inst.contentHash},
            ${inst.contentHash},
            ${inst.entityType},
            ${inst.entityId},
            ${inst.jurisdictionTenant},
            ${sectionNumber},
            ${subsectionPath},
            ${inst.sourceAdapter},
            ${inst.sourceUrl},
            ${inst.fetchedAt},
            ${tx.json(inst)},
            ${accessPolicy}
          )
          ON CONFLICT (atom_did) DO UPDATE SET
            cid = EXCLUDED.cid,
            content_hash = EXCLUDED.content_hash,
            entity_type = EXCLUDED.entity_type,
            entity_id = EXCLUDED.entity_id,
            jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
            section_number = EXCLUDED.section_number,
            subsection_path = EXCLUDED.subsection_path,
            source_adapter = EXCLUDED.source_adapter,
            source_url = EXCLUDED.source_url,
            fetched_at = EXCLUDED.fetched_at,
            body = EXCLUDED.body,
            access_policy = EXCLUDED.access_policy,
            updated_at = now()
        `;
        written++;
      }
    });
    if (written % 1000 === 0 || i + args.batch >= atoms.length) {
      console.log(
        JSON.stringify({
          event: "load-snapshot.progress",
          written,
          of: atoms.length,
          heapMib: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        }),
      );
    }
  }

  let linksWritten = 0;
  for (let i = 0; i < links.length; i += args.batch) {
    const chunk = links.slice(i, i + args.batch);
    await sql.begin(async (tx) => {
      for (const link of chunk) {
        const fromAtomDid = buildAtomDid(link.fromEntityType, link.fromEntityId);
        const toAtomDid = buildAtomDid(link.toEntityType, link.toEntityId);
        await tx`
          INSERT INTO atom_links (from_atom_did, to_atom_did, link_type, context)
          VALUES (
            ${fromAtomDid},
            ${toAtomDid},
            ${link.linkType},
            ${link.context ?? null}
          )
          ON CONFLICT (from_atom_did, to_atom_did, link_type) DO NOTHING
        `;
        linksWritten++;
      }
    });
  }

  for (const status of jurisdictions) {
    await sql`
      INSERT INTO jurisdiction_status (
        jurisdiction_tenant, jurisdiction_name, current_edition_did,
        quality_bar, top3_score, section_num_score, cross_ref_score,
        atom_count, last_refreshed_at, drift_status, access_policy
      ) VALUES (
        ${status.jurisdictionTenant},
        ${status.jurisdictionName},
        ${status.currentEditionDid ?? null},
        ${status.qualityBar},
        ${status.top3Score ?? null},
        ${status.sectionNumScore ?? null},
        ${status.crossRefScore ?? null},
        ${status.atomCount},
        ${status.lastRefreshedAt ?? null},
        ${status.driftStatus},
        ${status.accessPolicy ?? "public-free"}
      )
      ON CONFLICT (jurisdiction_tenant) DO UPDATE SET
        jurisdiction_name = EXCLUDED.jurisdiction_name,
        current_edition_did = EXCLUDED.current_edition_did,
        quality_bar = EXCLUDED.quality_bar,
        top3_score = EXCLUDED.top3_score,
        section_num_score = EXCLUDED.section_num_score,
        cross_ref_score = EXCLUDED.cross_ref_score,
        atom_count = EXCLUDED.atom_count,
        last_refreshed_at = EXCLUDED.last_refreshed_at,
        drift_status = EXCLUDED.drift_status,
        access_policy = EXCLUDED.access_policy
    `;
  }

  const [{ count }] = await sql`SELECT count(*)::int AS count FROM atoms`;
  const [{ codeCount }] = await sql`
    SELECT count(*)::int AS "codeCount"
    FROM atoms
    WHERE entity_type NOT IN (
      'zoning-fact', 'setback-rule', 'buildable-envelope', 'zoning-absence'
    )
  `;
  const [{ jurisdictionsNow }] = await sql`
    SELECT count(*)::int AS "jurisdictionsNow" FROM jurisdiction_status
  `;

  console.log(
    JSON.stringify({
      event: "load-snapshot.done",
      atomsWritten: written,
      linksWritten,
      jurisdictionsUpserted: jurisdictions.length,
      atomsTotal: count,
      nonPropertyAtoms: codeCount,
      jurisdictionsNow,
    }),
  );

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
