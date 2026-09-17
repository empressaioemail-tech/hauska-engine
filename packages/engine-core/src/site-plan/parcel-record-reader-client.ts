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
// store when the client is absent OR when a fetch fails.
//
// P-219 CORRECTION (2026-09-15). This block used to read: "`RETRIEVAL_API_URL`/
// `RETRIEVAL_API_KEY` are NOT mounted on hauska-engine-api today (confirmed
// live via `gcloud run services describe hauska-engine-api`, 2026-09-12) --
// this client is dormant in production until that secret mount lands." That is
// no longer true, and the stale note was load-bearing: it read as a standing
// reason not to route anything else through this client, and P-219 nearly
// treated a secret mount as its own operator STOP gate on the strength of it.
// Verified at source 2026-09-15 with `gcloud run services describe
// hauska-engine-api --project hauska-prod-497015 --region us-central1` on
// serving revision hauska-engine-api-00224-joq: the service carries
// RETRIEVAL_API_URL as a literal (https://hauska-retrieval-api-...) and
// RETRIEVAL_API_KEY from the HAUSKA_ENGINE_API_KEY secret. The client is LIVE
// in production and no secret mount is owed. Re-verify at source before
// relying on this note in turn -- that is the lesson the old one taught.

/**
 * P-302. The four code tokens the wire's `refusal.code` can carry, mirrored
 * VERBATIM from the server side (`services/retrieval-api/src/parcel-record-reader.ts`'s
 * `CellServeRefusalCode`, itself pinned by the cross-repo fixture
 * `services/retrieval-api/src/__fixtures__/cell-serve-rule.json`). A consumer
 * that named the same refusal two different ways could not be held to that
 * fixture, which is the whole reason the codes are tokens rather than prose.
 * LDT's fifth code, `store-not-configured`, is a TRANSPORT refusal and never
 * reaches a rail, so it is deliberately not mirrored here.
 */
export type ParcelRecordRefusalCode =
  | "engine-refused"
  | "unaccounted"
  | "malformed-cell"
  | "no-such-parcel-or-rail";

/** The refusal a slated rail declares. Non-null exactly when `serve === "refused"`. */
export interface ParcelRecordServeRefusal {
  code: ParcelRecordRefusalCode;
  reason: string;
}

export interface ParcelRecordRail {
  cell: Record<string, unknown> | null;
  gate: { verdict: "pass" | "refuse" | "excluded" | null; evaluatedAt: string | null };
  serve: "record" | "refused" | "legacy-transitional";
  /**
   * P-302. P-297's additive wire field: the code and the reason a slated rail's
   * own cell state produced, non-null exactly when `serve === "refused"`. It
   * exists because the ruling requires a declared refusal to CARRY its reason
   * and a missing or malformed cell has no cell object to carry one. Mirrored
   * here so the reason is not thrown away one line after it arrives — before
   * this lane the client read `serve` and discarded this.
   *
   * Typed as required-and-nullable to mirror the wire exactly. Read
   * DEFENSIVELY anyway (`asServeRefusal`): the response body is cast, never
   * validated, so a response from a pre-P-297 serving build legitimately has
   * the field absent at runtime while this type says it is there.
   */
  refusal: ParcelRecordServeRefusal | null;
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

/* ─────────────────── P-302: the three-way answer, and why ───────────────────
 *
 * OPS-24 law 7, operator ruling A-193
 * (`_decisions/2026-09-16_county_verdict_is_not_the_serve_switch.md`): on a
 * SLATED rail each parcel is served from its OWN cell, and the legacy or baked
 * value is never the answer. Concretely, for every rail this client reads:
 *
 *   | the rail's own answer                                    | reported as        |
 *   |----------------------------------------------------------|--------------------|
 *   | serve `record`, cell `value`                              | the value          |
 *   | serve `record`, cell `absent-verified`                     | the stated absence |
 *   | serve `record`, cell `not-applicable`                      | the stated absence |
 *   | serve `refused` (a `refused`/`unaccounted` cell, no cell,  | a declared refusal,|
 *   |  a cell this reader cannot read, or a `value` cell whose   | with its code and  |
 *   |  payload does not coerce into this rail's own domain)      | its reason         |
 *   | serve `legacy-transitional` (UNSLATED)                     | the pre-cutover    |
 *   |                                                            | path, untouched    |
 *
 * THE FIXTURE IS THE CONTRACT, NOT THIS FILE. `services/retrieval-api/src/__fixtures__/cell-serve-rule.json`
 * is the cross-repo contract P-297 landed (both readers consume the same rows);
 * this client CONSUMES that decision rather than re-deriving it. It never
 * decides from `cell.kind` alone, because a missing, malformed or unreadable
 * cell has no kind and still refuses — the refusal, not the kind, is what the
 * response states.
 *
 * WHY A TYPED ANSWER AND NOT `undefined`. Every helper here used to return
 * `undefined` for every non-`value` cell. `undefined` is indistinguishable from
 * "this rail is unslated", so every caller's `?? cadRoll?.<field>` (and
 * `resolve-export-setback`'s fall-through to the ruled corpus row) could not
 * tell a declared refusal from a rail that was never cut over, and printed the
 * baked value for both. That is the shape A-193 retires. A caller must not be
 * able to mistake "refused" for "nothing here", which is why the four cases are
 * a discriminated union and not a nullable value.
 *
 * THE LEGACY HELPERS ARE KEPT, and are now thin wrappers over these answers, so
 * there is exactly ONE kind-switch in this file rather than two that could
 * drift. Their external behaviour is unchanged (each still returns `undefined`
 * for a non-value cell), which is what keeps their existing callers and tests
 * honest rather than re-pointed.
 */

export type RecordRailAbsenceVerdict = "absent-verified" | "not-applicable";

/**
 * The refusal codes a caller can see. The first four are the wire's own
 * (`ParcelRecordRefusalCode`). `refusal-detail-missing` is this client's ONLY
 * code that cannot come off the wire: it is what a `serve === "refused"` with
 * no `refusal` object reports — a pre-P-297 serving build, or a truncated body.
 * Inventing one of the wire's four codes for that case would attribute a
 * finding to the store it never made, and falling back would be the defect.
 */
export type RecordRailRefusalCode = ParcelRecordRefusalCode | "refusal-detail-missing";

/** What one rail answered. `current-path` is the unslated rail: the caller's existing path runs untouched. */
export type RecordRailAnswer<T> =
  | { form: "value"; value: T }
  | { form: "absence"; absenceVerdict: RecordRailAbsenceVerdict; reason: string | null }
  | { form: "refusal"; code: RecordRailRefusalCode; reason: string }
  | { form: "current-path" };

export interface RecordRailRefusalEntry {
  /** The rail key as the wire spells it (e.g. `marketValue`, `setbackFrontFt`). */
  rail: string;
  code: RecordRailRefusalCode;
  reason: string;
}

function asServeRefusal(value: unknown): ParcelRecordServeRefusal | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const code = asNullableString(rec.code);
  const reason = asNullableString(rec.reason);
  if (!code || !reason) return null;
  return { code: code as ParcelRecordRefusalCode, reason };
}

/** A short, non-explosive rendering of a raw payload for a refusal's reason. */
function payloadSnippet(value: unknown, max = 120): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The rail's own words for a stated absence: `basis.finding` (the shape
 * `absent-verified` cells carry in production and in the shared fixture), then
 * the cell's own `reason` (the shape `not-applicable` cells carry). Null when
 * the cell stated the absence without saying why — reported as a stated absence
 * with no reason rather than filled in with engine prose.
 */
function statedAbsenceReason(cell: Record<string, unknown>): string | null {
  const basis = asRecord(cell.basis);
  return (basis ? asNullableString(basis.finding) : null) ?? asNullableString(cell.reason);
}

/**
 * THE RULE, once, for every rail in this file.
 *
 * `readValueFromCell` is called ONLY for a `value` cell and returns `undefined`
 * when the cell's payload does not coerce into this rail's own domain — which
 * the shared fixture names as a declared refusal (its `_notCoveredHere`), not a
 * silent nothing. For a companion rail (rows live on `companions`) an empty row
 * set is a legitimate VALUE, so those readers return `[]`, never `undefined`.
 */
export function recordRailAnswer<T>(
  rail: ParcelRecordRail | undefined,
  readValueFromCell: (rail: ParcelRecordRail) => T | undefined,
): RecordRailAnswer<T> {
  // Unslated: byte-identically the pre-cutover path. NOT a refusal, and not a
  // value — the caller's existing source (including the substrate) still runs.
  if (!rail || rail.serve === "legacy-transitional") return { form: "current-path" };

  if (rail.serve === "refused") {
    const refusal = asServeRefusal(rail.refusal);
    return refusal
      ? { form: "refusal", code: refusal.code, reason: refusal.reason }
      : {
          form: "refusal",
          code: "refusal-detail-missing",
          reason:
            "The parcel ledger refused this rail for this parcel but the response carried no refusal " +
            "detail. Refusing rather than serving the legacy or baked value, and rather than naming a " +
            "reason the store did not give.",
        };
  }

  // serve === "record": the cell IS the answer, whichever of the three forms it takes.
  const cell = rail.cell;
  if (!cell) {
    return {
      form: "refusal",
      code: "no-such-parcel-or-rail",
      reason:
        "The parcel ledger served this rail with no cell. The store's silence about a rail that is " +
        "supposed to be served from it is not evidence about the parcel.",
    };
  }

  const kind = asNullableString(cell.kind);
  if (kind === "absent-verified" || kind === "not-applicable") {
    return { form: "absence", absenceVerdict: kind, reason: statedAbsenceReason(cell) };
  }
  if (kind !== "value") {
    return {
      form: "refusal",
      code: "malformed-cell",
      reason:
        `The parcel ledger's cell carries kind ${JSON.stringify(kind)}, which this reader does not ` +
        "recognise. Refusing rather than guessing.",
    };
  }

  const value = readValueFromCell(rail);
  if (value === undefined) {
    return {
      form: "refusal",
      code: "engine-refused",
      reason:
        `The parcel ledger's cell for this rail is a value but carries nothing this rail can use ` +
        `(raw payload ${payloadSnippet(cell.value)}). Refusing rather than serving the legacy or baked value.`,
    };
  }
  return { form: "value", value };
}

/**
 * The ONE place a caller turns an answer into a field, and therefore the ONE
 * place the retired fallback could be reintroduced: a slated rail's absence or
 * refusal yields nothing, and the substrate value is returned ONLY when the
 * rail is unslated (`current-path`). Any other reading of this function is the
 * defect this lane exists to remove, which is why it is a named export with a
 * mutation as its own falsifier.
 */
export function recordRailField<T>(answer: RecordRailAnswer<T>, substrateValue: T | undefined): T | undefined {
  if (answer.form === "value") return answer.value;
  if (answer.form === "current-path") return substrateValue;
  return undefined;
}

/** Every refusal among `entries`, in the order given, for a caller's reason text and `ledgerRefusals`. */
export function recordRailRefusals(
  entries: ReadonlyArray<readonly [string, RecordRailAnswer<unknown>]>,
): RecordRailRefusalEntry[] {
  const out: RecordRailRefusalEntry[] = [];
  for (const [rail, answer] of entries) {
    if (answer.form === "refusal") out.push({ rail, code: answer.code, reason: answer.reason });
  }
  return out;
}

/**
 * The customer-facing one-liner for a set of refusals. Names the rails, each
 * one's code and the store's own reason, then states plainly that nothing was
 * substituted — because a refusal a reader cannot see is indistinguishable from
 * an omission, and an omission is what the ruling forbids.
 */
export function recordRailRefusalReason(entries: ReadonlyArray<RecordRailRefusalEntry>): string {
  const parts = entries.map((e) => `${e.rail} (${e.code}): ${e.reason}`);
  return (
    `The parcel ledger declared a refusal for this parcel — ${parts.join(" ")} ` +
    "The legacy or baked value is not shown in its place."
  );
}

/** Read one scalar rail's cell value, gated strictly on `serve === "record"`. Vendored kind-switch, matching hauska-map's `interpretRecordCell` / legacy-design-tools' `interpretParcelRecordCell` (same cell_state shape, same falsifier: byte-for-byte parity is not claimed here since this is a NEW report-path consumer, but the KIND switch itself must not diverge). Kept for its existing callers; the kind-switch it used to own now lives once, in `recordRailAnswer`. */
export function recordScalarValue(rail: ParcelRecordRail | undefined): string | number | boolean | null | undefined {
  const answer = recordScalarValueAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/** The raw primitive a `value` cell carries, or `undefined` when this rail cannot use it. */
function rawScalarValue(rail: ParcelRecordRail): string | number | boolean | null | undefined {
  const v = rail.cell?.value;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : undefined;
}

/** P-302: the three-way answer for a plain scalar rail. */
export function recordScalarValueAnswer(
  rail: ParcelRecordRail | undefined,
): RecordRailAnswer<string | number | boolean | null> {
  return recordRailAnswer(rail, rawScalarValue);
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
  const answer = recordScalarNumberAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/** The numeric reading of a `value` cell, or `undefined` when the payload names no number. */
function rawScalarNumber(rail: ParcelRecordRail): number | undefined {
  const v = rawScalarValue(rail);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(/^\$/, "").replace(/,/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** P-302: the three-way answer for a numeric rail. A `value` cell whose payload names no number is a declared refusal (`engine-refused`), never a silent nothing. */
export function recordScalarNumberAnswer(rail: ParcelRecordRail | undefined): RecordRailAnswer<number> {
  return recordRailAnswer(rail, rawScalarNumber);
}

export function recordScalarString(rail: ParcelRecordRail | undefined): string | undefined {
  const answer = recordScalarStringAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/** P-302: the three-way answer for a text rail. */
export function recordScalarStringAnswer(rail: ParcelRecordRail | undefined): RecordRailAnswer<string> {
  return recordRailAnswer(rail, (r) => asNullableString(rawScalarValue(r)) ?? undefined);
}

export type RecordCityLimitsDisposition = {
  status: "incorporated" | "unincorporated";
  cityName?: string;
  source: string;
  vintage?: string;
};

/** cityLimits' basis shape carries `disposition`, not `finding` (matches hauska-map's composeCityLimits). */
export function recordCityLimitsDisposition(
  rail: ParcelRecordRail | undefined,
): RecordCityLimitsDisposition | undefined {
  const answer = recordCityLimitsAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/** The place a `value` cell names, or `undefined` when it names none (which P-302 reports as a refusal, not as silence). */
function rawCityLimitsDisposition(rail: ParcelRecordRail): RecordCityLimitsDisposition | undefined {
  const cell = rail.cell!;
  const cityName = asNullableString(cell.value);
  if (!cityName) return undefined;
  return {
    status: "incorporated",
    cityName,
    source: asNullableString(cell.source) ?? "parcel_record",
    vintage: asNullableString(cell.vintage) ?? undefined,
  };
}

/**
 * P-302: cityLimits has one cell kind that is a POSITIVE answer rather than an
 * absence. `absent-verified` literally asserts "verified: this parcel is not in
 * a city" — that IS the rail's answer to the city-limits question, and it has
 * always composed as `unincorporated`. It is therefore promoted to the value
 * arm, unchanged: reading a verified not-in-a-city as `unincorporated` is not a
 * substitution, which is why the promotion is here and not in the rule.
 * Everything else non-`value` keeps its own meaning: `not-applicable` a stated
 * absence, a refusal a refusal.
 */
export function recordCityLimitsAnswer(
  rail: ParcelRecordRail | undefined,
): RecordRailAnswer<RecordCityLimitsDisposition> {
  const answer = recordRailAnswer(rail, rawCityLimitsDisposition);
  if (answer.form === "absence" && answer.absenceVerdict === "absent-verified" && rail?.cell) {
    const basis = asRecord(rail.cell.basis);
    return {
      form: "value",
      value: {
        status: "unincorporated",
        source: (basis && asNullableString(basis.source)) ?? "parcel_record",
      },
    };
  }
  return answer;
}

/** The rail's companion rows, or an empty list — a non-array `companions` is no rows, never a crash. */
function asCompanionRows(rail: ParcelRecordRail): Array<{ payload?: unknown }> {
  const rows = rail.companions as Array<{ payload?: unknown }> | undefined;
  return Array.isArray(rows) ? rows : [];
}

/** The district names a `value` cell carries on its companion rows. An empty row set is `[]` — the rail's answer of "none", not a failure to answer. */
function rawSpecialDistrictNames(rail: ParcelRecordRail): string[] {
  return asCompanionRows(rail)
    .map((row) => {
      const rec = asRecord(row.payload);
      return rec ? asNullableString(rec.districtName) : null;
    })
    .filter((n): n is string => n !== null);
}

/** specialDistricts is a companion rail (grain "companion") — district rows live on `companions`, not the cell_state itself (matches hauska-map's composeSpecialDistricts). */
export function recordSpecialDistrictNames(rail: ParcelRecordRail | undefined): string[] | undefined {
  const answer = recordSpecialDistrictNamesAnswer(rail);
  return answer.form === "value" && answer.value.length > 0 ? answer.value : undefined;
}

/** P-302: the three-way answer for the special-districts rail. */
export function recordSpecialDistrictNamesAnswer(
  rail: ParcelRecordRail | undefined,
): RecordRailAnswer<string[]> {
  return recordRailAnswer(rail, rawSpecialDistrictNames);
}

/**
 * P-222 D7. `utilityService`'s cell value carries the whole per-service-type
 * answer as one object (water/sewer/electric, each null or a CCN record) —
 * unlike the scalar cad rails, this rail's grain is "value is a small typed
 * object", so it is read directly off `cell.value` rather than through
 * `recordScalarValue`'s string/number/boolean gate. Returns `undefined` on
 * any shape this function does not recognize (fails closed to the caller's
 * existing HIFLD-only fallback — never a guessed CCN).
 */
export interface RecordUtilityHolder {
  ccnNo: string;
  utility: string;
  status?: string;
  ccnType?: string;
}
export interface RecordUtilityService {
  water: RecordUtilityHolder | null;
  sewer: RecordUtilityHolder | null;
  electric: RecordUtilityHolder | null;
}
/** `undefined` means "this one holder's own record is malformed" — treated
 * as uncovered for JUST that service, never discarding valid siblings
 * (a malformed sewer record must not cost the parcel its valid water and
 * electric CCN holders). */
function asUtilityHolder(value: unknown): RecordUtilityHolder | null | undefined {
  if (value === null) return null;
  const rec = asRecord(value);
  if (!rec) return undefined;
  const ccnNo = asNullableString(rec.ccnNo);
  const utility = asNullableString(rec.utility);
  if (!ccnNo || !utility) return undefined;
  return {
    ccnNo,
    utility,
    ...(asNullableString(rec.status) ? { status: asNullableString(rec.status)! } : {}),
    ...(asNullableString(rec.ccnType) ? { ccnType: asNullableString(rec.ccnType)! } : {}),
  };
}
export function recordUtilityService(rail: ParcelRecordRail | undefined): RecordUtilityService | undefined {
  const answer = recordUtilityServiceAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/**
 * A malformed individual holder reads as "no holder on file" for that ONE
 * service (== null), never as "the whole rail is unusable" — see
 * asUtilityHolder's own doc. A `cell.value` that is not an object at all is the
 * rail failing to answer, which P-302 reports as a refusal.
 */
function rawUtilityService(rail: ParcelRecordRail): RecordUtilityService | undefined {
  const value = asRecord(rail.cell?.value);
  if (!value) return undefined;
  const asHolderOrNull = (v: unknown) => asUtilityHolder(v) ?? null;
  return {
    water: asHolderOrNull(value.water),
    sewer: asHolderOrNull(value.sewer),
    electric: asHolderOrNull(value.electric),
  };
}

/** P-302: the three-way answer for the utility-service rail. */
export function recordUtilityServiceAnswer(
  rail: ParcelRecordRail | undefined,
): RecordRailAnswer<RecordUtilityService> {
  return recordRailAnswer(rail, rawUtilityService);
}

/**
 * P-222 D8. `overlayDistricts` is a companion rail (same grain as
 * specialDistricts): district rows live on `companions`, each payload
 * carrying the city and the ordinance's own attribute bag (`CD_Name`,
 * `CD_Desc`, `CD_DevelopmentPatterns`, …). Reads defensively — an attribute
 * this function does not recognize is simply omitted, never fabricated.
 */
export interface RecordOverlayDistrict {
  name: string;
  cityName?: string;
  description?: string;
  developmentPattern?: string;
}
/**
 * Distinguishes "never checked" from "checked, genuinely zero districts" —
 * collapsing them was the exact D5 defect this program names explicitly.
 * `checked` mirrors `recordCityLimitsDisposition`'s own `kind ===
 * "absent-verified"` branch: a rail can serve "record" and confirm an
 * absence without ever reaching `kind: "value"`.
 */
export interface RecordOverlayDistrictsResult {
  districts: RecordOverlayDistrict[];
  /** True when the rail ran and confirmed the answer (present or verified
   * zero); false when nothing ever checked. */
  checked: boolean;
}
export function recordOverlayDistricts(rail: ParcelRecordRail | undefined): RecordOverlayDistrictsResult | undefined {
  const answer = recordOverlayDistrictsAnswer(rail);
  return answer.form === "value" ? { districts: answer.value, checked: true } : undefined;
}

/** The overlay districts a `value` cell carries on its companion rows. An empty row set is `[]` — a checked, genuinely-zero answer, not a failure to answer. */
function rawOverlayDistricts(rail: ParcelRecordRail): RecordOverlayDistrict[] {
  return asCompanionRows(rail)
    .map((row): RecordOverlayDistrict | null => {
      const payload = asRecord(row.payload);
      if (!payload) return null;
      const attrs = asRecord(payload.attributes) ?? payload;
      const name = asNullableString(attrs.overlayName) ?? asNullableString(attrs.CD_Name);
      if (!name) return null;
      return {
        name,
        ...(asNullableString(payload.city) ? { cityName: asNullableString(payload.city)! } : {}),
        ...(asNullableString(attrs.CD_Desc) ? { description: asNullableString(attrs.CD_Desc)! } : {}),
        ...(asNullableString(attrs.CD_DevelopmentPatterns)
          ? { developmentPattern: asNullableString(attrs.CD_DevelopmentPatterns)! }
          : {}),
      };
    })
    .filter((d): d is RecordOverlayDistrict => d !== null);
}

/** P-302: the three-way answer for the overlay-districts rail. A stated absence (`absent-verified`) is an absence here, which is what keeps it distinct from the `blocked-at-source` a rail that never ran earns. */
export function recordOverlayDistrictsAnswer(
  rail: ParcelRecordRail | undefined,
): RecordRailAnswer<RecordOverlayDistrict[]> {
  return recordRailAnswer(rail, rawOverlayDistricts);
}

/**
 * P-222 D11. `parcelAreaSqFt` is a scalar rail (same grain as the cad
 * scalars) carrying the reader's own `ST_Area(geography)`-derived area —
 * read via the existing scalar-number path, never re-implemented.
 */
export function recordParcelAreaSqFt(rail: ParcelRecordRail | undefined): number | undefined {
  const answer = recordParcelAreaSqFtAnswer(rail);
  return answer.form === "value" ? answer.value : undefined;
}

/** P-302: the three-way answer for the parcel-area rail — the same scalar-number path, never re-implemented. */
export function recordParcelAreaSqFtAnswer(rail: ParcelRecordRail | undefined): RecordRailAnswer<number> {
  return recordRailAnswer(rail, rawScalarNumber);
}
