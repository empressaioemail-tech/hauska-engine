#!/usr/bin/env tsx
/**
 * G-165 probe — the NOAA Atlas 14 PFDS parser, measured against the LIVE endpoint.
 *
 * WHY THIS IS A FILE AND NOT A SHELL ONE-LINER. ENFORCEMENT.md, "the instrument that
 * produced a claim is part of the claim": a load-bearing claim needs a file-based
 * instrument that has been shown to fire. This probe therefore
 *   (1) runs the REAL HDSC endpoint (no fixture),
 *   (2) runs the REAL engine code paths the product uses (`resolveStudyRainfall` via
 *       `fetchNoaaAtlas14PointEstimate`, and `resolveRainfallForcing`), and
 *   (3) carries the FROZEN pre-G-165 parser verbatim, so the pre-fix half of the
 *       violation stays reproducible from the post-fix tree instead of being narrated.
 *
 * The perturbation harness carries BOTH directions: payloads that must be REFUSED and
 * payloads that must still PARSE. A harness that refuses everything grades nothing.
 *
 * Usage (from the hauska-engine worktree root):
 *   pnpm exec tsx scripts/audit/g165-noaa-parser-probe.mts <out.json>
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  buildPfdsUrl,
  fetchNoaaAtlas14PointEstimate,
  parsePfdsDepthTable,
} from "../../packages/adapters/src/hydrology/noaaAtlas14.js";
import { resolveRainfallForcing } from "../../packages/adapters/src/hydrology/rainfallForcing.js";
import {
  DEFAULT_RAINFALL_DEPTH_INCHES,
  resolveStudyRainfall,
} from "../../packages/engine-core/src/site-plan/flood-drainage-study.js";

// ─────────────────────────────────────────────────────────────────────────
// The pre-G-165 parser, FROZEN VERBATIM from hauska-engine origin/main
// cff8d882f1d46040093cfc6f8ef612b99ee0c1ff
// (packages/adapters/src/hydrology/noaaAtlas14.ts, lines 28-42).
// It is the control: if this ever stops returning an empty map on the live
// payload, the premise of the row has changed and the probe says so.
// ─────────────────────────────────────────────────────────────────────────
const LEGACY_SHA = "cff8d882f1d46040093cfc6f8ef612b99ee0c1ff";
function legacyParsePfdsDepthTable(html: string): Map<number, number> {
  const out = new Map<number, number>();
  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const years = Number(match[1]);
    const depth = Number(match[2]);
    if (Number.isFinite(years) && Number.isFinite(depth)) {
      out.set(years, depth);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Points. Chosen because their true Atlas 14 100-yr 24-hr depths genuinely
// differ (measured live, 2026-09-18: Bastrop 12.6 in, El Paso 4.70 in), so a
// single shared answer from either point is a located falsifier of the claim
// that location matters.
// ─────────────────────────────────────────────────────────────────────────
const POINTS = [
  { name: "bastrop-tx", lat: 30.1105, lng: -97.3169 },
  { name: "el-paso-tx", lat: 31.7619, lng: -106.485 },
] as const;

const RETURN_PERIOD = 100;

const now = () => new Date().toISOString();

function gitFile(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "UNAVAILABLE";
  }
}

async function fetchLive(
  lat: number,
  lng: number,
): Promise<{ url: string; status: number; bytes: number; text: string }> {
  const url = buildPfdsUrl(lat, lng);
  const res = await fetch(url, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { url, status: res.status, bytes: Buffer.byteLength(text, "utf8"), text };
}

type Outcome<T> =
  | { outcome: "value"; value: T }
  | { outcome: "refusal"; code: string; message: string };

function codeOf(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "threw";
  return { code, message };
}

async function attempt<T>(fn: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { outcome: "value", value: await fn() };
  } catch (err) {
    return { outcome: "refusal", ...codeOf(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Perturbations. Each declares which way it must go. `expect: "refuse"` items
// are payloads a parser must not answer; the `expect: "parse"` item is the
// control that keeps the refusal from being indiscriminate.
// ─────────────────────────────────────────────────────────────────────────
function quantilesRows(payload: string): string[][] | null {
  const m = /quantiles = (\[\[.*?\]\]);/s.exec(payload);
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1].replace(/'/g, '"')) as string[][];
  } catch {
    return null;
  }
}

function withQuantiles(payload: string, rows: string[][]): string {
  const m = /quantiles = (\[\[.*?\]\]);/s.exec(payload);
  if (!m || !m[1]) return payload;
  return payload.replace(m[1], JSON.stringify(rows).replace(/"/g, "'"));
}

const PERTURBATIONS: ReadonlyArray<{
  name: string;
  expect: "refuse" | "parse";
  why: string;
  of: (p: string) => string;
}> = [
  {
    name: "CONTROL-whitespace-only",
    expect: "parse",
    why: "a harmless reformat must NOT be refused — this is the divergence test that keeps refusal from being indiscriminate",
    of: (p) => p.replace(/,\s*/g, ", ").replace(/;\n/g, ";\n\n"),
  },
  {
    name: "quantiles-assignment-removed",
    expect: "refuse",
    why: "the matrix the parser exists to read is absent",
    of: (p) => p.replace(/quantiles = \[\[.*?\]\];/s, ""),
  },
  {
    name: "24hr-row-dropped",
    expect: "refuse",
    why: "row 9 (24-hr) removed: a positional parser would silently serve the 2-day row as 24-hr",
    of: (p) => {
      const rows = quantilesRows(p);
      if (!rows) return p;
      rows.splice(9, 1);
      return withQuantiles(p, rows);
    },
  },
  {
    name: "12hr-24hr-rows-swapped",
    expect: "refuse",
    why: "same length, same values, wrong duration: only a duration-monotonicity law can see it",
    of: (p) => {
      const rows = quantilesRows(p);
      const a = rows?.[8];
      const b = rows?.[9];
      if (!rows || !a || !b) return p;
      rows[8] = b;
      rows[9] = a;
      return withQuantiles(p, rows);
    },
  },
  {
    name: "24hr-row-values-reversed",
    expect: "refuse",
    why: "depth that falls as the return period rises is not a frequency curve",
    of: (p) => {
      const rows = quantilesRows(p);
      const r = rows?.[9];
      if (!rows || !r) return p;
      rows[9] = [...r].reverse();
      return withQuantiles(p, rows);
    },
  },
  {
    name: "result-echoed-as-null",
    expect: "refuse",
    why: "the endpoint declares this grid point has no values (live shape, verified 2026-09-18)",
    of: (p) => p.replace(/result = 'values'/, "result = 'null'"),
  },
  {
    name: "result-echoed-as-none",
    expect: "refuse",
    why: "the endpoint declares the point is outside every Atlas 14 project area (live shape, verified 2026-09-18)",
    of: (p) => p.replace(/result = 'values'/, "result = 'none'"),
  },
  {
    name: "unit-echoed-as-metric",
    expect: "refuse",
    why: "the payload declares its numbers are not the inches we asked for",
    of: (p) => p.replace(/unit = 'english'/, "unit = 'metric'"),
  },
  {
    name: "datatype-echoed-as-intensity",
    expect: "refuse",
    why: "the payload declares intensity, not depth",
    of: (p) => p.replace(/datatype = 'depth'/, "datatype = 'intensity'"),
  },
  {
    name: "series-echoed-as-ams",
    expect: "refuse",
    why: "annual-maximum series, not the partial-duration series the caller asked for",
    of: (p) => p.replace(/ser = 'pds'/, "ser = 'ams'"),
  },
  {
    name: "location-echo-moved",
    expect: "refuse",
    why: "the payload is for a different point than the one requested",
    of: (p) => p.replace(/lat = '[^']*'/, "lat = '44.0000'"),
  },
  {
    name: "truncated-body",
    expect: "refuse",
    why: "transport truncation",
    of: (p) => p.slice(0, Math.floor(p.length / 2)),
  },
  {
    name: "legacy-html-table",
    expect: "refuse",
    why: "the shape the pre-G-165 fixture encodes, and the shape the endpoint no longer returns",
    of: () => "<table><tr><td>100</td><td>6.2</td></tr></table>",
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Run.
// ─────────────────────────────────────────────────────────────────────────

const startedAt = now();
const snapshot = {
  repo: "hauska-engine",
  worktree: process.cwd(),
  branch: gitFile(["rev-parse", "--abbrev-ref", "HEAD"]),
  commit: gitFile(["rev-parse", "HEAD"]),
  commitSubject: gitFile(["log", "-1", "--format=%s"]),
  readAt: startedAt,
};

const pointReadings: unknown[] = [];
let livePayload = "";

for (const point of POINTS) {
  const live = await fetchLive(point.lat, point.lng);
  if (livePayload === "") livePayload = live.text;

  const shipped = await attempt(() => {
    const map = parsePfdsDepthTable(live.text, {
      durationHours: 24,
      expectLatLng: { lat: point.lat, lng: point.lng },
    });
    return { mapSize: map.size, depth100yr: map.get(RETURN_PERIOD) ?? null };
  });

  const legacy = (() => {
    const map = legacyParsePfdsDepthTable(live.text);
    return { mapSize: map.size, depth100yr: map.get(RETURN_PERIOD) ?? null };
  })();

  const study = await attempt(async () => {
    const r = await resolveStudyRainfall(
      { lat: point.lat, lng: point.lng },
      undefined,
      fetchNoaaAtlas14PointEstimate,
    );
    return {
      source: r.source,
      depthInches: r.depthInches,
      detail: r.detail,
      curvePoints: r.curve?.length ?? 0,
      depth100yrFromCurve:
        r.curve?.find((c) => c.returnPeriodYears === RETURN_PERIOD)?.depthInches ?? null,
    };
  });

  const forcing = await attempt(async () => {
    const r = await resolveRainfallForcing({ lat: point.lat, lng: point.lng });
    return {
      kind: r.kind,
      depthInches: r.depthInches,
      returnPeriodYears: "returnPeriodYears" in r ? r.returnPeriodYears : null,
      designStormCount: r.kind === "noaa-atlas-14" ? r.estimate.designStorms.length : null,
    };
  });

  pointReadings.push({
    ...point,
    http: { status: live.status, bytes: live.bytes, url: live.url },
    shippedParser: shipped,
    legacyParser: legacy,
    study,
    rainfallForcingRoutePath: forcing,
  });
}

// ── The verdicts that carry the row, derived from the readings above.

type StudyValue = {
  source: string;
  depthInches: number;
  detail: string;
  curvePoints: number;
  depth100yrFromCurve: number | null;
};
type ShippedValue = { mapSize: number; depth100yr: number | null };

const asReading = <T,>(p: unknown, key: string): T | null => {
  const v = (p as Record<string, Outcome<T> | undefined>)[key];
  return v && v.outcome === "value" ? v.value : null;
};

const shippedDepths = pointReadings.map(
  (p) => asReading<ShippedValue>(p, "shippedParser")?.depth100yr ?? null,
);
const legacyDepths = pointReadings.map(
  (p) => (p as { legacyParser: { depth100yr: number | null } }).legacyParser.depth100yr,
);
const studySources = pointReadings.map(
  (p) => asReading<StudyValue>(p, "study")?.source ?? null,
);
const studyDepths = pointReadings.map(
  (p) => asReading<StudyValue>(p, "study")?.depthInches ?? null,
);
const routeKinds = pointReadings.map(
  (p) => asReading<{ kind: string }>(p, "rainfallForcingRoutePath")?.kind ?? null,
);
const routeDepths = pointReadings.map(
  (p) => asReading<{ depthInches: number }>(p, "rainfallForcingRoutePath")?.depthInches ?? null,
);

const distinct = (xs: ReadonlyArray<number | null>) =>
  new Set(xs.filter((x): x is number => typeof x === "number")).size;

const verdicts = {
  /** Post-fix positive: the shipped parser produces a value for BOTH points. */
  parserProducesAValue: {
    pass: shippedDepths.every((d) => typeof d === "number"),
    measured: { shippedDepths },
  },
  /** Post-fix, the load-bearing clause: location changes the number. */
  depthVariesWithLocation: {
    pass: distinct(shippedDepths) === POINTS.length,
    measured: { shippedDepths, distinctValues: distinct(shippedDepths) },
    rule: `${POINTS.length} points; PASS requires ${POINTS.length} distinct 100-yr 24-hr depths`,
  },
  /**
   * The pre-fix falsifier, run through the FROZEN pre-G-165 parser AND both live
   * call paths: one identical depth for points whose true depths differ, under a
   * NOAA citation.
   */
  prefixDefectReproduces: {
    legacyParserReturnsNothing: legacyDepths.every((d) => d === null),
    studyServesOneDepthForBothPoints: distinct(studyDepths) === 1,
    studyDepthIsTheSharedNinePointFive: studyDepths.every(
      (d) => d === DEFAULT_RAINFALL_DEPTH_INCHES,
    ),
    routeCitesNoaaOnOneInventedNumber:
      routeKinds.every((k) => k === "noaa-atlas-14") && distinct(routeDepths) === 1,
    measured: { legacyDepths, studyDepths, studySources, routeKinds, routeDepths },
  },
  /** Post-fix: on the live payload the study path cites NOAA only on parsed numbers. */
  studyCitesNoaaOnParsedNumbers: {
    pass:
      studySources.every((s) => s === "noaa-atlas14") &&
      distinct(studyDepths) === POINTS.length,
    measured: { studySources, studyDepths },
  },
};

// ── Perturbations, both parsers, so each expectation is shown to be evaluated.

const perturbationResults = PERTURBATIONS.map((pert) => {
  const payload = pert.of(livePayload);
  let shipped: Record<string, unknown>;
  try {
    const map = parsePfdsDepthTable(payload, {
      durationHours: 24,
      expectLatLng: { lat: POINTS[0].lat, lng: POINTS[0].lng },
    });
    shipped = { outcome: "value", mapSize: map.size, depth100yr: map.get(RETURN_PERIOD) ?? null };
  } catch (err) {
    shipped = { outcome: "refusal", ...codeOf(err) };
  }
  const legacyMap = legacyParsePfdsDepthTable(payload);
  const observed =
    shipped.outcome === "refusal"
      ? "refuse"
      : (shipped.mapSize as number) > 0
        ? "parse"
        : "empty";
  return {
    name: pert.name,
    expect: pert.expect,
    why: pert.why,
    payloadChanged: payload !== livePayload,
    shipped,
    observed,
    legacy: {
      outcome: "answered",
      mapSize: legacyMap.size,
      depth100yr: legacyMap.get(RETURN_PERIOD) ?? null,
    },
    expectationMet: observed === pert.expect,
  };
});

const out = {
  probe: "g165-noaa-parser",
  startedAt,
  finishedAt: now(),
  snapshot,
  frozenLegacyParserSha: LEGACY_SHA,
  endpointBasis: {
    url: buildPfdsUrl(POINTS[0].lat, POINTS[0].lng),
    livePayloadBytes: Buffer.byteLength(livePayload, "utf8"),
    livePayloadHead: livePayload.slice(0, 400),
    livePayloadSha256ThisFetchOnly:
      createHash("sha256").update(livePayload, "utf8").digest("hex"),
    quantilesLiteralSha256: (() => {
      const m = /quantiles = (\[\[.*?\]\]);/s.exec(livePayload);
      return m?.[1] ? createHash("sha256").update(m[1], "utf8").digest("hex") : null;
    })(),
    identityNote:
      "A raw-body hash is NOT a stable identity for this endpoint: the payload embeds `pyRunTime = <float>`, which differs on every call (measured 2026-09-18: two fetches, 5073 vs 5074 bytes, differing sha256, byte difference confined to that field). The stable identity is `quantilesLiteralSha256`, which is the matrix this parser consumes and is what the fixture and the perturbed-payload tests key on.",
    note: "payload captured live by this probe at snapshot.readAt; a third-party payload without a timestamp is not a ground-truth",
  },
  points: pointReadings,
  verdicts,
  perturbations: {
    total: perturbationResults.length,
    refusedWhenRequired:
      perturbationResults.filter((r) => r.expect === "refuse" && r.expectationMet).length,
    refusedWhenRequiredTotal: perturbationResults.filter((r) => r.expect === "refuse").length,
    parsedWhenRequired:
      perturbationResults.filter((r) => r.expect === "parse" && r.expectationMet).length,
    parsedWhenRequiredTotal: perturbationResults.filter((r) => r.expect === "parse").length,
    allExpectationsMet: perturbationResults.every((r) => r.expectationMet),
    readings: perturbationResults,
  },
};

const outPath = process.argv[2] ?? "g165-noaa-parser-probe.json";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log(
  JSON.stringify(
    {
      snapshot,
      verdicts,
      perturbations: {
        total: out.perturbations.total,
        refusedWhenRequired: `${out.perturbations.refusedWhenRequired}/${out.perturbations.refusedWhenRequiredTotal}`,
        parsedWhenRequired: `${out.perturbations.parsedWhenRequired}/${out.perturbations.parsedWhenRequiredTotal}`,
        allExpectationsMet: out.perturbations.allExpectationsMet,
      },
      outPath,
    },
    null,
    2,
  ),
);
