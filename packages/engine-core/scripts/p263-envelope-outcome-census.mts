#!/usr/bin/env tsx
/**
 * P-263 DRY RUN — the movement census for the mislabelled breadth-bake envelope outcomes.
 *
 * READ-ONLY INSTRUMENT. This file contains no INSERT, UPDATE, DELETE, TRUNCATE, or DDL
 * statement. It DOES run a full-table read over the six counties' envelope atoms, so the
 * SESSION running it holds a heavy-scan lease keyed on the store's HOST for the duration
 * (AGENT-CONTRACT §4; P-307 for the key rule, P-281's `heavy-scan-lease.mjs` for the API).
 * The script does not take or renew the lease itself: a lease taken by a process inside the
 * instrument dies with the process while the read may already have started, and a session
 * that leases once around the whole measurement is the shape the contract asks for.
 * It answers the operator's question before the operator is asked to authorise anything:
 *
 *   Per county, of the `no-buildable-area` buildable-envelope atoms on record, how many
 *   MOVE, to WHICH state, and how many this change cannot classify?
 *
 * THE COUNTING RULE (the instrument's contract — it travels with every figure):
 *
 *   Population: active `buildable-envelope` atoms whose `parcelNodeId` begins with one of
 *   the six Phase-0 county fips, whose `outcome.kind` is `no-buildable-area`, and which
 *   carry no `zero` proof. `status` is `active` unless the row says otherwise.
 *
 *   Bucket = classifyEnvelopeAbsenceReason(outcome.reason ?? absence.reason), the SAME
 *   function the writer guard calls (`src/property-reasoning/envelope-outcome-honesty.ts`),
 *   so the census cannot disagree with the guard about what a reason means:
 *     - "unzoned"    -> NOT-APPLICABLE   (the ordinance does not reach the parcel)
 *     - "no-district"-> PENDING-DERIVATION (provisional-front-edge; the ledger decides the cell)
 *     - null         -> UNCLASSIFIED-BY-REASON (a reason that names neither; reported, never guessed)
 *   Every atom lands in exactly one bucket, and the buckets sum to the population by
 *   construction — the run asserts both and exits non-zero if either fails.
 *
 *   An atom ALREADY carrying a `zero` proof is excluded from the population and reported
 *   separately as `alreadyComputedZero`: it is not mislabelled, and the apply must not move it.
 *
 * Usage:
 *   pnpm -C packages/engine-core exec tsx scripts/p263-envelope-outcome-census.mts \
 *       [--counties 48021,48055,...] [--json <out>] [--expect-population 490185] \
 *       [--blast-radius-max-share 0.9] [--guard]
 *
 * `--guard` is the RECURRENCE CONTROL R4 asked for ("the false-zero guard goes red if one is
 * written"): with it, a single mislabelled atom EXITS NON-ZERO (`P263_FALSE_ZERO_PRESENT`) and
 * names the counties and reasons, so the state P-263 retired cannot come back unnoticed. Without
 * it the same numbers are a census — reporting, not refusing — because the 490,185 already on
 * record are the operator's apply to move, not a build failure for every lane that reads them.
 *
 * The DSN comes from `resolveSubstrateDatabaseUrl()` and is never printed; the artifact
 * carries a host fingerprint instead.
 */
import { writeFileSync } from "node:fs";

import postgres from "postgres";

import { resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";

import {
  classifyEnvelopeAbsenceReason,
  outcomeForEnvelopeDecline,
} from "../src/property-reasoning/envelope-outcome-honesty.js";
import { evaluateBlastRadius } from "./writer-blast-radius-guard.mjs";

/** The six Phase-0 counties (doc_repo `_catalog` six-county set). */
const SIX_COUNTIES = ["48021", "48055", "48209", "48309", "48453", "48491"];
const COUNTY_NAME = {
  "48021": "Bastrop",
  "48055": "Caldwell",
  "48209": "Hays",
  "48309": "McLennan",
  "48453": "Travis",
  "48491": "Williamson",
};

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

const argv = process.argv.slice(2);
const counties = (argValue(argv, "--counties") ?? SIX_COUNTIES.join(","))
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const jsonOut = argValue(argv, "--json");
const expectPopulation = Number(argValue(argv, "--expect-population") ?? "0") || null;

const url = resolveSubstrateDatabaseUrl();
const hostFingerprint = (() => {
  try {
    return new URL(url).host.replace(/\.[a-z0-9-]+\.aws\.neon\.tech$/i, ".…neon.tech");
  } catch {
    return "unparseable";
  }
})();

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });

/**
 * The one query. Grouped by (county, outcome kind, reason, has-zero) so every figure
 * below is a sum over measurement, never an estimate.
 */
async function readPopulation() {
  return sql`
    SELECT substring(body->>'parcelNodeId' from 1 for 5) AS fips,
           body->'outcome'->>'kind' AS kind,
           coalesce(body->'outcome'->>'reason', body->'absence'->>'reason') AS reason,
           (body->'outcome' ? 'zero') AS has_zero,
           count(*)::int AS n
    FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND coalesce(body->>'status', 'active') = 'active'
      AND substring(body->>'parcelNodeId' from 1 for 5) = ANY(${counties})
    GROUP BY 1, 2, 3, 4
  `;
}

function bucketOf(kind, reason, hasZero) {
  if (hasZero) return "alreadyComputedZero";
  if (kind !== "no-buildable-area") return "notNoBuildableArea";
  const absent = classifyEnvelopeAbsenceReason(reason ?? "");
  if (absent === "unzoned") return "unzoned";
  if (absent === "no-district") return "no-district";
  return "unclassifiedByReason";
}

function movementFor(bucket, reason) {
  if (bucket === "unzoned") {
    const outcome = outcomeForEnvelopeDecline({
      declineCode: "unzoned-no-district-basis",
      reason,
    });
    return `${outcome.kind} (${outcome.reason.slice(0, 48)}…)`;
  }
  if (bucket === "no-district") return "provisional-front-edge — pending; the ledger decides the cell";
  if (bucket === "alreadyComputedZero") return "none — already carries a computed zero";
  if (bucket === "notNoBuildableArea") return "none — not this kind";
  return "UNCLASSIFIED — operator ruling needed";
}

function countyOf(fips) {
  return COUNTY_NAME[fips] ?? fips;
}

try {
  const before = await readPopulation();
  const rows = before.map((r) => {
    const bucket = bucketOf(r.kind, r.reason, r.has_zero === true);
    return { ...r, bucket, movement: movementFor(bucket, r.reason) };
  });

  const perCounty = {};
  for (const fips of counties) {
    perCounty[fips] = {
      county: countyOf(fips),
      population: 0,
      alreadyComputedZero: 0,
      notNoBuildableArea: 0,
      moves: 0,
      toNotApplicable: 0,
      toPendingDerivation: 0,
      cannotClassify: 0,
    };
  }
  for (const r of rows) {
    const c = perCounty[r.fips];
    if (!c) continue;
    if (r.bucket === "alreadyComputedZero") {
      c.alreadyComputedZero += r.n;
      continue;
    }
    if (r.bucket === "notNoBuildableArea") {
      c.notNoBuildableArea += r.n;
      continue;
    }
    c.population += r.n;
    if (r.bucket === "unzoned") {
      c.moves += r.n;
      c.toNotApplicable += r.n;
    } else if (r.bucket === "no-district") {
      c.moves += r.n;
      c.toPendingDerivation += r.n;
    } else {
      c.cannotClassify += r.n;
    }
  }

  const population = Object.values(perCounty).reduce((a, c) => a + c.population, 0);
  const bucketSum =
    Object.values(perCounty).reduce(
      (a, c) => a + c.toNotApplicable + c.toPendingDerivation + c.cannotClassify,
      0,
    );

  // P-213's refusal, REPORTED not applied to: what would an apply of this movement face?
  // The guard requires the CALLER to declare 0 < maxShare < 1, because the acceptable share
  // is a policy call, not an instrument reading. This census will not pick that number for
  // the operator: with no --blast-radius-max-share declared it reports the movement's own
  // measured share and the guard's verdict as UNMEASURED, naming the missing input.
  const envelopeAtomsInScope = rows.reduce((a, r) => a + r.n, 0);
  const declaredMaxShare = Number(argValue(argv, "--blast-radius-max-share") ?? "0") || null;
  let blastRadius;
  if (declaredMaxShare === null) {
    blastRadius = {
      verdict: "UNMEASURED",
      detail:
        "P-213's blast-radius guard refuses when it cannot measure, and requires the caller to declare 0 < maxShare < 1. This lane does not own that number; re-run with --blast-radius-max-share to get the guard's verdict on this movement.",
      movementAffected: population,
      envelopeAtomsInScope,
      measuredShareOfEnvelopeAtoms:
        envelopeAtomsInScope > 0 ? population / envelopeAtomsInScope : null,
    };
  } else {
    try {
      blastRadius = {
        verdict: "pass",
        declaredMaxShare,
        detail: evaluateBlastRadius({
          writer: "p263-envelope-outcome-census",
          scopeKey: `six-county:${counties.join(",")}`,
          affected: population,
          population: envelopeAtomsInScope,
          maxShare: declaredMaxShare,
        }),
      };
    } catch (error) {
      blastRadius = {
        verdict: error?.code ?? "THREW",
        declaredMaxShare,
        message: String(error?.message ?? error),
      };
    }
  }

  // Prove the run wrote nothing: read the population again and require identical counts.
  const after = await readPopulation();
  const digest = (rs) =>
    JSON.stringify(rs.map((r) => [r.fips, r.kind, r.reason, r.has_zero, r.n]).sort());
  const unchanged = digest(before) === digest(after);

  const artifact = {
    instrument: "p263-envelope-outcome-census",
    mode: "DRY-RUN (read-only; SELECT statements only; no write lease taken)",
    ranAt: new Date().toISOString(),
    storeHostFingerprint: hostFingerprint,
    countingRule: {
      population:
        "active buildable-envelope atoms, parcelNodeId prefix in the six counties, outcome.kind = no-buildable-area, no `zero` proof",
      classifier: "src/property-reasoning/envelope-outcome-honesty.ts#classifyEnvelopeAbsenceReason",
      buckets: ["unzoned", "no-district", "unclassifiedByReason"],
      excludedAndReportedSeparately: ["alreadyComputedZero", "notNoBuildableArea"],
      sumInvariant: "toNotApplicable + toPendingDerivation + cannotClassify == population, per county and overall",
    },
    counties,
    perCounty,
    totals: {
      population,
      bucketSum,
      toNotApplicable: Object.values(perCounty).reduce((a, c) => a + c.toNotApplicable, 0),
      toPendingDerivation: Object.values(perCounty).reduce((a, c) => a + c.toPendingDerivation, 0),
      cannotClassify: Object.values(perCounty).reduce((a, c) => a + c.cannotClassify, 0),
      alreadyComputedZero: Object.values(perCounty).reduce((a, c) => a + c.alreadyComputedZero, 0),
      notNoBuildableArea: Object.values(perCounty).reduce((a, c) => a + c.notNoBuildableArea, 0),
    },
    reasonRows: rows
      .filter((r) => r.bucket !== "notNoBuildableArea")
      .map((r) => ({
        fips: r.fips,
        county: countyOf(r.fips),
        bucket: r.bucket,
        reason: r.reason,
        n: r.n,
        movement: r.movement,
      }))
      .sort((a, b) => (a.fips + a.bucket).localeCompare(b.fips + b.bucket)),
    blastRadius,
    writeProof: {
      statementsIssued: "SELECT only (two identical population reads)",
      populationDigestBefore: digest(before).length,
      populationDigestAfter: digest(after).length,
      storeUnchangedBetweenReads: unchanged,
    },
    sums: {
      populationMatchesBucketSum: population === bucketSum,
      populationMatchesMissionPremise:
        expectPopulation === null ? "not asserted" : population === expectPopulation,
      expectedPopulation: expectPopulation,
    },
  };

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));

  console.log(
    JSON.stringify(
      {
        mode: artifact.mode,
        storeHostFingerprint,
        totals: artifact.totals,
        perCounty: Object.fromEntries(
          Object.entries(perCounty).map(([f, c]) => [
            `${f} ${c.county}`,
            {
              population: c.population,
              toNotApplicable: c.toNotApplicable,
              toPendingDerivation: c.toPendingDerivation,
              cannotClassify: c.cannotClassify,
            },
          ]),
        ),
        sums: artifact.sums,
        blastRadiusVerdict: blastRadius.verdict,
        writeProof: artifact.writeProof,
        json: jsonOut ?? null,
      },
      null,
      2,
    ),
  );

  const guardMode = argv.includes("--guard");
  const ok =
    unchanged &&
    population === bucketSum &&
    (expectPopulation === null || population === expectPopulation) &&
    (!guardMode || population === 0);
  process.exitCode = ok ? 0 : 1;
  if (!ok) {
    console.error(
      JSON.stringify({
        event: "p263-census.invariant-failed",
        unchanged,
        population,
        bucketSum,
        expectPopulation,
      }),
    );
  }
  if (guardMode && population > 0) {
    console.error(
      JSON.stringify({
        event: "P263_FALSE_ZERO_PRESENT",
        refused: true,
        population,
        byCounty: Object.fromEntries(
          Object.entries(perCounty)
            .filter(([, c]) => c.population > 0)
            .map(([f, c]) => [
              f,
              {
                unzoned: c.toNotApplicable,
                noDistrict: c.toPendingDerivation,
                unclassifiedByReason: c.cannotClassify,
              },
            ]),
        ),
        why:
          "buildable-envelope atoms claim `no-buildable-area` (served to the customer as 'Setbacks consume the lot') with a reason that names an absence of law or data and no computed zero behind them. P-263 removed the writers that mint this state; this guard is what notices one being written again.",
      }),
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
