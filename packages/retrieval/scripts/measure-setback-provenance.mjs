#!/usr/bin/env node
/**
 * F-11 measure - setback-rule counts per FIPS split by provenance.
 * Indexed (entity_type, entity_id) prefix ranges AND atom_did PK prefix.
 * Named statement_timeout. Timeout is unmeasured, never 0. Does not write.
 *
 * Reads fieldProvenance front AND side AND rear. A FIPS entity_id range is
 * not "McLennan has N rules"; F4 (envelope DID resolve by atom_did PK) is
 * the independent discriminator and is held until the planner authorizes.
 *
 *   DATABASE_URL=... node packages/retrieval/scripts/measure-setback-provenance.mjs
 *   node packages/retrieval/scripts/measure-setback-provenance.mjs --self-test
 */
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_MARKER = "storage-port-proof/phase-1a";
export const FIPS = ["48021", "48055", "48209", "48309", "48453", "48491"];
export const TIMEOUT = "15s";
export const RECONCILE = {
  48021: { label: "Bastrop", valueTarget: 7534, layer23Target: 2315 },
  48055: { label: "Caldwell/Lockhart", valueTarget: 337 },
  48209: { label: "Hays", placeholderTarget: 34454 },
  48309: { label: "McLennan", valueTarget: 0, envelopeTarget: 65814 },
  48453: { label: "Travis/Austin", valueTarget: 150702 },
  48491: { label: "Williamson", placeholderTarget: 124499 },
};

export const PRE_REGISTERED_SPLIT = {
  placeholder: 188103,
  nonPlaceholder: 158573,
  bastropNonPlaceholder: 7534,
  note: "Adding side and rear must not move 188103 / 158573. A miss means the published figures were wrong, not that the corpus moved.",
};

export function nextEntityIdBound(fips) {
  const n = Number(fips);
  if (!Number.isInteger(n)) throw new Error(`bad fips ${fips}`);
  return `${String(n + 1).padStart(5, "0")}:`;
}

export function entityIdInFipsRange(entityId, fips) {
  if (typeof entityId !== "string") return false;
  const start = `${fips}:`;
  const end = nextEntityIdBound(fips);
  return entityId >= start && entityId < end;
}

export function atomDidInFipsPrefix(atomDid, entityType, fips) {
  if (typeof atomDid !== "string" || typeof entityType !== "string") return false;
  const start = `did:hauska:${entityType}:${fips}:`;
  const end = `did:hauska:${entityType}:${nextEntityIdBound(fips)}`;
  return atomDid >= start && atomDid < end;
}

export function placeholderAxesFromBody(body) {
  if (!body || typeof body !== "object") return [];
  return [
    body.sourceCodeAtomRef?.atomDid,
    body.fieldProvenance?.front?.atomDid,
    body.fieldProvenance?.side?.atomDid,
    body.fieldProvenance?.rear?.atomDid,
  ];
}

export function citesPlaceholderDid(raw) {
  return typeof raw === "string" && raw.includes(PLACEHOLDER_MARKER);
}

/**
 * Mirrors the SQL CASE. Front-only was the published defect: a side- or
 * rear-only placeholder scored other-dimensional (real).
 */
export function classifySetbackProvenanceFromBody(body) {
  if (placeholderAxesFromBody(body).some(citesPlaceholderDid)) {
    return "placeholder";
  }
  const adapter =
    typeof body?.sourceAdapter === "string" ? body.sourceAdapter : "";
  if (adapter === "bastrop-per-parcel-record-layer-23") return "layer-23";
  if (adapter === "road-class-setback-table") return "road-class-setback-table";
  return "other-dimensional";
}

function countsFromRows(rows) {
  return Object.fromEntries(rows.map((r) => [r.provenance, Number(r.n)]));
}

export function selfTestMeasureClassifier() {
  const sideOnly = {
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    fieldProvenance: {
      side: { atomDid: `did:hauska:code-section:${PLACEHOLDER_MARKER}` },
    },
  };
  const rearOnly = {
    sourceAdapter: "cortex-tier1-snapshot-breadth-bake",
    fieldProvenance: {
      rear: { atomDid: `did:hauska:code-section:${PLACEHOLDER_MARKER}` },
    },
  };
  const frontOnly = {
    sourceCodeAtomRef: {
      atomDid: `did:hauska:code-section:${PLACEHOLDER_MARKER}`,
    },
    fieldProvenance: {
      front: { atomDid: `did:hauska:code-section:${PLACEHOLDER_MARKER}` },
    },
  };
  const layer23 = {
    sourceAdapter: "bastrop-per-parcel-record-layer-23",
    sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
    fieldProvenance: {
      front: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
      side: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
      rear: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
    },
  };
  if (classifySetbackProvenanceFromBody(sideOnly) !== "placeholder") {
    throw new Error("self-test FAIL: side-only placeholder scored as real");
  }
  if (classifySetbackProvenanceFromBody(rearOnly) !== "placeholder") {
    throw new Error("self-test FAIL: rear-only placeholder scored as real");
  }
  if (classifySetbackProvenanceFromBody(frontOnly) !== "placeholder") {
    throw new Error("self-test FAIL: front placeholder missed");
  }
  if (classifySetbackProvenanceFromBody(layer23) !== "layer-23") {
    throw new Error("self-test FAIL: layer-23 Bastrop fixture classed as placeholder");
  }
  if (entityIdInFipsRange("R123456", "48309")) {
    throw new Error("self-test FAIL: non-FIPS entity_id matched the McLennan range");
  }
  if (entityIdInFipsRange("48309:1", "48309") !== true) {
    throw new Error("self-test FAIL: FIPS-prefixed McLennan entity_id missed the range");
  }
  if (atomDidInFipsPrefix("did:hauska:setback-rule:R123456", "setback-rule", "48309")) {
    throw new Error("self-test FAIL: non-FIPS atom_did matched the McLennan DID prefix");
  }
  if (
    atomDidInFipsPrefix(
      "did:hauska:setback-rule:48309:1",
      "setback-rule",
      "48309",
    ) !== true
  ) {
    throw new Error("self-test FAIL: FIPS-prefixed McLennan DID missed the prefix");
  }
}

function sumProvenance(map) {
  return Object.values(map).reduce((a, n) => a + n, 0);
}

function likePlaceholder() {
  return `%${PLACEHOLDER_MARKER}%`;
}

async function measureSetbacksByBound(sql, startCol, start, end) {
  const needle = likePlaceholder();
  if (startCol === "entity_id") {
    return sql`
      SELECT
        CASE
          WHEN body->'sourceCodeAtomRef'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'front'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'side'->>'atomDid' LIKE ${needle}
            OR body->'fieldProvenance'->'rear'->>'atomDid' LIKE ${needle}
            THEN 'placeholder'
          WHEN body->>'sourceAdapter' = 'bastrop-per-parcel-record-layer-23'
            THEN 'layer-23'
          WHEN body->>'sourceAdapter' = 'road-class-setback-table'
            THEN 'road-class-setback-table'
          ELSE 'other-dimensional'
        END AS provenance,
        count(*)::bigint AS n
      FROM atoms
      WHERE entity_type = 'setback-rule'
        AND entity_id >= ${start}
        AND entity_id < ${end}
      GROUP BY 1
    `;
  }
  return sql`
    SELECT
      CASE
        WHEN body->'sourceCodeAtomRef'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'front'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'side'->>'atomDid' LIKE ${needle}
          OR body->'fieldProvenance'->'rear'->>'atomDid' LIKE ${needle}
          THEN 'placeholder'
        WHEN body->>'sourceAdapter' = 'bastrop-per-parcel-record-layer-23'
          THEN 'layer-23'
        WHEN body->>'sourceAdapter' = 'road-class-setback-table'
          THEN 'road-class-setback-table'
        ELSE 'other-dimensional'
      END AS provenance,
      count(*)::bigint AS n
    FROM atoms
    WHERE entity_type = 'setback-rule'
      AND atom_did >= ${start}
      AND atom_did < ${end}
    GROUP BY 1
  `;
}

async function measureFips(sql, fips) {
  const start = `${fips}:`;
  const end = nextEntityIdBound(fips);
  const didStart = `did:hauska:setback-rule:${start}`;
  const didEnd = `did:hauska:setback-rule:${end}`;
  const setbacksByEntityId = await measureSetbacksByBound(
    sql,
    "entity_id",
    start,
    end,
  );
  const setbacksByAtomDid = await measureSetbacksByBound(
    sql,
    "atom_did",
    didStart,
    didEnd,
  );
  const envelopes = await sql`
    SELECT count(*)::bigint AS n
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND entity_id >= ${start}
      AND entity_id < ${end}
  `;
  const byEntityId = countsFromRows(setbacksByEntityId);
  const byAtomDid = countsFromRows(setbacksByAtomDid);
  return {
    fips,
    label: RECONCILE[fips].label,
    setbackRule: byEntityId,
    setbackRuleByAtomDidPrefix: byAtomDid,
    predicateDivergence:
      JSON.stringify(byEntityId) !== JSON.stringify(byAtomDid) ||
      sumProvenance(byEntityId) !== sumProvenance(byAtomDid),
    buildableEnvelope: Number(envelopes[0]?.n ?? 0),
    reconcile: RECONCILE[fips],
    predicates: {
      entityIdRange: `entity_type = setback-rule AND entity_id >= ${start} AND entity_id < ${end}`,
      atomDidPrefix: `entity_type = setback-rule AND atom_did >= ${didStart} AND atom_did < ${didEnd}`,
      f4EnvelopeDidResolve: fips === "48309" ? "held" : "not-applicable",
    },
  };
}

/**
 * F4: McLennan envelopes (published 65814 cohort) name setback-rule DIDs.
 * Resolve those DIDs by atom_did PK with no range predicate.
 * Falsified if any resolve.
 */
async function measureF4(sql) {
  const start = "48309:";
  const end = nextEntityIdBound("48309");
  const didStart = `did:hauska:buildable-envelope:${start}`;
  const didEnd = `did:hauska:buildable-envelope:${end}`;
  const rows = await sql`
    WITH env AS (
      SELECT body
      FROM atoms
      WHERE entity_type = 'buildable-envelope'
        AND (
          (entity_id >= ${start} AND entity_id < ${end})
          OR (atom_did >= ${didStart} AND atom_did < ${didEnd})
        )
    ),
    refs AS (
      SELECT DISTINCT jsonb_array_elements(
        COALESCE(
          body->'reasoningChain'->'inputAtomRefs',
          body->'inputAtomRefs',
          '[]'::jsonb
        )
      )->>'atomDid' AS did
      FROM env
    ),
    cited AS (
      SELECT did FROM refs
      WHERE did LIKE 'did:hauska:setback-rule:%'
    )
    SELECT
      (SELECT count(*)::bigint FROM env) AS envelope_rows,
      (SELECT count(*)::bigint FROM cited) AS cited_setback_dids,
      (SELECT count(*)::bigint FROM cited c
        INNER JOIN atoms a ON a.atom_did = c.did
        WHERE a.entity_type = 'setback-rule') AS resolved_by_pk
  `;
  const row = rows[0] ?? {};
  const envelopeRows = Number(row.envelope_rows ?? 0);
  const cited = Number(row.cited_setback_dids ?? 0);
  const resolved = Number(row.resolved_by_pk ?? 0);
  return {
    check: "F4",
    fips: "48309",
    predicate:
      "McLennan envelopes by entity_id range OR atom_did prefix; cited setback-rule DIDs resolved by atom_did PK with no range",
    envelopeRows,
    citedSetbackDids: cited,
    resolvedByPk: resolved,
    falsifier: "any resolve. One resolving DID voids the McLennan-zero quarantine.",
    verdict: resolved > 0 ? "FALSIFIED" : "no-resolve",
  };
}

async function main() {
  selfTestMeasureClassifier();
  const selfTestOnly = process.argv.includes("--self-test");
  const f4Only = process.argv.includes("--f4");
  if (selfTestOnly) {
    console.log(
      JSON.stringify({
        snapshot: "self-test",
        selfTest: "pass",
        axes: ["sourceCodeAtomRef", "fieldProvenance.front", "fieldProvenance.side", "fieldProvenance.rear"],
        preRegisteredSplit: PRE_REGISTERED_SPLIT,
        f4: "held",
      }),
    );
    return;
  }

  const url = process.env.DATABASE_URL ?? process.env.ATOMS_DATABASE_URL;
  if (!url) {
    console.error(
      JSON.stringify({
        snapshot: "unmeasured",
        reason: "DATABASE_URL / ATOMS_DATABASE_URL unset",
        selfTest: "pass",
      }),
    );
    process.exit(2);
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  if (f4Only) {
    try {
      await sql.unsafe(`SET statement_timeout = '${TIMEOUT}'`);
      const f4 = await measureF4(sql);
      console.log(JSON.stringify({ snapshot: new Date().toISOString(), timeout: TIMEOUT, f4 }, null, 2));
    } finally {
      await sql.end({ timeout: 2 });
    }
    return;
  }
  const rows = [];
  try {
    await sql.unsafe(`SET statement_timeout = '${TIMEOUT}'`);
    for (const fips of FIPS) {
      try {
        rows.push(await measureFips(sql, fips));
      } catch (err) {
        const timedOut =
          err &&
          typeof err === "object" &&
          (String(err.message ?? "").includes("statement timeout") ||
            err.code === "57014");
        rows.push({
          fips,
          label: RECONCILE[fips].label,
          snapshot: timedOut ? "unmeasured" : "error",
          reason: timedOut
            ? `statement_timeout ${TIMEOUT}`
            : String(err?.message ?? err),
        });
      }
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
  console.log(
    JSON.stringify(
      {
        snapshot: new Date().toISOString(),
        timeout: TIMEOUT,
        axes: ["sourceCodeAtomRef", "fieldProvenance.front", "fieldProvenance.side", "fieldProvenance.rear"],
        preRegisteredSplit: PRE_REGISTERED_SPLIT,
        f4: "held",
        predicate:
          "entity_type = setback-rule AND (entity_id FIPS range OR atom_did FIPS prefix); neither is McLennan-zero",
        rows,
      },
      null,
      2,
    ),
  );
}

const invoked =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().catch((err) => {
    console.error(JSON.stringify({ snapshot: "unmeasured", reason: String(err) }));
    process.exit(2);
  });
}
