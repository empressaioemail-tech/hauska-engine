#!/usr/bin/env node
/**
 * P-275 namespace probe — the registration EVIDENCE for `county-live-currency-sources.mjs`.
 *
 * This is not a test and not a review. It answers one question per registered county, against the
 * live service, with the real reader the review CLI uses:
 *
 *     Is the field this county's source exposes in the SAME identifier namespace as the node id?
 *
 * It is asked of REAL node ids taken from the atoms store (active, and retired where any exist)
 * plus a FABRICATED control id that no county can have. The shape of a pass:
 *
 *   real ACTIVE node ids   -> live      (they are current, so the county must have them)
 *   the fabricated control -> absent    (nothing answers 1 for an id that does not exist)
 *   real RETIRED node ids  -> whatever the county actually says, reported not judged
 *
 * A source that returns `absent` for real active ids has the WRONG FIELD or the wrong namespace,
 * and is not registrable — that is the Williamson `PropertyID`/`QuickRefID` trap, demonstrated here
 * rather than argued.
 *
 * READ-ONLY: no database write, no store write, no `--apply`. Every read is a GET.
 *
 *   node scripts/p275-namespace-probe.mjs --out=probe.json [--ids=path.json]
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  LIVE_CURRENCY_SOURCES,
  liveCurrencySourceFor,
  registeredLiveCurrencyCounties,
} from "./county-live-currency-sources.mjs";
import { LIVE_CURRENCY_UNREACHABLE, normalizeLiveCurrencyId } from "./county-parcel-id-currency.mjs";

/** Real ids per county from the atoms store, sampled 2026-09-17 (see the close artifact). */
const SAMPLES = {
  "48021": {
    active: ["48021:10001", "48021:10002", "48021:10003"],
    retired: ["48021:10031", "48021:10090", "48021:103397"],
  },
  "48055": {
    active: ["48055:10001", "48055:10002", "48055:10003", "48055:10004", "48055:10005"],
    retired: [],
  },
  "48209": {
    active: [
      "48209:100002",
      "48209:10001",
      "48209:100010",
      "48209:100012",
      "48209:100013",
      "48209:100014",
    ],
    retired: [],
  },
  "48309": {
    active: ["48309:100000", "48309:100001", "48309:100003", "48309:100005", "48309:100006"],
    retired: [],
  },
  "48453": {
    active: [
      "48453:1000025",
      "48453:1000026",
      "48453:1000027",
      "48453:1000028",
      "48453:1000029",
    ],
    // Every one of Travis's 40 retired parcel-node atoms is a SYNTHETIC within-vintage key, so
    // there is no askable retired id for Travis at all. `synthetic` below carries the first few so
    // the probe records WHY rather than appearing to have skipped them.
    retired: [],
    synthetic: [
      "48453:_feature-stratmap25-landparcels-48453-travis-202508-514256",
      "48453:_feature-stratmap25-landparcels-48453-travis-202508-815683",
    ],
  },
  "48491": {
    active: ["48491:R000009", "48491:R000013", "48491:R000016", "48491:R000017", "48491:R000019"],
    retired: [],
  },
};

/** An id no county can hold. Anything but `absent` for this is a source that is not measuring ids. */
const CONTROLS = {
  "48021": ["999999999"],
  "48055": ["999999999"],
  "48209": ["999999999"],
  "48309": ["999999999"],
  "48453": ["999999999"],
  "48491": ["ZZZZZZZ"],
};

function parseArgs(argv) {
  const out = { out: null, ids: null };
  for (const a of argv) {
    if (a.startsWith("--out=")) out.out = a.slice("--out=".length).trim() || null;
    else if (a.startsWith("--ids=")) out.ids = a.slice("--ids=".length).trim() || null;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const samples = args.ids ? JSON.parse(readFileSync(args.ids, "utf8")) : SAMPLES;

const report = {
  event: "p275-namespace-probe",
  method:
    "real node ids from the atoms store (active, plus retired where any exist) queried against the " +
    "county's own public cadastral service by the candidate field, with a fabricated control id " +
    "that must answer absent. The field is in the node-id namespace iff real ACTIVE ids answer " +
    "live and the control answers absent.",
  registered: registeredLiveCurrencyCounties(),
  counties: {},
};

for (const [fips, sample] of Object.entries(samples)) {
  const entry = { fips, source: LIVE_CURRENCY_SOURCES[fips] ? "registered" : "none-registered" };
  const src = liveCurrencySourceFor(fips);
  if (!src) {
    entry.verdict = "NOT_REGISTERED";
    entry.note =
      "no usable public county-wide cadastral service; candidates report UNMEASURED. This is a " +
      "deliberate outcome, not an omission — see NO_SOURCE_REASONS in county-live-currency-sources.mjs";
    report.counties[fips] = entry;
    continue;
  }

  const controlIds = CONTROLS[fips] ?? [];
  // The reader is keyed by the token after the `:` — exactly what the CLI asks with.
  const askActive = sample.active.map((id) => id.split(":")[1]);
  const askRetired = (sample.retired ?? []).map((id) => id.split(":")[1]);
  const askControl = controlIds;

  try {
    const readings = await src([...askActive, ...askRetired, ...askControl]);
    const verdicts = [];
    for (const id of sample.active) verdicts.push({ id, kind: "active", got: readings.get(normalizeLiveCurrencyId(id.split(":")[1])) });
    for (const id of sample.retired ?? []) verdicts.push({ id, kind: "retired", got: readings.get(normalizeLiveCurrencyId(id.split(":")[1])) });
    for (const raw of controlIds) verdicts.push({ id: `${fips}:${raw}`, kind: "fabricated-control", got: readings.get(normalizeLiveCurrencyId(raw)) });

    const realActive = verdicts.filter((v) => v.kind === "active");
    const controls = verdicts.filter((v) => v.kind === "fabricated-control");
    const activeLive = realActive.filter((v) => v.got?.reading === "live").length;
    const controlAbsent = controls.filter((v) => v.got?.reading === "absent").length;

    entry.field = src.describe?.idField ?? null;
    entry.layerName = src.describe?.layerName ?? null;
    entry.fieldType = src.describe?.fieldType ?? null;
    entry.requests = typeof src.requests === "number" ? src.requests : null;
    entry.verdicts = verdicts;
    entry.syntheticNotAskable = (sample.synthetic ?? []).map((id) => ({
      id,
      reading: "unmeasured",
      reason:
        "synthetic within-vintage key (invariant S1): not a parcel identifier any external " +
        "service can be asked about. The review reports these UNMEASURED, never absent.",
    }));
    entry.tally = {
      realActive: realActive.length,
      realActiveLive: activeLive,
      retired: (sample.retired ?? []).length,
      controls: controls.length,
      controlsAbsent: controlAbsent,
    };
    entry.verdict =
      realActive.length > 0 && activeLive === realActive.length && controlAbsent === controls.length
        ? "NAMESPACE_CONFIRMED"
        : "NAMESPACE_NOT_CONFIRMED";
  } catch (err) {
    entry.verdict = err?.code === LIVE_CURRENCY_UNREACHABLE ? "UNREACHABLE" : "ERROR";
    entry.reason = String(err?.message ?? err);
    entry.requests = typeof src.requests === "number" ? src.requests : null;
  }
  report.counties[fips] = entry;
}

report.summary = Object.fromEntries(
  Object.entries(report.counties).map(([fips, c]) => [fips, c.verdict]),
);

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.error(`p275-namespace-probe artifact written to ${args.out}`);
}
