/**
 * P-154 (OPS-23 wave 4, share) — retirement proof.
 *
 * `./most-current-setback-resolver.js` (this package's own copy of the
 * resolver, built under P-154 wave 3, merged hauska-engine#424 `2221b6a6`)
 * is retired by decline: every consumer in this package now imports
 * `@empressaio/setback-corpus/resolve` instead (see `index.ts` and
 * `bastrop-per-parcel-record.ts`). This test is the falsifier from the
 * mission's own step 2: "a retirement test asserts the old relative path
 * does not resolve (`import()` rejects)". If this ever starts resolving
 * again — the file was re-added, or a build step resurrects a stale dist
 * artifact — the retirement is no longer true and this test must fail.
 */
import { describe, expect, it } from "vitest";

describe("most-current-setback-resolver.js — retired by decline", () => {
  it("the old relative import path no longer resolves", async () => {
    // Built from a non-literal so tsc does not statically resolve the
    // module at typecheck time — the whole point of this test is that the
    // path is GONE, so a static resolution would defeat it either way
    // (compile error if strict, or a stale cached .d.ts if not).
    const retiredRelativePath = ["..", "most-current-setback-resolver.js"].join("/");
    await expect(import(retiredRelativePath)).rejects.toBeTruthy();
  });

  it("the resolver's public API is reachable ONLY through @empressaio/setback-corpus/resolve now", async () => {
    const corpusResolve = await import("@empressaio/setback-corpus/resolve");
    expect(typeof corpusResolve.resolveMostCurrentSetback).toBe("function");
    expect(typeof corpusResolve.parseYearSequenceOrdinanceCitation).toBe(
      "function",
    );
  });
});
