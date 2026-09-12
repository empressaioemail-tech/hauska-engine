// packages/engine-core/src/site-plan/parcel-record-reader-client.ts
//
// P152-RAILS (OPS-23 P-152 lane 3): the feasibility report composer's own
// client for `GET /property-nodes/:id/record` on the SAME retrieval service
// hauska-map's BFF already calls (P152-PANEL/P152-READER, PR #417/418/419) —
// the one reader (R-6). This is the FIRST time engine-api has called the
// reader; before this lane, `composeParcelReportFacts` read only its own
// substrate Postgres atoms plus four live layers (confirmed by grep against
// `_inbox/2026-09-12_ops23_wave3_verify_p152_lane3.md`'s own base commit).
//
// Mirrors `narrativeSectionFromEnv` (parcel-terrain.ts) exactly: a factory
// function reads env, returns `undefined` when unconfigured, and the report
// NEVER fails or degrades for want of it — every composer that consumes this
// client falls back to whatever it already read from the substrate atoms
// store when the client is absent OR when a fetch fails. `RETRIEVAL_API_URL`/
// `RETRIEVAL_API_KEY` are NOT mounted on hauska-engine-api today (confirmed
// live via `gcloud run services describe hauska-engine-api`, 2026-09-12) —
// this client is dormant in production until that secret mount lands. See
// this lane's close for the exact mount command; mounting a new secret onto
// a production Cloud Run service is this program's own named STOP gate
// (P152-READER close operatorApprovals, "Secret mount ... approved
// explicitly before running it") — not done unreviewed by this lane.

export interface ParcelRecordRail {
  cell: Record<string, unknown> | null;
  gate: { verdict: "pass" | "refuse" | "excluded" | null; evaluatedAt: string | null };
  serve: "record" | "refused" | "legacy-transitional";
  atom: { did: string; entityType: string; body: unknown } | null;
  atomBacked: boolean;
  rendering: { text: string; atomVersion: string; vocabVersion: string } | null;
  companions: unknown[];
}

export interface ParcelRecordResponse {
  parcelNodeId: string;
  placeKey: string | null;
  countyFips: string;
  railRegistrySha: string;
  readAt: string;
  rails: Record<string, ParcelRecordRail>;
  refused: { reason: string } | null;
}

export interface RecordReaderClient {
  fetchRecord(
    parcelNodeId: string,
  ): Promise<{ ok: true; record: ParcelRecordResponse } | { ok: false; reason: string }>;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

class HttpRecordReaderClient implements RecordReaderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async fetchRecord(
    parcelNodeId: string,
  ): Promise<{ ok: true; record: ParcelRecordResponse } | { ok: false; reason: string }> {
    const url = `${this.baseUrl}/property-nodes/${encodeURIComponent(parcelNodeId)}/record`;
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return { ok: false, reason: `record aborted after ${this.timeoutMs}ms upstream timeout` };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!upstream.ok) {
      return { ok: false, reason: `record HTTP ${upstream.status}` };
    }
    let body: unknown;
    try {
      body = await upstream.json();
    } catch {
      return { ok: false, reason: "record invalid JSON" };
    }
    return { ok: true, record: body as ParcelRecordResponse };
  }
}

/**
 * `RETRIEVAL_API_URL`/`RETRIEVAL_API_KEY` — the SAME names hauska-map's
 * `pe-property-atoms.ts` (`retrievalConfig`) and legacy-design-tools' fixed
 * client (P152-READER close, F-P152-4) both check, so one secret mount
 * serves every consumer. Returns `undefined` unless both are set.
 */
export function recordReaderFromEnv(env: NodeJS.ProcessEnv = process.env): RecordReaderClient | undefined {
  const baseUrl = (env.RETRIEVAL_API_URL ?? env.HAUSKA_RETRIEVAL_API_URL)?.trim();
  const apiKey = (env.RETRIEVAL_API_KEY ?? env.HAUSKA_RETRIEVAL_API_KEY)?.trim();
  if (!baseUrl || !apiKey) return undefined;
  const timeoutRaw = Number(env.PARCEL_RECORD_READER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_UPSTREAM_TIMEOUT_MS;
  return new HttpRecordReaderClient(baseUrl.replace(/\/$/, ""), apiKey, timeoutMs);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read one scalar rail's cell value, gated strictly on `serve === "record"`. Vendored kind-switch, matching hauska-map's `interpretRecordCell` / legacy-design-tools' `interpretParcelRecordCell` (same cell_state shape, same falsifier: byte-for-byte parity is not claimed here since this is a NEW report-path consumer, but the KIND switch itself must not diverge). */
export function recordScalarValue(rail: ParcelRecordRail | undefined): string | number | boolean | null | undefined {
  if (!rail || rail.serve !== "record" || !rail.cell) return undefined;
  const cell = rail.cell;
  const kind = asNullableString(cell.kind);
  if (kind !== "value") return undefined; // absent-verified/refused/etc: no value to compose, caller keeps its existing fallback
  const v = cell.value;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
}

/**
 * P152-RAILS follow-up (2026-09-12, live finding): yearBuilt/livingAreaSqft
 * composed correctly from the reader on the first live check, but
 * marketValue/assessedValue did not, even though the planner's own direct
 * curl of the SAME /record response showed both present with serve:record.
 * All six of these rails share the identical "scalar"/"cad" registry grain
 * (parcel-record-rail-registry.ts) and this composer's identical call
 * pattern (`recordScalarNumber(record?.rails.<key>)`) — the only
 * remaining explanation consistent with "some scalar cad rails work, others
 * with the identical shape don't" is that this composer was too strict
 * about the PRIMITIVE TYPE of `cell.value`, not about anything structural.
 * `parcel-record-db.ts` (this repo) reads `cell_state` "verbatim" from a
 * jsonb column with zero transformation, so whatever primitive the
 * factory's landing payload originally carried for a dollar amount is what
 * ships here — and dollar amounts, unlike a plain integer yearBuilt or
 * livingAreaSqft, are exactly the class of CAD source field that commonly
 * arrives (or gets stored, e.g. a Postgres NUMERIC column serialized by a
 * driver) as a numeric STRING rather than a JSON number. `recordScalarValue`
 * already treats a string as a legitimate primitive (matching hauska-map's
 * own `asNullableStringOrNumber` precedent for CAD source columns "not
 * coerced by the writer"); this function was the one link in the chain that
 * only accepted `typeof v === "number"`, silently discarding a genuine
 * numeric string instead of composing it. Coerces here, once, rather than
 * asking every future caller to remember to do it — never invents a number
 * from a non-numeric string (an empty/garbage string still refuses).
 */
export function recordScalarNumber(rail: ParcelRecordRail | undefined): number | undefined {
  const v = recordScalarValue(rail);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(/^\$/, "").replace(/,/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function recordScalarString(rail: ParcelRecordRail | undefined): string | undefined {
  const v = recordScalarValue(rail);
  return asNullableString(v) ?? undefined;
}

/** cityLimits' basis shape carries `disposition`, not `finding` (matches hauska-map's composeCityLimits). */
export function recordCityLimitsDisposition(
  rail: ParcelRecordRail | undefined,
): { status: "incorporated" | "unincorporated"; cityName?: string; source: string; vintage?: string } | undefined {
  if (!rail || rail.serve !== "record" || !rail.cell) return undefined;
  const cell = rail.cell;
  const kind = asNullableString(cell.kind);
  if (kind === "value") {
    const cityName = asNullableString(cell.value);
    if (!cityName) return undefined;
    return {
      status: "incorporated",
      cityName,
      source: asNullableString(cell.source) ?? "parcel_record",
      vintage: asNullableString(cell.vintage) ?? undefined,
    };
  }
  if (kind === "absent-verified") {
    const basis = asRecord(cell.basis);
    const disposition = basis ? asNullableString(basis.disposition) : null;
    if (disposition) {
      return { status: "unincorporated", source: (basis && asNullableString(basis.source)) ?? "parcel_record" };
    }
    return { status: "unincorporated", source: "parcel_record" };
  }
  return undefined;
}

/** specialDistricts is a companion rail (grain "companion") — district rows live on `companions`, not the cell_state itself (matches hauska-map's composeSpecialDistricts). */
export function recordSpecialDistrictNames(rail: ParcelRecordRail | undefined): string[] | undefined {
  if (!rail || rail.serve !== "record" || !rail.cell) return undefined;
  const kind = asNullableString(rail.cell.kind);
  if (kind !== "value") return undefined;
  const rows = (rail.companions as Array<{ payload?: unknown }> | undefined) ?? [];
  const names = rows
    .map((row) => {
      const rec = asRecord(row.payload);
      return rec ? asNullableString(rec.districtName) : null;
    })
    .filter((n): n is string => n !== null);
  return names.length > 0 ? names : undefined;
}
