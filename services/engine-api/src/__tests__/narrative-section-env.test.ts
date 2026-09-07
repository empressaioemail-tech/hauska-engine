import { describe, expect, it } from "vitest";

import { narrativeSectionFromEnv } from "../routes/parcel-terrain.js";

/**
 * P-120 item 6, deployment half.
 *
 * The failure this guards is a partially-configured deployment: one variable
 * set, the other missing, and the service quietly issuing unauthenticated
 * calls (or calls to nowhere) on every report. Both or neither.
 */
describe("narrativeSectionFromEnv", () => {
  const full = {
    BROKERAGE_API_BASE_URL: "https://api.example/api/brokerage/v1",
    SERVICE_API_KEY: "svc-key",
  } as NodeJS.ProcessEnv;

  it("returns config only when BOTH are set", () => {
    expect(narrativeSectionFromEnv(full)).toEqual({
      baseUrl: "https://api.example/api/brokerage/v1",
      apiKey: "svc-key",
    });
  });

  it("FAILS CLOSED on a half-configured deployment", () => {
    expect(narrativeSectionFromEnv({ BROKERAGE_API_BASE_URL: full.BROKERAGE_API_BASE_URL })).toBeUndefined();
    expect(narrativeSectionFromEnv({ SERVICE_API_KEY: full.SERVICE_API_KEY })).toBeUndefined();
    expect(narrativeSectionFromEnv({})).toBeUndefined();
  });

  it("treats whitespace-only values as unset, not as a key", () => {
    expect(
      narrativeSectionFromEnv({ ...full, SERVICE_API_KEY: "   " }),
    ).toBeUndefined();
    expect(
      narrativeSectionFromEnv({ ...full, BROKERAGE_API_BASE_URL: "  " }),
    ).toBeUndefined();
  });

  it("trims, so a trailing newline from a secret mount is not sent as part of the key", () => {
    // Real hazard: `--set-secrets` and shell pipelines both leave newlines.
    expect(narrativeSectionFromEnv({ ...full, SERVICE_API_KEY: "svc-key\n" })?.apiKey).toBe("svc-key");
  });
});
