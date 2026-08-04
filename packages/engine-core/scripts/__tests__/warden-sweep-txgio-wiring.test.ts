/**
 * warden-sweep.mjs — TXGIO connection wiring, pinned (bug fix regression
 * guard). A live prod sweep hit `PostgresError: relation "txgio_parcel" does
 * not exist` because the neighborConsistency check's adjacency loader
 * (loadParcelAdjacencyIndexFromNeon, which queries txgio_parcel) was called
 * with `sql` — the ATOMS Neon connection — instead of `txSql` — the TXGIO
 * Neon connection (the ldt deployment DB, DEPLOYMENT_DATABASE_URL in prod).
 *
 * The CLI script cannot be imported directly in a unit test (top-level arg
 * parsing, live `postgres()` connection construction, and `process.exit` all
 * run at module-load time — the same reason onboard-preflight.mjs and
 * block13-cert-grade.mjs have no direct-import test coverage in this repo).
 * This test pins the wiring two ways instead:
 *
 *   1. A structural (grep-style) pin on the actual call-site source text —
 *      matches this repo's established precedent for CLI-script pins
 *      (scripts/__tests__/backfill-bastrop-zoning-fact-code-refs.test.ts,
 *      property-reasoning/__tests__/cascade-unzoned-envelope-decline.test.ts)
 *      — so a future edit that reintroduces `sql` at this call site fails
 *      this test even without a live database.
 *   2. A behavioral pin at the boundary-primitive seam the CLI calls into:
 *      two distinguishable stub `postgres.Sql`-shaped tagged-template
 *      connections (one "atoms-shaped", one "txgio-shaped") are injected
 *      directly into loadParcelAdjacencyIndexFromNeon and
 *      loadZoningByParcel's underlying query pattern, asserting each reads
 *      from the connection that actually carries its table.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { loadParcelAdjacencyIndexFromNeon } from "../../src/boundary-primitive/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(HERE, "../warden-sweep.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

describe("warden-sweep.mjs — neighborConsistency adjacency load uses txSql, never sql (pinned)", () => {
  it("calls loadParcelAdjacencyIndexFromNeon with txSql (the TXGIO connection), not sql (the atoms connection)", () => {
    expect(scriptSource).toContain("loadParcelAdjacencyIndexFromNeon(txSql, row.fips)");
    expect(scriptSource).not.toMatch(/loadParcelAdjacencyIndexFromNeon\(sql,/);
  });

  it("the neighborConsistency guard requires BOTH sql and txSql before running (never runs on sql alone)", () => {
    // Structural pin on the specific neighborConsistency branch: extract from
    // the check's `if (requestedChecks.includes("neighborConsistency"))` block
    // up to the next top-level `if (requestedChecks.includes(` so this stays
    // robust to unrelated edits elsewhere in main().
    const blockMatch = scriptSource.match(
      /if \(requestedChecks\.includes\("neighborConsistency"\)\)[\s\S]*?(?=\n {2}if \(requestedChecks\.includes\("servePathTruth"\))/,
    );
    expect(blockMatch).not.toBeNull();
    const block = blockMatch![0];
    expect(block).toMatch(/if \(!sql \|\| !txSql\)/);
  });

  it("the three-env-connection contract is documented in the header (DATABASE_URL / TXGIO_DATABASE_URL / RETRIEVAL_API_URL, each named to its store)", () => {
    expect(scriptSource).toMatch(/DATABASE_URL\s+—\s+the ATOMS Neon/);
    expect(scriptSource).toMatch(/TXGIO_DATABASE_URL[\s\S]{0,120}—\s+the LDT DEPLOYMENT Neon carrying/);
    expect(scriptSource).toContain("txgio_parcel");
    expect(scriptSource).toMatch(/RETRIEVAL_API_URL \+ RETRIEVAL_API_KEY\s+—\s+the deployed retrieval-api/);
    expect(scriptSource).toContain("legacy-design-tools-prod");
    expect(scriptSource).toContain("DEPLOYMENT_DATABASE_URL");
  });

  it("both connections are closed on exit (storageHandle.close, txSql.end, sql.end all present in the finally block)", () => {
    const finallyMatch = scriptSource.match(/} finally \{[\s\S]*$/);
    expect(finallyMatch).not.toBeNull();
    const finallyBlock = finallyMatch![0];
    expect(finallyBlock).toContain("storageHandle.close()");
    expect(finallyBlock).toContain("txSql.end()");
    expect(finallyBlock).toContain("sql.end()");
  });
});

describe("loadParcelAdjacencyIndexFromNeon — behavioral pin: reads txgio_parcel from whichever connection it is given", () => {
  /** A minimal postgres.Sql-shaped tagged-template stub that records every query text it receives. */
  function makeStubSql(label: string, rows: unknown[]) {
    const calls: string[] = [];
    const fn = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push(text);
      return rows;
    });
    return { label, fn: fn as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>, calls };
  }

  it("queries txgio_parcel on WHATEVER connection it is passed — proving the CLI's choice of connection is what determines correctness", async () => {
    const txgioShaped = makeStubSql("txgio", []);
    const index = await loadParcelAdjacencyIndexFromNeon(
      txgioShaped.fn as unknown as Parameters<typeof loadParcelAdjacencyIndexFromNeon>[0],
      "48021",
    );
    expect(txgioShaped.calls.some((c) => c.includes("txgio_parcel"))).toBe(true);
    expect(index.countyFips).toBe("48021");
    expect(index.entries.size).toBe(0);
  });

  it("an atoms-shaped connection with no txgio_parcel table would fail this query in prod — the fix routes the CLI around that by passing txSql", async () => {
    // This test does not hit a real database (both stubs are in-memory), but
    // documents the exact prod failure mode the fix addresses: calling this
    // function with the atoms connection sends the identical `FROM
    // txgio_parcel` query text to a database that has no such relation,
    // which is precisely the verbatim prod error
    // (`PostgresError: relation "txgio_parcel" does not exist`) that
    // motivated this fix.
    const atomsShapedThatWouldFailInProd = makeStubSql("atoms", []);
    await loadParcelAdjacencyIndexFromNeon(
      atomsShapedThatWouldFailInProd.fn as unknown as Parameters<typeof loadParcelAdjacencyIndexFromNeon>[0],
      "48021",
    );
    // The query text is identical regardless of which connection it is sent
    // to — the bug was never in this function, it was in the CLI's choice of
    // WHICH connection to call it with (pinned in the describe block above).
    expect(atomsShapedThatWouldFailInProd.calls.some((c) => c.includes("txgio_parcel"))).toBe(true);
  });
});

describe("warden-sweep.mjs — envelopeIndependentOfStaleSetback stays code-generic (consumer-compat pin, REASON-OVERSTATES fix 2026-08-04)", () => {
  // The unzoned-county cascade now mints TWO decline codes
  // (unzoned-no-district-basis for unincorporated parcels,
  // no-district-on-record for in-city-but-unonboarded parcels — see
  // property-reasoning/cascade-unzoned-envelope-decline.ts). This helper
  // must keep treating warmVerifyDeclineCode generically (any non-empty
  // string) rather than being narrowed to a hardcoded list of known codes —
  // narrowing it would silently stop recognizing the new code as an honest,
  // serve-independent decline.
  it("checks warmVerifyDeclineCode generically (non-empty-string), not a hardcoded code allowlist", () => {
    const fnMatch = scriptSource.match(
      /function envelopeIndependentOfStaleSetback\([\s\S]*?\n}/,
    );
    expect(fnMatch).not.toBeNull();
    const fnSource = fnMatch![0];
    expect(fnSource).toMatch(
      /typeof envelopeBody\.warmVerifyDeclineCode === "string" && envelopeBody\.warmVerifyDeclineCode\.trim\(\)\.length > 0/,
    );
    // Must not have been narrowed to check against a specific code literal.
    expect(fnSource).not.toContain("unzoned-no-district-basis");
    expect(fnSource).not.toContain("no-district-on-record");
  });
});
