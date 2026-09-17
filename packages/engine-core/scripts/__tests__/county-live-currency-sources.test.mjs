/**
 * P-275 tests for the live-currency registry itself.
 *
 * The registry is a statement about the world — which county is read from where, by which field —
 * so its shape is worth asserting rather than eyeballing. The load-bearing checks:
 *
 *   - every registered county is a callable reader, and every unregistered county has a REASON
 *     (a county that is simply missing is an omission; a county with a stated reason is an answer)
 *   - each ArcGIS entry declares the field that was verified against real ids, so a silent field
 *     swap (the Williamson `PropertyID`/`QuickRefID` trap) fails here
 *   - NO entry reads `txgio_parcel`, which is the source a false retirement is judged against —
 *     a "live" reading must be a second, independently derived one
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LIVE_CURRENCY_SOURCES,
  NO_SOURCE_REASONS,
  liveCurrencySourceFor,
  registeredLiveCurrencyCounties,
} from "../county-live-currency-sources.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registrySource = readFileSync(
  path.join(here, "..", "county-live-currency-sources.mjs"),
  "utf8",
);

/** The field each county's source was verified against, with the live evidence. */
const VERIFIED_FIELDS = {
  "48055": "Prop_ID", // Caldwell: Prop_ID=10001..10005 (real active node ids) -> live
  "48209": "prop_id", // Hays: 100002..100014 -> live, control 999999999 -> absent
  "48453": "PROP_ID", // Travis: 1000025..1000029 -> live, control -> absent
  "48491": "QuickRefID", // Williamson: R000009..R000019 -> live, control -> absent
};

describe("county-live-currency-sources: the registry's shape", () => {
  it("registers exactly the five counties that have a source, and Bastrop is one of them", () => {
    expect(registeredLiveCurrencyCounties()).toEqual([
      "48021",
      "48055",
      "48209",
      "48453",
      "48491",
    ]);
  });

  it("McLennan is UNREGISTERED WITH A REASON, not merely missing", () => {
    expect(liveCurrencySourceFor("48309")).toBeNull();
    expect(LIVE_CURRENCY_SOURCES).toHaveProperty("48309");
    expect(LIVE_CURRENCY_SOURCES["48309"]).toBeUndefined();
    const reason = NO_SOURCE_REASONS["48309"];
    expect(reason).toMatch(/no usable public county-wide cadastral service/i);
    // The reason has to be specific enough to be checkable, not a shrug.
    expect(reason).toContain("ArcGIS Online");
    expect(reason).toContain("TrueAutomation");
  });

  it("every registered county is a callable reader; every unregistered one has a reason", () => {
    for (const fips of Object.keys(LIVE_CURRENCY_SOURCES)) {
      if (typeof LIVE_CURRENCY_SOURCES[fips] === "function") {
        expect(liveCurrencySourceFor(fips)).toBeTypeOf("function");
      } else {
        expect(NO_SOURCE_REASONS[fips], `county ${fips} has no source and no reason`).toBeTruthy();
      }
    }
  });

  it("each ArcGIS entry declares the field the namespace probe verified", () => {
    for (const [fips, field] of Object.entries(VERIFIED_FIELDS)) {
      const src = liveCurrencySourceFor(fips);
      // `.describe` is only populated after the metadata probe runs, so assert the declaration
      // where it actually lives -- the source text of the registry.
      expect(registrySource).toContain(`idField: "${field}"`);
      expect(src).toBeTypeOf("function");
    }
    // The trap this guards: Williamson's CAD registry names PropertyID (the ACCOUNT). Registering
    // it would answer 0 for every real node id and read as a county-wide disappearance.
    expect(registrySource).not.toContain(`idField: "PropertyID"`);
    expect(registrySource).not.toContain(`idField: "propertyId"`);
  });

  it("the registry NEVER reads txgio_parcel -- a live reading must be independently derived", () => {
    // The dispatch's own words: the county's own public cadastral service, "never txgio_parcel,
    // which is the source a false retirement is judged against". Checked as CODE, not prose: the
    // file may say the word in a comment, but it must not open a database or write a query.
    expect(registrySource).not.toMatch(/\bfrom\s+["']postgres["']/);
    expect(registrySource).not.toMatch(/@hauska-engine\/storage/);
    expect(registrySource).not.toMatch(/FROM\s+txgio_parcel/i);
    expect(registrySource).not.toContain('"txgio_parcel"');
    expect(registrySource).not.toMatch(/\b(select|insert|update|delete)\b.*\bfrom\b/i);
    // And the only imports it may have are the two readers.
    const imports = [...registrySource.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      "./bastrop-batch-bulk-prefetch.mjs",
      "./county-parcel-id-currency.mjs",
    ]);
  });

  it("an unknown county answers null rather than a fallback source", () => {
    expect(liveCurrencySourceFor("48999")).toBeNull();
    expect(liveCurrencySourceFor("")).toBeNull();
    expect(liveCurrencySourceFor(null)).toBeNull();
  });
});
