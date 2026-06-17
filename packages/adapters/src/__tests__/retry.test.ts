import { describe, expect, it, vi } from "vitest";
import {
  BODY_EXCERPT_MAX_CHARS,
  fetchWithRetry,
  TRANSIENT_STATUS_CODES,
} from "../retry";
import { AdapterRunError } from "../types";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

function ok(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textRes(body: string, status: number, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("fetchWithRetry", () => {
  it("returns a 200 immediately without retrying", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries each transient HTTP status the brief enumerates and succeeds on attempt 2", async () => {
    for (const status of TRANSIENT_STATUS_CODES) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(ok({}, status))
        .mockResolvedValueOnce(ok({ healed: true }, 200));
      const { response, attempts } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(200);
      expect(attempts).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("does NOT retry on hard 4xx like 400 / 404 / 422", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchImpl = vi.fn(async () => ok({ msg: "no" }, status));
      const { response, attempts } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(status);
      expect(attempts).toBe(1);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("retries on a transient network-reset throw and surfaces the final response", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(
        Object.assign(new Error("ECONNRESET"), { name: "Error" }),
      )
      .mockResolvedValueOnce(ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("gives up after `maxAttempts` transient failures and returns the last response", async () => {
    const fetchImpl = vi.fn(async () => ok({}, 503));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(503);
    expect(attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws an AdapterRunError(network-error) if every attempt rejects with a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        maxAttempts: 2,
        upstreamLabel: "Test Upstream",
      }),
    ).rejects.toMatchObject({
      name: "AdapterRunError",
      code: "network-error",
      message: expect.stringContaining("Test Upstream"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("propagates the caller's abort as a `timeout` AdapterRunError without retrying", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async () => ok());
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        signal: ac.signal,
        upstreamLabel: "X",
      }),
    ).rejects.toMatchObject({
      name: "AdapterRunError",
      code: "timeout",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a fetch throw as `timeout` (not retryable) when the caller's signal aborted mid-flight", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(async () => {
      ac.abort();
      const err = new Error("aborted by caller");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        signal: ac.signal,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(AdapterRunError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries an unattributed AbortError (not caused by the caller's signal)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce(ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  // QA-22 reopen — body-excerpt capture so adapter failure pills can
  // carry the upstream's actual error text without operators needing
  // Cloud Run log access for every triage round.
  describe("bodyExcerpt capture (QA-22)", () => {
    it("captures the body excerpt on transient-status retry exhaustion", async () => {
      const fetchImpl = vi.fn(async () =>
        textRes("Service is down for scheduled maintenance until 22:00 UTC.", 503),
      );
      const { response, attempts, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(503);
      expect(attempts).toBe(3);
      expect(bodyExcerpt).toBe(
        "Service is down for scheduled maintenance until 22:00 UTC.",
      );
    });

    it("captures the body excerpt on a hard 4xx (single attempt, no retry)", async () => {
      const fetchImpl = vi.fn(async () =>
        textRes(
          JSON.stringify({ error: { code: 400, message: "Layer 0 not found" } }),
          400,
          "application/json",
        ),
      );
      const { response, attempts, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(400);
      expect(attempts).toBe(1);
      expect(bodyExcerpt).toContain("Layer 0 not found");
    });

    it("collapses whitespace so a pretty-printed HTML error stays compact", async () => {
      const html = `
        <html>
          <body>
            <h1>503 Service Unavailable</h1>
            <p>The upstream is overloaded.</p>
          </body>
        </html>
      `;
      const fetchImpl = vi.fn(async () => textRes(html, 503, "text/html"));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeDefined();
      // No double-space runs left after the collapse — the excerpt is
      // one line regardless of how the upstream pretty-printed.
      expect(bodyExcerpt).not.toMatch(/ {2,}/);
      // And the visible characters survive in order.
      expect(bodyExcerpt).toContain("503 Service Unavailable");
      expect(bodyExcerpt).toContain("The upstream is overloaded.");
    });

    it(`truncates excerpts longer than BODY_EXCERPT_MAX_CHARS (${BODY_EXCERPT_MAX_CHARS}) with a trailing ellipsis`, async () => {
      const long = "x".repeat(BODY_EXCERPT_MAX_CHARS * 2);
      const fetchImpl = vi.fn(async () => textRes(long, 502));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeDefined();
      // The visible-character cap is exact; the appended ellipsis is the
      // single character `…`, so total length is +1.
      expect(bodyExcerpt!.length).toBe(BODY_EXCERPT_MAX_CHARS + 1);
      expect(bodyExcerpt!.endsWith("…")).toBe(true);
    });

    it("returns bodyExcerpt undefined when the body is empty", async () => {
      const fetchImpl = vi.fn(async () => textRes("", 502));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeUndefined();
    });

    it("does NOT populate bodyExcerpt on a successful (2xx) response", async () => {
      const fetchImpl = vi.fn(async () => ok({ ok: true }));
      const { response, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(200);
      expect(bodyExcerpt).toBeUndefined();
    });

    it("returns undefined excerpt when the body read itself throws", async () => {
      // Build a Response whose .text() rejects, simulating a transport
      // reset mid-read. Constructing this requires reaching into the
      // Response prototype because Response is designed to be inert
      // until consumed.
      const res = textRes("ignored", 503);
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new TypeError("network reset mid-read");
        },
      });
      const fetchImpl = vi.fn(async () => res);
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeUndefined();
    });
  });

  // QA-22 reopen follow-on — throw-path capture so adapter failure
  // pills can name DNS / TLS / firewall / aborted-connect failures
  // off the row alone, without operators needing Cloud Run access.
  // PR #88's bodyExcerpt path doesn't trigger when no response object
  // exists (the request never got an HTTP layer answer); these cases
  // pin the new captureThrowsAsResult path that collapses those
  // throws into the same `!res.ok` branch the caller already has.
  describe("throwExcerpt capture (QA-22 follow-on)", () => {
    /**
     * Build a `TypeError("fetch failed")` whose `cause` mimics what
     * node:undici attaches on a real network failure. The shape is
     * `{ name, message, code, errno, syscall, address?, port?, host? }`
     * — extracting from there is the only way to tell DNS-vs-TLS-vs-
     * ECONNREFUSED apart programmatically.
     */
    function undiciStyleThrow(
      cause: {
        code?: string;
        errno?: number;
        syscall?: string;
        address?: string;
        port?: number;
        host?: string;
        hostname?: string;
        name?: string;
        message?: string;
      },
    ): TypeError {
      const causeErr = new Error(cause.message ?? "");
      Object.assign(causeErr, cause);
      const outer = new TypeError("fetch failed");
      (outer as { cause?: unknown }).cause = causeErr;
      return outer;
    }

    it("captures a DNS failure (ENOTFOUND) and surfaces the host in throwExcerpt", async () => {
      const fetchImpl = vi.fn(async () => {
        throw undiciStyleThrow({
          code: "ENOTFOUND",
          errno: -3008,
          syscall: "getaddrinfo",
          hostname: "gis.grandcountyutah.net",
        });
      });
      const { response, attempts, throwExcerpt, bodyExcerpt } =
        await fetchWithRetry(
          "https://gis.grandcountyutah.net/x",
          undefined,
          {
            fetchImpl,
            sleepImpl: noSleep,
            maxAttempts: 3,
            captureThrowsAsResult: true,
          },
        );
      // Synthetic 599 so the caller's `!res.ok` branch picks the
      // failure up exactly like a non-OK HTTP response.
      expect(response.status).toBe(599);
      expect(response.ok).toBe(false);
      // Transient throws retry until exhaustion, so we see the
      // full attempt count here.
      expect(attempts).toBe(3);
      expect(throwExcerpt).toBe(
        "ENOTFOUND getaddrinfo gis.grandcountyutah.net",
      );
      // bodyExcerpt is not populated on the throw path — the
      // synthetic 599 has no real body.
      expect(bodyExcerpt).toBeUndefined();
    });

    it("captures a TLS failure (CERT_HAS_EXPIRED) and surfaces the code", async () => {
      const fetchImpl = vi.fn(async () => {
        throw undiciStyleThrow({
          code: "CERT_HAS_EXPIRED",
          message: "certificate has expired",
          host: "ejscreen.epa.gov",
        });
      });
      const { response, throwExcerpt } = await fetchWithRetry(
        "https://ejscreen.epa.gov/x",
        undefined,
        {
          fetchImpl,
          sleepImpl: noSleep,
          maxAttempts: 1,
          captureThrowsAsResult: true,
        },
      );
      expect(response.status).toBe(599);
      // CERT_HAS_EXPIRED doesn't match the transient regex, so it
      // returns on attempt 1 without retry — no syscall reported.
      expect(throwExcerpt).toBe("CERT_HAS_EXPIRED ejscreen.epa.gov");
    });

    it("captures an ECONNREFUSED and surfaces the resolved address:port", async () => {
      // Firewall-rejected connect — undici sometimes carries only
      // `address`/`port` on the cause, no `host`/`hostname`. The
      // helper falls back to `address:port` for that case.
      const fetchImpl = vi.fn(async () => {
        throw undiciStyleThrow({
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "104.18.32.55",
          port: 443,
          message: "connect ECONNREFUSED 104.18.32.55:443",
        });
      });
      const { response, attempts, throwExcerpt } = await fetchWithRetry(
        "https://broadbandmap.fcc.gov/x",
        undefined,
        {
          fetchImpl,
          sleepImpl: noSleep,
          maxAttempts: 3,
          captureThrowsAsResult: true,
        },
      );
      expect(response.status).toBe(599);
      expect(attempts).toBe(3);
      expect(throwExcerpt).toBe("ECONNREFUSED connect 104.18.32.55:443");
    });

    it("propagates a caller-abort as `timeout` AdapterRunError even with captureThrowsAsResult set", async () => {
      // The caller-abort branch wins over `captureThrowsAsResult`
      // because the abort is a semantic "your budget elapsed"
      // signal — operator wants to see "did not respond in time",
      // not "Network error: AbortError" misattributing it to a
      // network class. This invariant lets the runner's per-
      // adapter timeout still surface as a `timeout`-class
      // failure on the FE pill the way it has since QA-22.
      const ac = new AbortController();
      const fetchImpl = vi.fn(async () => {
        ac.abort();
        const err = new Error("aborted by caller");
        err.name = "AbortError";
        throw err;
      });
      await expect(
        fetchWithRetry("https://example.test/x", undefined, {
          fetchImpl,
          sleepImpl: noSleep,
          signal: ac.signal,
          maxAttempts: 3,
          captureThrowsAsResult: true,
        }),
      ).rejects.toMatchObject({
        name: "AdapterRunError",
        code: "timeout",
      });
    });

    it("still populates bodyExcerpt (not throwExcerpt) for response-bearing failures when captureThrowsAsResult is set", async () => {
      // The two excerpt paths are mutually exclusive in practice:
      // bodyExcerpt fires when an HTTP response came back non-OK,
      // throwExcerpt fires when no response came back at all.
      // Pinning the no-regression invariant for the bodyExcerpt
      // path so a future contributor doesn't accidentally swap
      // them around when refactoring the catch branch.
      const fetchImpl = vi.fn(async () =>
        textRes("Maintenance until 22:00 UTC.", 503),
      );
      const { response, attempts, bodyExcerpt, throwExcerpt } =
        await fetchWithRetry(
          "https://example.test/x",
          undefined,
          {
            fetchImpl,
            sleepImpl: noSleep,
            maxAttempts: 3,
            captureThrowsAsResult: true,
          },
        );
      expect(response.status).toBe(503);
      expect(attempts).toBe(3);
      expect(bodyExcerpt).toBe("Maintenance until 22:00 UTC.");
      expect(throwExcerpt).toBeUndefined();
    });

    it("preserves the legacy throw posture when captureThrowsAsResult is not set", async () => {
      // The opt-in flag is what keeps backward-compat for the OSM
      // Overpass / USGS NED / FEMA NFHL / state-tier call sites
      // that didn't get explicit wiring in this PR. Without the
      // flag, a fetch-throw still surfaces as
      // `AdapterRunError("network-error", "<label> request failed
      // after N attempts: <err.message>. Use Force refresh to
      // retry.")` exactly like before.
      const fetchImpl = vi.fn(async () => {
        throw undiciStyleThrow({
          code: "ENOTFOUND",
          syscall: "getaddrinfo",
          hostname: "example.invalid",
        });
      });
      await expect(
        fetchWithRetry("https://example.invalid/x", undefined, {
          fetchImpl,
          sleepImpl: noSleep,
          maxAttempts: 1,
          upstreamLabel: "Test Upstream",
        }),
      ).rejects.toMatchObject({
        name: "AdapterRunError",
        code: "network-error",
        message: expect.stringContaining("Test Upstream"),
      });
    });

    it("falls back to `<name>: <message>` when the throw has no cause-side structure", async () => {
      // A hand-thrown Error from a non-undici fetch path (or a
      // test fake that doesn't follow the cause convention) still
      // yields a usable excerpt — the helper degrades gracefully
      // rather than returning undefined.
      const fetchImpl = vi.fn(async () => {
        const err = new Error("socket hang up");
        err.name = "FetchError";
        throw err;
      });
      const { throwExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        {
          fetchImpl,
          sleepImpl: noSleep,
          maxAttempts: 1,
          captureThrowsAsResult: true,
        },
      );
      expect(throwExcerpt).toBe("FetchError: socket hang up");
    });
  });
});
