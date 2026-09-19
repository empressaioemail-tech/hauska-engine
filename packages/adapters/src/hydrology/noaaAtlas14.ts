/**
 * NOAA Atlas 14 PFDS point precipitation-frequency client.
 *
 * v1 forcing source for design-storm depths (2/10/25/100/500-yr at 24-hr)
 * per 40d Phase 2D.3. Uses the HDSC endpoint documented in NOAA FAQs:
 * https://www.weather.gov/owp/hdsc_faqs
 *
 * ────────────────────────────────────────────────────────────────────────
 * G-165 (2026-09-18) — THE PAYLOAD SHAPE THIS FILE WAS WRITTEN AGAINST
 *
 * The HDSC endpoint does NOT return an HTML `<tr><td>` table. It returns a
 * JavaScript array-literal payload. Captured live 2026-09-18T22:15:33Z,
 * HTTP 200 for a Bastrop point, verbatim prefix:
 *
 *   result = 'values';
 *   quantiles = [['0.458', '0.538', '0.670', '0.779', '0.927', '1.04', ...], ...];
 *
 * with a request echo of `file`, `lat`, `lon`, `type`, `ser`, `datatype`,
 * `unit`, `region`, `reg`, `volume`, `version`, `authors`, `pyRunTime`.
 *
 * The pre-G-165 parser matched `<tr[^>]*>\s*<td[^>]*>(\d+)</td>...`, so on
 * the live payload it matched NOTHING and returned an EMPTY Map — which every
 * caller read as "no Atlas 14 row for this point". Two call paths then served
 * a number the parser had not produced (the study path a 9.5 in regional
 * default; the `/rainfall-forcing` route a hardcoded 4 in) while the payload
 * carried a NOAA Atlas 14 citation. A parser that returns nothing on a shape
 * it does not understand IS the defect; this one REFUSES instead. See
 * {@link PfdsRefusal}.
 *
 * ────────────────────────────────────────────────────────────────────────
 * MATRIX SEMANTICS — AND WHY THEY ARE NOT AN ASSUMPTION
 *
 * `quantiles` is 19 rows x 10 columns and carries NO axis labels.
 *   rows    = DURATIONS, in the order NOAA prints them — {@link PFDS_DURATION_ROWS}
 *             (5-min, 10-min, 15-min, 30-min, 60-min, 2-hr, 3-hr, 6-hr, 12-hr,
 *             24-hr, 2-day, 3-day, 4-day, 7-day, 10-day, 20-day, 30-day,
 *             45-day, 60-day)
 *   columns = ARI / return periods in years — {@link PFDS_RETURN_PERIOD_COLUMNS}
 *             (1, 2, 5, 10, 25, 50, 100, 200, 500, 1000)
 *
 * The row order is not read off the payload, because it is not in the payload.
 * It is anchored to a SECOND, LABELED derivation from the same authority: the
 * sibling endpoint `hdsc.nws.noaa.gov/cgi-bin/new/fe_text.csv` returns the
 * same numbers with an explicit header `by duration for ARI (years):, 1,2,5,
 * 10,25,50,100,200,500,1000` and explicit row labels `5-min:`, `10-min:`, ...
 * For both probe points the CSV's labeled `24-hr:` row is value-identical to
 * `quantiles` row index 9 (Bastrop 3.21,4.17,5.51,6.81,8.81,10.5,12.6,14.9,
 * 18.5,21.5; El Paso 1.20,1.58,2.12,2.62,3.37,4.00,4.70,5.51,6.72,7.74).
 * Measured 2026-09-18. If NOAA ever reorders that matrix, the two monotonicity
 * laws below fail closed instead of shifting every duration silently.
 *
 * A raw-body hash is NOT a stable identity for this endpoint: the payload
 * embeds `pyRunTime = <float>`, which changes on every call. The stable
 * identity of a capture is the `quantiles` literal.
 */

export interface NoaaAtlas14DesignStorm {
  returnPeriodYears: number;
  durationHours: number;
  depthInches: number;
}

export interface NoaaAtlas14PointEstimate {
  lat: number;
  lng: number;
  source: "noaa-atlas-14-pfds";
  fetchedAt: string;
  /** 24-hour precipitation depth by return period. */
  designStorms: ReadonlyArray<NoaaAtlas14DesignStorm>;
  endpoint: string;
}

const RETURN_PERIODS = [2, 10, 25, 100, 500] as const;
const DURATION_HOURS = 24;

/** The duration the design storms are keyed to, absent an explicit ask. */
export const DEFAULT_PFDS_DURATION_HOURS = DURATION_HOURS;

// ─────────────────────────────────────────────────────────────────────────
// The payload's own two axes, in NOAA's published order.
// ─────────────────────────────────────────────────────────────────────────

export interface PfdsDurationRow {
  /** NOAA's label for this duration, as it spells it on the labeled endpoint. */
  label: string;
  minutes: number;
}

/** `quantiles` rows, in order. 19 entries. */
export const PFDS_DURATION_ROWS: ReadonlyArray<PfdsDurationRow> = [
  { label: "5-min", minutes: 5 },
  { label: "10-min", minutes: 10 },
  { label: "15-min", minutes: 15 },
  { label: "30-min", minutes: 30 },
  { label: "60-min", minutes: 60 },
  { label: "2-hr", minutes: 120 },
  { label: "3-hr", minutes: 180 },
  { label: "6-hr", minutes: 360 },
  { label: "12-hr", minutes: 720 },
  { label: "24-hr", minutes: 1440 },
  { label: "2-day", minutes: 2880 },
  { label: "3-day", minutes: 4320 },
  { label: "4-day", minutes: 5760 },
  { label: "7-day", minutes: 10080 },
  { label: "10-day", minutes: 14400 },
  { label: "20-day", minutes: 28800 },
  { label: "30-day", minutes: 43200 },
  { label: "45-day", minutes: 64800 },
  { label: "60-day", minutes: 86400 },
];

/** `quantiles` columns, in order. 10 entries. */
export const PFDS_RETURN_PERIOD_COLUMNS: ReadonlyArray<number> = [
  1, 2, 5, 10, 25, 50, 100, 200, 500, 1000,
];

// ─────────────────────────────────────────────────────────────────────────
// Refusal — the typed "I will not answer" every caller can branch on.
// ─────────────────────────────────────────────────────────────────────────

export type PfdsRefusalCode =
  /** the fetch itself failed (DNS, TLS, timeout) */
  | "transport_error"
  /** HDSC answered, but not with 200 */
  | "http_status"
  /** no `result = '...'` echo: not a PFDS payload at all */
  | "result_missing"
  /** NOAA says there is no Atlas 14 value at this point (`null` / `none`) */
  | "result_not_values"
  /** a semantic echo (`type`, `datatype`, `unit`, `ser`) is absent */
  | "echo_missing"
  /** a semantic echo disagrees with what this parser can publish */
  | "echo_mismatch"
  /** the payload's lat/lon echo is for a different point than the one asked for */
  | "location_mismatch"
  /** no `quantiles = ` assignment */
  | "quantiles_missing"
  /** `quantiles` is not a well-formed rectangular numeric array literal */
  | "quantiles_malformed"
  /** the matrix is not 19 x 10 */
  | "matrix_shape"
  /** the requested duration is not one of the 19 published rows */
  | "unsupported_duration"
  /** a row does not rise with the return period */
  | "return_period_not_increasing"
  /** a column does not rise with the duration */
  | "duration_not_increasing"
  /** an injected estimate carried no design storms at all */
  | "estimate_empty";

export interface PfdsRefusalInit {
  code: PfdsRefusalCode;
  detail: string;
  /**
   * True only when NOAA itself declares the point carries no Atlas 14 value
   * (`result = 'null'` / `'none'`). This is the one refusal that is a
   * PRINCIPLED ABSENCE rather than an instrument failure, and callers may name
   * their fallback differently for it.
   */
  notCovered?: boolean;
  /** NOAA's own `ErrorMsg`, verbatim, when it sent one. */
  errorMsg?: string | null;
}

export class PfdsRefusal extends Error {
  readonly code: PfdsRefusalCode;
  readonly detail: string;
  readonly notCovered: boolean;
  readonly errorMsg: string | null;

  constructor(init: PfdsRefusalInit) {
    super(`NOAA Atlas 14 PFDS refused (${init.code}): ${init.detail}`);
    this.name = "PfdsRefusal";
    this.code = init.code;
    this.detail = init.detail;
    this.notCovered = init.notCovered ?? false;
    this.errorMsg = init.errorMsg ?? null;
  }
}

/**
 * Refusals are COUNTED, not just thrown (G-165: "any surviving fallback is
 * named, counted and marked on read"). One increment site — {@link refuse} —
 * so the tally cannot drift from the throws. In-process and reset on restart;
 * reset it in tests via {@link resetPfdsRefusalTally}.
 */
const refusalTally: {
  total: number;
  byCode: Partial<Record<PfdsRefusalCode, number>>;
  lastDetail: string | null;
} = { total: 0, byCode: {}, lastDetail: null };

export interface PfdsRefusalTally {
  total: number;
  byCode: Readonly<Partial<Record<PfdsRefusalCode, number>>>;
  lastDetail: string | null;
}

export function pfdsRefusalTally(): PfdsRefusalTally {
  return { total: refusalTally.total, byCode: { ...refusalTally.byCode }, lastDetail: refusalTally.lastDetail };
}

export function resetPfdsRefusalTally(): void {
  refusalTally.total = 0;
  refusalTally.byCode = {};
  refusalTally.lastDetail = null;
}

function refuse(init: PfdsRefusalInit): never {
  refusalTally.total += 1;
  refusalTally.byCode[init.code] = (refusalTally.byCode[init.code] ?? 0) + 1;
  refusalTally.lastDetail = init.detail;
  throw new PfdsRefusal(init);
}

// ─────────────────────────────────────────────────────────────────────────
// Payload reader.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read a `name = 'value'` echo out of the payload. `keys` may carry alternate
 * spellings the endpoint has used (`ser` / `series`).
 */
function readEcho(payload: string, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const re = new RegExp(String.raw`(?:^|[;{\s])${key}\s*=\s*'([^']*)'`);
    const m = re.exec(payload);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** Slice out the balanced `[...]` literal assigned to `name`, quotes respected. */
function readArrayLiteral(payload: string, name: string): string {
  const keyRe = new RegExp(String.raw`(?:^|[;{\s])${name}\s*=\s*`);
  const m = keyRe.exec(payload);
  if (!m) {
    refuse({
      code: "quantiles_missing",
      detail: `payload carries no \`${name} = \` assignment`,
    });
  }
  const start = m.index + m[0].length;
  if (payload[start] !== "[") {
    refuse({
      code: "quantiles_malformed",
      detail: `\`${name} = \` is not followed by an array literal`,
    });
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < payload.length; i += 1) {
    const ch = payload[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return payload.slice(start, i + 1);
    }
  }
  refuse({
    code: "quantiles_malformed",
    detail: `\`${name}\` array literal is unterminated (truncated body?)`,
  });
}

function readQuantilesMatrix(payload: string): number[][] {
  const literal = readArrayLiteral(payload, "quantiles");
  let raw: unknown;
  try {
    raw = JSON.parse(literal.replace(/'/g, '"'));
  } catch (err) {
    refuse({
      code: "quantiles_malformed",
      detail: `quantiles is not a parseable array literal: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse({ code: "quantiles_malformed", detail: "quantiles is not a non-empty array" });
  }
  const rows: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) {
      refuse({ code: "quantiles_malformed", detail: "a quantiles row is not an array" });
    }
    const nums: number[] = [];
    for (const cell of row) {
      const n =
        typeof cell === "number"
          ? cell
          : typeof cell === "string"
            ? Number(cell)
            : Number.NaN;
      if (!Number.isFinite(n)) {
        refuse({
          code: "quantiles_malformed",
          detail: `quantiles contains a non-numeric cell ${JSON.stringify(cell)}`,
        });
      }
      nums.push(n);
    }
    rows.push(nums);
  }
  return rows;
}

export interface ParsePfdsDepthTableOptions {
  /** Duration to extract, in hours. Default 24 — the design-storm duration. */
  durationHours?: number;
  /**
   * When supplied, the payload's own `lat`/`lon` echo must agree within 1e-3
   * degrees, so a payload for a different point can never be published as this
   * point's answer.
   */
  expectLatLng?: { lat: number; lng: number };
}

/**
 * Parse the live HDSC PFDS payload and return the requested duration's depth
 * by return period, in inches.
 *
 * REFUSES (throws {@link PfdsRefusal}) rather than returning a partial or
 * empty Map. An empty Map is not a safe answer: it is indistinguishable from
 * "this point has no Atlas 14 row", which is how the pre-G-165 parser turned
 * every unparsed payload into a regional default wearing a NOAA citation.
 */
export function parsePfdsDepthTable(
  payload: string,
  options: ParsePfdsDepthTableOptions = {},
): Map<number, number> {
  const durationHours = options.durationHours ?? DEFAULT_PFDS_DURATION_HOURS;
  const rowIndex = PFDS_DURATION_ROWS.findIndex((r) => r.minutes === durationHours * 60);
  if (rowIndex < 0) {
    refuse({
      code: "unsupported_duration",
      detail: `${durationHours} h is not one of the ${PFDS_DURATION_ROWS.length} durations this matrix publishes (${PFDS_DURATION_ROWS.map((r) => r.label).join(", ")})`,
    });
  }

  // 1. Did NOAA answer, or is there genuinely no Atlas 14 value here?
  const result = readEcho(payload, ["result"]);
  if (result === null) {
    refuse({
      code: "result_missing",
      detail: "payload carries no `result = '...'` echo, so it is not a PFDS response",
    });
  }
  if (result !== "values") {
    const errorMsg = readEcho(payload, ["ErrorMsg", "errormsg"]);
    refuse({
      code: "result_not_values",
      notCovered: true,
      errorMsg,
      detail: `NOAA returned result = '${result}' for this point${
        errorMsg ? ` (${errorMsg})` : ""
      }: there is no Atlas 14 depth to read here`,
    });
  }

  // 2. Does the payload declare the semantics these numbers must have?
  const semantics: ReadonlyArray<[ReadonlyArray<string>, string]> = [
    [["type"], "pf"],
    [["datatype"], "depth"],
    [["unit", "units"], "english"],
    [["ser", "series"], "pds"],
  ];
  for (const [keys, expected] of semantics) {
    const got = readEcho(payload, keys);
    if (got === null) {
      refuse({
        code: "echo_missing",
        detail: `payload echoes no \`${keys[0]} = '...'\`, so the numbers' meaning (${expected}) is undeclared`,
      });
    }
    if (got !== expected) {
      refuse({
        code: "echo_mismatch",
        detail: `payload echoes \`${keys[0]} = '${got}'\` but this parser publishes ${expected}`,
      });
    }
  }

  // 3. Is it this point's payload?
  if (options.expectLatLng) {
    const latStr = readEcho(payload, ["lat"]);
    const lonStr = readEcho(payload, ["lon", "lng"]);
    if (latStr === null || lonStr === null) {
      refuse({
        code: "location_mismatch",
        detail: "payload echoes no lat/lon, so it cannot be tied to the requested point",
      });
    }
    const lat = Number(latStr);
    const lon = Number(lonStr);
    const tolerance = 1e-3;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat - options.expectLatLng.lat) > tolerance ||
      Math.abs(lon - options.expectLatLng.lng) > tolerance
    ) {
      refuse({
        code: "location_mismatch",
        detail: `payload is for (${latStr}, ${lonStr}) but (${options.expectLatLng.lat}, ${options.expectLatLng.lng}) was requested`,
      });
    }
  }

  // 4. The matrix, its shape, and the two laws that give the axes their meaning.
  const rows = readQuantilesMatrix(payload);
  if (rows.length !== PFDS_DURATION_ROWS.length) {
    refuse({
      code: "matrix_shape",
      detail: `quantiles has ${rows.length} duration rows; this parser reads a ${PFDS_DURATION_ROWS.length}-row matrix (rows are positional durations with no labels in the payload)`,
    });
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.length !== PFDS_RETURN_PERIOD_COLUMNS.length) {
      refuse({
        code: "matrix_shape",
        detail: `quantiles row ${i} (${PFDS_DURATION_ROWS[i]!.label}) has ${row.length} values; expected ${PFDS_RETURN_PERIOD_COLUMNS.length}`,
      });
    }
    // Law 1: within a duration, depth rises with the return period.
    for (let j = 0; j + 1 < row.length; j += 1) {
      if (!(row[j]! < row[j + 1]!)) {
        refuse({
          code: "return_period_not_increasing",
          detail: `row ${i} (${PFDS_DURATION_ROWS[i]!.label}) does not rise with the return period: ${row[j]!} in at ${PFDS_RETURN_PERIOD_COLUMNS[j]}-yr, then ${row[j + 1]!} in at ${PFDS_RETURN_PERIOD_COLUMNS[j + 1]}-yr`,
        });
      }
    }
  }
  // Law 2: within a return period, depth rises with the duration. This is the
  // law that catches a same-length reordering of the unlabeled rows — the one
  // class of corruption a shape check alone cannot see.
  for (let j = 0; j < PFDS_RETURN_PERIOD_COLUMNS.length; j += 1) {
    for (let i = 0; i + 1 < rows.length; i += 1) {
      const shorter = rows[i]![j]!;
      const longer = rows[i + 1]![j]!;
      if (!(shorter < longer)) {
        refuse({
          code: "duration_not_increasing",
          detail: `at the ${PFDS_RETURN_PERIOD_COLUMNS[j]}-yr return period the ${PFDS_DURATION_ROWS[i + 1]!.label} depth (${longer} in) is not above the ${PFDS_DURATION_ROWS[i]!.label} depth (${shorter} in)`,
        });
      }
    }
  }

  const row = rows[rowIndex]!;
  const out = new Map<number, number>();
  for (let j = 0; j < PFDS_RETURN_PERIOD_COLUMNS.length; j += 1) {
    out.set(PFDS_RETURN_PERIOD_COLUMNS[j]!, row[j]!);
  }
  return out;
}

export function buildPfdsUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    type: "pf",
    data: "depth",
    units: "english",
    series: "pds",
  });
  return `https://hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py?${params.toString()}`;
}

export interface FetchNoaaAtlas14Args {
  lat: number;
  lng: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch design-storm depths for a parcel centroid.
 *
 * G-165: this used to swallow every failure — `catch { designStorms = [] }` —
 * and return a `source: "noaa-atlas-14-pfds"` object carrying NO storms, which
 * forced every caller to invent a depth while keeping the NOAA attribution.
 * It now REFUSES: a transport failure, a non-200, an absent Atlas 14 value for
 * the point, and an unparseable payload are each a typed {@link PfdsRefusal}
 * with its own `code`. Callers that want a documented default must catch it and
 * name the fallback on the read; callers must not be handed a NOAA-sourced
 * object with no NOAA numbers in it.
 */
export async function fetchNoaaAtlas14PointEstimate(
  args: FetchNoaaAtlas14Args,
): Promise<NoaaAtlas14PointEstimate> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const endpoint = buildPfdsUrl(args.lat, args.lng);

  const res = await fetchImpl(endpoint, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(15_000),
  }).catch((err: unknown) => {
    refuse({
      code: "transport_error",
      detail: `fetch of ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
  if (!res.ok) {
    refuse({
      code: "http_status",
      detail: `HDSC returned HTTP ${res.status} for ${endpoint}`,
    });
  }
  const payload = await res.text().catch((err: unknown) => {
    refuse({
      code: "transport_error",
      detail: `reading the HDSC body failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });

  const parsed = parsePfdsDepthTable(payload, {
    durationHours: DURATION_HOURS,
    expectLatLng: { lat: args.lat, lng: args.lng },
  });

  const designStorms: NoaaAtlas14DesignStorm[] = [];
  for (const rp of RETURN_PERIODS) {
    const depth = parsed.get(rp);
    if (typeof depth !== "number") {
      refuse({
        code: "matrix_shape",
        detail: `parsed matrix carries no ${rp}-yr column`,
      });
    }
    designStorms.push({
      returnPeriodYears: rp,
      durationHours: DURATION_HOURS,
      depthInches: depth,
    });
  }

  return {
    lat: args.lat,
    lng: args.lng,
    source: "noaa-atlas-14-pfds",
    fetchedAt: new Date().toISOString(),
    designStorms,
    endpoint,
  };
}

/** Convert inches to millimeters for the hydrology worker. */
export function inchesToMm(inches: number): number {
  return inches * 25.4;
}
