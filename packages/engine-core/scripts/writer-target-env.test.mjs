import { describe, expect, it } from "vitest";
import {
  TARGET_ENV_MISSING,
  TARGET_UNKNOWN,
  assertKnownWriterTarget,
  resolveWriterTargetStores,
} from "./writer-target-env.mjs";

describe("writer-target-env (P-169)", () => {
  it("resolves the staging pair from STAGING_HAUSKA_MCP_URL / STAGING_NEONDB_URL", () => {
    const stores = resolveWriterTargetStores(
      {
        STAGING_HAUSKA_MCP_URL: "postgres://staging-atoms/db",
        STAGING_NEONDB_URL: "postgres://staging-source/db",
        PRODUCTION_HAUSKA_MCP_URL: "postgres://prod-atoms/db",
        PRODUCTION_NEONDB_URL: "postgres://prod-source/db",
      },
      "staging",
    );
    expect(stores).toEqual({
      target: "staging",
      DATABASE_URL: "postgres://staging-atoms/db",
      CORTEX_DATABASE_URL: "postgres://staging-source/db",
      varNames: { atoms: "STAGING_HAUSKA_MCP_URL", source: "STAGING_NEONDB_URL" },
    });
  });

  it("resolves the production pair and never crosses into staging (falsifier: a ?? fallback across targets)", () => {
    const stores = resolveWriterTargetStores(
      {
        STAGING_HAUSKA_MCP_URL: "postgres://staging-atoms/db",
        PRODUCTION_HAUSKA_MCP_URL: "postgres://prod-atoms/db",
        PRODUCTION_NEONDB_URL: "postgres://prod-source/db",
      },
      "production",
    );
    expect(stores.DATABASE_URL).toBe("postgres://prod-atoms/db");
    expect(stores.CORTEX_DATABASE_URL).toBe("postgres://prod-source/db");
  });

  it("a missing variable for the selected target refuses TARGET_ENV_MISSING naming it, not the other target's value", () => {
    try {
      resolveWriterTargetStores({ PRODUCTION_HAUSKA_MCP_URL: "x", PRODUCTION_NEONDB_URL: "y" }, "staging");
      expect.fail("expected TARGET_ENV_MISSING");
    } catch (err) {
      expect(err.code).toBe(TARGET_ENV_MISSING);
      expect(err.missing.sort()).toEqual(["STAGING_HAUSKA_MCP_URL", "STAGING_NEONDB_URL"].sort());
    }
  });

  it("refuses an unknown target", () => {
    expect(() => assertKnownWriterTarget("prod")).toThrow();
    try {
      assertKnownWriterTarget("prod");
    } catch (err) {
      expect(err.code).toBe(TARGET_UNKNOWN);
    }
  });
});
