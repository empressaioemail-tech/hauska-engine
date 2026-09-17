/**
 * P-275: a second, INDEPENDENT live reading of whether a parcel still exists, keyed by the
 * identifier namespace the county's own cadastral service actually uses.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS AT ALL
 * ---------------------------------------------------------------------------------------------
 *
 * `review-retired-parcel-nodes.mjs` decides whether a retired `parcel-node` may be reactivated by
 * corroborating it against a LIVE source. Until P-275 the only such source was Bastrop's, and the
 * remaining five counties in OPS-16 reported their candidates under a single undifferentiated
 * "still retired" bucket — which reads like a measurement and is not one. Two distinct facts were
 * being reported as one:
 *
 *   `absent`      the county's own source was asked about this id and does not have it.
 *   `unmeasured`  nobody asked. No source registered, the source was unreachable, or the id is
 *                 not a live-queryable identity in the first place (a synthetic key).
 *
 * Confusing the two is how a broken source silently becomes a county-wide "not there", and how
 * "0 candidates" reads as a clean result when nothing was actually asked. So this module is
 * deliberately shaped to make the second fact cheap and explicit: every path that cannot obtain a
 * reading returns `unmeasured` WITH A REASON, and never an empty Map.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE FIELD NAME IS A PARAMETER AND NOT A CONSTANT
 * ---------------------------------------------------------------------------------------------
 *
 * The dispatch's real question is not "does a public service exist" but "is the field it exposes in
 * the SAME identifier namespace as the node id". `parcelNodeId` is `{county_fips}:{parcelKey}`
 * (see plan-county-parcel-nodes.ts), so for a prop_id-keyed county the node id IS the txgio
 * `prop_id`. A county service that answers in the ACCOUNT namespace instead would corroborate
 * every account-keyed row and deny every map-keyed row — it would INVERT the answer, and it would
 * do so confidently. Williamson is the live example: the registry names `PropertyID` (the account),
 * and the parcel-map id is `QuickRefID` (`R000009`), so the declared field answers 0 for real node
 * ids and the correct one answers 1. Hence: the caller declares `idField`, and the namespace is
 * verified against real ids plus a fabricated negative control before anything is registered.
 *
 * ---------------------------------------------------------------------------------------------
 * REQUEST COST IS A REPORTED NUMBER, NOT AN ASSUMPTION
 * ---------------------------------------------------------------------------------------------
 *
 * The dispatch asks for politeness, caching, and a stated request count. A full-layer download
 * (what `bastrop-batch-bulk-prefetch.mjs` does) is affordable only because Bastrop's layer is
 * small; Travis (386,682 features) and Williamson (290,344) are not. So this reader batches ids
 * into `where <idField> IN (...)` chunks (default 100, well under the 2000 `maxRecordCount` the
 * public services declare), asks for no geometry, and counts every request it makes in `.requests`
 * so a run can state what it cost. One chunk error does not void the run: only the ids in the
 * failed chunk become `unmeasured`, and the reason names the chunk.
 *
 * NOTHING HERE WRITES ANYTHING. Every request is a read.
 */

/** Ids per `IN (...)` clause. 100 keeps a chunk far below the 2000-row `maxRecordCount`. */
export const DEFAULT_CHUNK_SIZE = 100;

/** Extra `resultOffset` pages allowed per chunk before a chunk is called unmeasured. */
export const MAX_PAGES_PER_CHUNK = 5;

export const LIVE_CURRENCY_UNREACHABLE = "LIVE_CURRENCY_UNREACHABLE";

/**
 * Same normalization the planner applies (`normalizeParcelKeyToken`): an all-digit key loses its
 * leading zeros so a zero-padded source row and a zero-padded node id still address one parcel.
 * Kept as a copy rather than an import because this module is loaded by plain-node CLI scripts;
 * `county-parcel-id-currency.test.mjs` asserts the two agree on every case both can express.
 */
export function normalizeLiveCurrencyId(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  return trimmed.replace(/^0+(?=\d)/, "");
}

function unreachable(message, detail = {}) {
  const err = new Error(message);
  err.code = LIVE_CURRENCY_UNREACHABLE;
  Object.assign(err, detail);
  return err;
}

/** ArcGIS `where` clauses quote with single backslash-escaped quotes; the field name is checked. */
function quoteLiteral(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Bare (unquoted) numeric literal, or null when the value is not a plain number. */
function bareNumeric(value) {
  const s = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/.test(s) ? s : null;
}

const NUMERIC_FIELD_TYPE = /^(esriFieldType(OID|SmallInteger|Integer|BigInteger|Single|Double))$/;

/**
 * Which literal form a chunk's `where` clause uses.
 *
 * `typed`  follow the layer's own declared field type — quoted for strings, bare for numerics.
 * `quoted` always single-quote. `bare` never quote (only valid where every id is numeric).
 *
 * This is not cosmetic and not paranoia. Measured 2026-09-17 against the live layers: Travis
 * `PROP_ID` (esriFieldTypeInteger) answers `ArcGIS error 400 Unable to complete operation` for
 * `PROP_ID IN ('1000025',...)` and 200 for `PROP_ID IN (1000025,...)`, while Hays `prop_id`
 * (also Integer) accepts the quoted form and Williamson `QuickRefID` (String) REQUIRES it. So the
 * type-driven form is the primary, and a chunk that fails with an ArcGIS 400 is retried in the
 * other form before its ids are called unmeasured — a layer's query dialect is a fact to be
 * discovered, not assumed.
 */
function whereLiteral(value, style) {
  if (style === "quoted") return quoteLiteral(value);
  if (style === "bare") return bareNumeric(value) ?? quoteLiteral(value);
  return null; // "typed" is resolved by typedWhere, which knows the field type
}

function typedWhere(idField, values, fieldType) {
  const numeric = NUMERIC_FIELD_TYPE.test(String(fieldType ?? ""));
  return `${idField} IN (${values
    .map((v) => (numeric ? (bareNumeric(v) ?? quoteLiteral(v)) : quoteLiteral(v)))
    .join(",")})`;
}

function buildWhere(idField, values, style, fieldType) {
  if (style === "typed") return typedWhere(idField, values, fieldType);
  return `${idField} IN (${values.map((v) => whereLiteral(v, style)).join(",")})`;
}

function alternativeStyle(error, values, fieldType) {
  if (error?.arcgisCode !== 400) return null;
  // The primary form follows the field type. The alternative is the OTHER literal form, and it
  // only exists when every id in the chunk is a plain number.
  if (!values.every((v) => bareNumeric(v) !== null)) return null;
  return NUMERIC_FIELD_TYPE.test(String(fieldType ?? "")) ? "quoted" : "bare";
}

function assertFieldName(idField) {
  if (typeof idField !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(idField)) {
    throw new Error(
      `makeArcgisIdCurrencySource: idField must be a plain identifier (got ${JSON.stringify(idField)}); ` +
        "it is interpolated into the ArcGIS where clause and must not carry SQL",
    );
  }
}

async function fetchJson(url, { fetchImpl, timeoutMs, requests }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requests.count += 1;
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res || typeof res.ok !== "boolean") {
      throw new Error(`non-Response from fetch (${typeof res})`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText ?? ""}`.trim());
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`body was not JSON (first 120 chars: ${JSON.stringify(text.slice(0, 120))})`);
    }
    if (json?.error) {
      const err = new Error(
        `ArcGIS error ${json.error.code ?? "?"}: ${json.error.message ?? "unknown"}`,
      );
      err.arcgisCode = json.error.code ?? null;
      err.arcgisExtendedCode = json.error.extendedCode ?? null;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a live-currency reader for one ArcGIS REST layer.
 *
 * Returns `async (rawIds, opts?) => Map<normalizedId, LiveReading>`, where the key is the id in the
 * caller's own (raw) spelling for convenience AND every reading is looked up by
 * `normalizeLiveCurrencyId`. The returned function carries:
 *
 *   `.requests`  number of HTTP requests made so far (read the count, do not assume it).
 *   `.describe`  { url, idField, layerName } once metadata has been read.
 *
 * Readings are `{ reading: "live" | "absent" | "unmeasured", reason? }`. An id that appears in
 * `rawIds` but not in the returned Map is `unmeasured` — the caller's `readLiveCurrency` treats a
 * missing entry that way, so a partial result degrades honestly instead of reading as "absent".
 *
 * Throws `LIVE_CURRENCY_UNREACHABLE` only when the layer itself could not be read at all (metadata
 * probe failed: DNS, TLS, HTTP, non-JSON, ArcGIS `error`, or the declared field is not on the
 * layer). A whole-layer throw is the caller's signal to mark EVERY candidate unmeasured.
 */
export function makeArcgisIdCurrencySource({
  url,
  idField,
  chunkSize = DEFAULT_CHUNK_SIZE,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  maxRecordCount = 2000,
} = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new Error(`makeArcgisIdCurrencySource: url must be http(s); got ${JSON.stringify(url)}`);
  }
  assertFieldName(idField);
  if (!(Number.isInteger(chunkSize) && chunkSize > 0)) {
    throw new Error(`makeArcgisIdCurrencySource: chunkSize must be a positive integer; got ${chunkSize}`);
  }

  const requests = { count: 0 };
  const base = url.replace(/\/+$/, "");
  let metadata = null;

  async function loadMetadata() {
    if (metadata) return metadata;
    let json;
    try {
      json = await fetchJson(`${base}?f=json`, { fetchImpl, timeoutMs, requests });
    } catch (err) {
      throw unreachable(
        `live-currency source ${base} could not be read: ${err?.message ?? err}`,
        { url: base, idField, cause: String(err?.message ?? err) },
      );
    }
    const fields = Array.isArray(json?.fields) ? json.fields : null;
    if (!fields) {
      throw unreachable(
        `live-currency source ${base} returned no field list; refusing to treat it as a source`,
        { url: base, idField },
      );
    }
    if (!fields.some((f) => f?.name === idField)) {
      throw unreachable(
        `live-currency source ${base} has no field ${idField} (has: ${fields
          .map((f) => f?.name)
          .filter(Boolean)
          .slice(0, 12)
          .join(", ")}); the registered field does not exist on this layer, so no reading it ` +
          "produced would mean anything",
        { url: base, idField, fields: fields.map((f) => f?.name) },
      );
    }
    metadata = {
      url: base,
      idField,
      layerName: json?.name ?? null,
      maxRecordCount: Number(json?.maxRecordCount) || maxRecordCount,
      fieldType: fields.find((f) => f?.name === idField)?.type ?? null,
      objectIdField: json?.objectIdField ?? null,
      supportsPagination: json?.advancedQueryCapabilities?.supportsPagination ?? null,
    };
    return metadata;
  }

  /**
   * One chunk, in ONE literal dialect: try the field-type-driven `where` first, and if the layer
   * refuses it with an ArcGIS 400 retry the alternative (bare) form. Never throws: a chunk that
   * fails in both dialects is a per-chunk `unmeasured`, not a voided run.
   */
  async function queryChunk(chunk, meta) {
    const hits = new Set();
    const attempt = async (style) => {
      const where = buildWhere(meta.idField, chunk, style, meta.fieldType);
      const pageSize = Math.min(chunkSize, meta.maxRecordCount);
      for (let page = 0; page < MAX_PAGES_PER_CHUNK; page++) {
        const params = new URLSearchParams({
          where,
          outFields: meta.idField,
          returnGeometry: "false",
          f: "json",
        });
        // Paging parameters only from page 1 onward: some MapServer layers reject an
        // `resultOffset` on a query they consider unpaged ("Unable to complete operation").
        if (page > 0) {
          params.set("orderByFields", meta.objectIdField ?? meta.idField);
          params.set("resultOffset", String(page * pageSize));
          params.set("resultRecordCount", String(pageSize));
        }
        const json = await fetchJson(`${meta.url}/query?${params.toString()}`, {
          fetchImpl,
          timeoutMs,
          requests,
        });
        const features = Array.isArray(json?.features) ? json.features : [];
        for (const feature of features) {
          const raw = feature?.attributes?.[meta.idField];
          if (raw === null || raw === undefined) continue;
          hits.add(normalizeLiveCurrencyId(raw));
        }
        const exceeded = json?.exceededTransferLimit === true;
        if (!exceeded || features.length === 0) break;
      }
    };

    try {
      await attempt("typed");
    } catch (err) {
      const alt = alternativeStyle(err, chunk, meta.fieldType);
      if (alt) {
        try {
          await attempt(alt);
          return { hits, unmeasured: [] };
        } catch (err2) {
          return {
            hits,
            unmeasured: chunk.map((id) => ({
              id,
              reason: `chunk query failed in both literal forms: ${err.message} / then ${err2?.message ?? err2}`,
            })),
          };
        }
      }
      return {
        hits,
        unmeasured: chunk.map((id) => ({ id, reason: `chunk query failed: ${err?.message ?? err}` })),
      };
    }
    return { hits, unmeasured: [] };
  }

  async function source(rawIds) {
    const ids = [...new Set((rawIds ?? []).map((v) => String(v).trim()).filter(Boolean))];
    const out = new Map();
    if (ids.length === 0) return out;
    const meta = await loadMetadata(); // may throw LIVE_CURRENCY_UNREACHABLE: whole-layer failure
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      /* eslint-disable no-await-in-loop -- chunked on purpose: sequential, polite, and counted */
      const { hits, unmeasured } = await queryChunk(chunk, meta);
      /* eslint-enable no-await-in-loop */
      for (const id of chunk) {
        const key = normalizeLiveCurrencyId(id);
        if (hits.has(key)) {
          out.set(key, { reading: "live" });
        } else if (unmeasured.some((u) => u.id === id)) {
          const why = unmeasured.find((u) => u.id === id).reason;
          out.set(key, { reading: "unmeasured", reason: why });
        } else {
          out.set(key, { reading: "absent" });
        }
      }
    }
    return out;
  }

  Object.defineProperty(source, "requests", { get: () => requests.count });
  Object.defineProperty(source, "describe", { get: () => metadata });
  return source;
}
