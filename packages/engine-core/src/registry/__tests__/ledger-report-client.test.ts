import { describe, it, expect, vi } from "vitest";

import {
  buildLedgerIngestBody,
  countyNameForFips,
  postLedgerIngest,
  resolveLedgerIngestConfig,
} from "../ledger-report-client.js";
import type { LedgerEvent, LedgerRowMirror } from "../ledger-report-client.js";

describe("ledger-report-client, resolveLedgerIngestConfig", () => {
  it("returns null when either env var is missing (print-only default)", () => {
    expect(resolveLedgerIngestConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveLedgerIngestConfig({ LEDGER_INGEST_URL: "https://x" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveLedgerIngestConfig({ LEDGER_INGEST_KEY: "k" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns trimmed url+key when both are set", () => {
    const cfg = resolveLedgerIngestConfig({
      LEDGER_INGEST_URL: " https://ledger.example.com ",
      LEDGER_INGEST_KEY: " secret-key ",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ url: "https://ledger.example.com", key: "secret-key" });
  });
});

describe("ledger-report-client, countyNameForFips", () => {
  it("resolves Bastrop for 48021", () => {
    expect(countyNameForFips("48021")).toBe("Bastrop");
  });

  it("falls back to the fips itself for an unmapped fips", () => {
    expect(countyNameForFips("99999")).toBe("99999");
  });
});

describe("ledger-report-client, buildLedgerIngestBody", () => {
  const events: LedgerEvent[] = [
    { ts: "2026-08-03T00:00:00.000Z", fips: "48021", rowId: "Bastrop", defectClass: "ADAPTER-NEEDED" },
  ];
  const rowMirror: LedgerRowMirror[] = [
    { rowId: "Bastrop", fips: "48021", countyName: "Bastrop", status: "active", zoningRegime: "euclidean-zoned" },
  ];

  it("produces a minimal body with just sourceKind + events when nothing else is passed", () => {
    const body = buildLedgerIngestBody({ sourceKind: "preflight", events });
    expect(body).toEqual({ sourceKind: "preflight", events });
    expect(body).not.toHaveProperty("rowMirror");
    expect(body).not.toHaveProperty("certSummary");
    expect(body).not.toHaveProperty("gateSummary");
  });

  it("omits rowMirror when the array is empty (never sends an empty array)", () => {
    const body = buildLedgerIngestBody({ sourceKind: "preflight", events, rowMirror: [] });
    expect(body).not.toHaveProperty("rowMirror");
  });

  it("includes rowMirror, certSummary, gateSummary when provided", () => {
    const certSummary = {
      rowId: "Bastrop",
      fips: "48021",
      label: "7/7",
      blockPass: true,
      gradedAt: "2026-08-03T00:00:00.000Z",
    };
    const gateSummary = {
      rowId: "Bastrop",
      fips: "48021",
      passCount: 8,
      declineCount: 0,
      checks: [{ id: "railASourceReachable", outcome: "PASS" }],
    };
    const body = buildLedgerIngestBody({
      sourceKind: "cert-grade",
      events,
      rowMirror,
      certSummary,
      gateSummary,
    });
    expect(body.rowMirror).toEqual(rowMirror);
    expect(body.certSummary).toEqual(certSummary);
    expect(body.gateSummary).toEqual(gateSummary);
  });
});

describe("ledger-report-client, postLedgerIngest", () => {
  const config = { url: "https://ledger.example.com", key: "secret" };
  const body = buildLedgerIngestBody({ sourceKind: "preflight", events: [] });

  it("POSTs to {base}/api/onboarding-ledger/ingest with a Bearer header and JSON body (pinned contract)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://ledger.example.com/api/onboarding-ledger/ingest");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
      expect(JSON.parse(init.body as string)).toEqual(body);
      return new Response(null, { status: 200 });
    });
    const result = await postLedgerIngest(config, body, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("strips a trailing slash on the base url before appending the ingest path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://ledger.example.com/api/onboarding-ledger/ingest");
      return new Response(null, { status: 200 });
    });
    await postLedgerIngest({ url: "https://ledger.example.com/", key: "secret" }, body, fetchMock as unknown as typeof fetch);
  });

  it("returns ok:false with status + detail on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("bad row", { status: 422 }));
    const result = await postLedgerIngest(config, body, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.detail).toBe("bad row");
  });

  it("returns ok:false with status 0 when fetch throws (network error), never throws itself", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await postLedgerIngest(config, body, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });
});
