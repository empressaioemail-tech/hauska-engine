/**
 * OPS-9 S3 fix regression test — ECode360Adapter's default request
 * rate.
 *
 * Pins the adapter's internally-constructed `RespectfulFetch` to
 * `maxRequestsPerSecondPerHost: 0.5`. Evidence (2026-08-04 S3 proving
 * run): two independent live attempts against the real Smithville
 * SM6484 site at the adapter's PRIOR default of 1 rps both hit HTTP
 * 429 + Cloudflare challenge within 16-21 seconds (one after a 20s
 * backoff-retry, the one permitted retry). The next attempt at 0.5 rps
 * — same UA, same headers, same target, only the rate changed —
 * completed the full ~192-page crawl cleanly with zero blocks. This
 * matches the 2026-07-29/30 proof, which also ran at 0.5 rps
 * deliberately after observing a mid-crawl 429 at a higher rate.
 *
 * This test intercepts the real `RespectfulFetch` constructor (via
 * `vi.mock` + `importOriginal`, delegating all behavior to the real
 * class) rather than asserting on private fields or grepping source
 * text, so it fails if a future edit changes the constructed default
 * even if the literal `0.5` in the source moves or is computed
 * differently.
 */

import { describe, expect, it, vi } from "vitest";

const constructedOptions: unknown[] = [];

vi.mock("../../http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../http.js")>();
  class SpyRespectfulFetch extends actual.RespectfulFetch {
    constructor(opts: ConstructorParameters<typeof actual.RespectfulFetch>[0] = {}) {
      constructedOptions.push(opts);
      super(opts);
    }
  }
  return { ...actual, RespectfulFetch: SpyRespectfulFetch };
});

describe("ECode360Adapter — default rate", () => {
  it("constructs its default internal RespectfulFetch at 0.5 rps (not 1)", async () => {
    constructedOptions.length = 0;
    const { ECode360Adapter } = await import("../index.js");
    // eslint-disable-next-line no-new -- constructing for the side effect of capturing opts
    new ECode360Adapter();

    expect(constructedOptions).toHaveLength(1);
    const opts = constructedOptions[0] as { maxRequestsPerSecondPerHost?: number };
    expect(opts.maxRequestsPerSecondPerHost).toBe(0.5);
  });

  it("does not construct a default RespectfulFetch at all when a caller injects its own http client", async () => {
    constructedOptions.length = 0;
    const { ECode360Adapter } = await import("../index.js");
    const { RespectfulFetch } = await import("../../http.js");
    const injected = new RespectfulFetch({ maxRequestsPerSecondPerHost: 1000 });
    constructedOptions.length = 0; // clear the one recorded for `injected` itself
    // eslint-disable-next-line no-new
    new ECode360Adapter({ http: injected });

    expect(constructedOptions).toHaveLength(0);
  });
});
