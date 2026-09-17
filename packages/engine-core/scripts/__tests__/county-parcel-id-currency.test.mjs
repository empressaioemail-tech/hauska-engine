/**
 * P-275 tests for the shared ArcGIS id-currency reader.
 *
 * Everything here runs against a fake fetch: no network, no store, no county. The point is to pin
 * the behaviours the dispatch's falsifier 2 depends on — an unreachable source must be
 * DISTINGUISHABLE from a source that answered "not found", and a partial failure must degrade the
 * ids it could not answer for rather than the whole run.
 */
import { describe, expect, it } from "vitest";

import {
  LIVE_CURRENCY_UNREACHABLE,
  makeArcgisIdCurrencySource,
  normalizeLiveCurrencyId,
} from "../county-parcel-id-currency.mjs";
import { normalizeParcelKeyToken } from "../../src/parcel-node/plan-county-parcel-nodes.ts";

const URL_BASE = "https://example.invalid/arcgis/rest/services/Fake_Parcels/FeatureServer/0";

/**
 * A fake ArcGIS layer: metadata probe + `IN (...)` query, logging every request.
 *
 * `rejectQuotedNumerics` models the Travis dialect, measured live: `PROP_ID` (Integer) answers
 * `ArcGIS error 400 Unable to complete operation` for `PROP_ID IN ('1000025')` and 200 for the bare
 * form. With it on, the reader's typed form fails and its bare fallback has to carry the chunk.
 */
function fakeLayer({ rows, maxRecordCount = 2000, fields = ["prop_id", "PROP_ID", "QuickRefID"], fieldTypes = {}, failQuery = null, failMetadata = false, metadataBody = null, nonJsonQuery = false, rejectQuotedNumerics = false, rejectBareNumerics = false }) {
  const calls = [];
  /** ArcGIS coerces a numeric field, so `1234` matches a query for `'0001234'`. Model that. */
  const sameId = (a, b) => {
    const [x, y] = [String(a), String(b)];
    if (x === y) return true;
    return /^\d+$/.test(x) && /^\d+$/.test(y) && x.replace(/^0+(?=\d)/, "") === y.replace(/^0+(?=\d)/, "");
  };
  const unquote = (raw) => {
    const s = raw.trim();
    if (s.startsWith("'") && s.endsWith("'")) return { value: s.slice(1, -1).replace(/\\'/g, "'"), quoted: true };
    return { value: s, quoted: false };
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (failMetadata && !String(url).includes("/query")) {
      throw new Error("ENOTFOUND example.invalid");
    }
    if (String(url).includes("/query")) {
      if (failQuery) {
        if (failQuery === "http") return { ok: false, status: 503, statusText: "Service Unavailable" };
        if (failQuery === "throw") throw new Error("ECONNRESET");
      }
      if (nonJsonQuery) return { ok: true, text: async () => "<html>maintenance</html>" };
      // URLSearchParams encodes space as `+`, NOT `%20` -- strip both before parsing.
      const where = decodeURIComponent(String(url).match(/where=([^&]*)/)?.[1] ?? "").replace(/\+/g, " ");
      const idField = fields.find((f) => where.startsWith(`${f} IN (`)) ?? fields[0];
      const inside = where.slice(where.indexOf("(") + 1, where.lastIndexOf(")"));
      const literals = inside.split(",").map(unquote).filter((l) => l.value !== "");
      const type = fieldTypes[idField] ?? "esriFieldTypeInteger";
      const numeric = /Integer|Double|Single|OID/.test(type);
      if (rejectQuotedNumerics && literals.some((l) => l.quoted)) {
        return { ok: true, text: async () => JSON.stringify({ error: { code: 400, message: "Unable to complete operation." } }) };
      }
      if (rejectBareNumerics && numeric && literals.some((l) => !l.quoted)) {
        return { ok: true, text: async () => JSON.stringify({ error: { code: 400, message: "Unable to complete operation." } }) };
      }
      const matched = literals.map((l) => l.value).filter((v) => rows.some((r) => sameId(r[idField], v)));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            features: matched.map((v) => ({ attributes: { [idField]: v } })),
            exceededTransferLimit: matched.length > maxRecordCount,
          }),
      };
    }
    const meta = metadataBody ?? {
      name: "Fake_Parcels",
      objectIdField: "OBJECTID",
      maxRecordCount,
      fields: fields.map((name) => ({ name, type: fieldTypes[name] ?? "esriFieldTypeInteger" })),
    };
    return { ok: true, text: async () => JSON.stringify(meta) };
  };
  return { fetchImpl, calls };
}

describe("county-parcel-id-currency: the reading itself", () => {
  it("answers live for ids the county has, absent for ids it does not, and counts its requests", async () => {
    const { fetchImpl, calls } = fakeLayer({ rows: [{ prop_id: 100002 }, { prop_id: 100003 }] });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", fetchImpl });
    const readings = await source(["100002", "99999999"]);

    expect(readings.get("100002")).toEqual({ reading: "live" });
    expect(readings.get("99999999")).toEqual({ reading: "absent" });
    expect(source.requests).toBe(2); // 1 metadata probe + 1 chunk query
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("returnGeometry=false");
  });

  it("REGRESSION (the Williamson trap): the field name decides the answer, and the wrong one is not a source", async () => {
    // A layer whose parcel-map ids live in QuickRefID while PropertyID holds accounts. Pointed at
    // the wrong field, every real node id answers "absent" -- a confidently INVERTED answer. This
    // is why the namespace is verified before registration, and why the probe below is fatal.
    const rows = [{ QuickRefID: "R000009", PropertyID: "ACCT-77" }];
    // Both fields EXIST on the layer: the wrong one is not fatal here, it is worse -- it answers.
    const fields = ["QuickRefID", "PropertyID"];
    const fieldTypes = { QuickRefID: "esriFieldTypeString", PropertyID: "esriFieldTypeString" };
    const good = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "QuickRefID",
      fetchImpl: fakeLayer({ rows, fields, fieldTypes }).fetchImpl,
    });
    expect((await good(["R000009"])).get("R000009")).toEqual({ reading: "live" });

    const bad = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "PropertyID",
      fetchImpl: fakeLayer({ rows, fields, fieldTypes }).fetchImpl,
    });
    expect((await bad(["R000009"])).get("R000009")).toEqual({ reading: "absent" }); // inverted
  });

  it("a declared field that is not on the layer is FATAL, not an all-absent answer", async () => {
    const { fetchImpl } = fakeLayer({ rows: [], fields: ["QuickRefID"] });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "PropertyID", fetchImpl });
    await expect(source(["R000009"])).rejects.toMatchObject({
      code: LIVE_CURRENCY_UNREACHABLE,
      idField: "PropertyID",
    });
    await expect(source(["R000009"])).rejects.toThrow(/has no field PropertyID/);
  });

  it("an unreachable layer THROWS -- it must never be readable as 'no such parcel'", async () => {
    for (const opts of [
      { failMetadata: true },
      { metadataBody: { error: { code: 499, message: "Token Required" } } },
      { metadataBody: { not: "a service" } },
    ]) {
      const { fetchImpl } = fakeLayer({ rows: [], ...opts });
      const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", fetchImpl });
      await expect(source(["1"])).rejects.toMatchObject({ code: LIVE_CURRENCY_UNREACHABLE });
    }
  });

  it("a non-JSON body is a failure, not an empty result", async () => {
    const { fetchImpl } = fakeLayer({ rows: [], nonJsonQuery: true });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", fetchImpl });
    // metadata is fine; the chunk fails -> per-chunk unmeasured, NOT absent
    const readings = await source(["1", "2"]);
    expect(readings.get("1").reading).toBe("unmeasured");
    expect(readings.get("1").reason).toContain("not JSON");
    expect(readings.get("2").reading).toBe("unmeasured");
  });

  it("a chunk that fails marks only ITS ids unmeasured; the rest are still measured", async () => {
    // 3 ids, chunkSize 2 -> chunk [1,2] and chunk [3]. Only the second chunk fails.
    const seen = [];
    const fetchImpl = async (url) => {
      const s = String(url);
      if (!s.includes("/query")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ maxRecordCount: 2000, fields: [{ name: "prop_id", type: "esriFieldTypeInteger" }] }),
        };
      }
      const where = decodeURIComponent(s.match(/where=([^&]*)/)?.[1] ?? "").replace(/\+/g, " ");
      seen.push(where);
      if (/IN \(3\)/.test(where)) return { ok: false, status: 500, statusText: "Internal Server Error" };
      return { ok: true, text: async () => JSON.stringify({ features: [{ attributes: { prop_id: 1 } }] }) };
    };
    const source = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "prop_id",
      chunkSize: 2,
      fetchImpl,
    });
    const readings = await source(["1", "2", "3"]);
    expect(readings.get("1")).toEqual({ reading: "live" });
    expect(readings.get("2")).toEqual({ reading: "absent" });
    expect(readings.get("3").reading).toBe("unmeasured");
    expect(readings.get("3").reason).toContain("HTTP 500");
    expect(seen).toHaveLength(2);
  });

  it("DIALECT FALLBACK: a layer that refuses the narrow literal form is retried in the other", async () => {
    // Two live dialects, both measured 2026-09-17. Travis `PROP_ID` (Integer) rejects the QUOTED
    // form ("Unable to complete operation" / ArcGIS 400) and needs it bare; some layers go the
    // other way and need an all-numeric id quoted. The typed form is the primary, and a chunk that
    // 400s is retried in the alternative before its ids are called unmeasured -- otherwise a
    // reachable source reads as an unmeasured county.
    const rows = [{ PROP_ID: 1000025 }];
    const fields = ["PROP_ID"];
    const fieldTypes = { PROP_ID: "esriFieldTypeInteger" };

    // (a) the numeric field wants BARE and the type already says so: one query, no fallback
    const typed = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "PROP_ID",
      fetchImpl: fakeLayer({ rows, fields, fieldTypes }).fetchImpl,
    });
    expect((await typed(["1000025", "999999999"])).get("1000025")).toEqual({ reading: "live" });
    expect(typed.requests).toBe(2); // 1 metadata + 1 chunk: the typed form was accepted

    // (b) the layer rejects BARE and demands quotes -> the fallback must carry the chunk, and the
    //     extra request must be COUNTED rather than hidden.
    const stubborn = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "PROP_ID",
      fetchImpl: fakeLayer({ rows, fields, fieldTypes, rejectBareNumerics: true }).fetchImpl,
    });
    expect((await stubborn(["1000025"])).get("1000025")).toEqual({ reading: "live" });
    expect(stubborn.requests).toBe(3); // metadata + the rejected bare query + the quoted retry

    // (c) a STRING id has no numeric alternative, so a 400 on the quoted form is a genuine
    //     per-chunk failure -- unmeasured, with the reason, never silently absent
    const stringy = makeArcgisIdCurrencySource({
      url: URL_BASE,
      idField: "QuickRefID",
      fetchImpl: fakeLayer({
        rows: [{ QuickRefID: "R000009" }],
        fields: ["QuickRefID"],
        fieldTypes: { QuickRefID: "esriFieldTypeString" },
        rejectQuotedNumerics: true,
      }).fetchImpl,
    });
    const readings = await stringy(["R000009"]);
    expect(readings.get("R000009").reading).toBe("unmeasured");
    expect(readings.get("R000009").reason).toContain("ArcGIS error 400");
  });

  it("a string field is asked in the quoted form and is NOT retried as a bare number", async () => {
    const { fetchImpl } = fakeLayer({
      rows: [{ QuickRefID: "R000009" }],
      fields: ["QuickRefID"],
      fieldTypes: { QuickRefID: "esriFieldTypeString" },
    });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "QuickRefID", fetchImpl });
    expect((await source(["R000009"])).get("R000009")).toEqual({ reading: "live" });
    expect(source.requests).toBe(2);
  });

  it("normalizes zero-padded ids the same way the planner does", () => {
    for (const [raw, spaced] of [["007", " 007 "], ["21936", "21936"], ["R000009", "R000009"], ["0", "0"]]) {
      expect(normalizeLiveCurrencyId(spaced)).toBe(normalizeParcelKeyToken(raw));
    }
  });

  it("matches a zero-padded node id against a zero-padded source row", async () => {
    const { fetchImpl } = fakeLayer({ rows: [{ prop_id: 1234 }] });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", fetchImpl });
    expect((await source(["0001234"])).get("1234")).toEqual({ reading: "live" });
  });

  it("refuses an idField that could carry SQL", () => {
    expect(() => makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id) OR 1=1--" })).toThrow(
      /plain identifier/,
    );
  });

  it("a non-http url and a non-positive chunkSize are refused at construction, not at query time", () => {
    expect(() => makeArcgisIdCurrencySource({ url: "file:///x", idField: "prop_id" })).toThrow(/http/);
    expect(() => makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", chunkSize: 0 })).toThrow(
      /chunkSize/,
    );
  });

  it("no ids means no requests at all", async () => {
    const { fetchImpl, calls } = fakeLayer({ rows: [] });
    const source = makeArcgisIdCurrencySource({ url: URL_BASE, idField: "prop_id", fetchImpl });
    expect((await source([])).size).toBe(0);
    expect(calls).toEqual([]);
    expect(source.requests).toBe(0);
  });
});
