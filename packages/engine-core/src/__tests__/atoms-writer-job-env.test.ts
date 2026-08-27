import { describe, it, expect } from "vitest";
import { requireWriterEnv } from "../../scripts/atoms-writer-job.mjs";

describe("atoms-writer-job env", () => {
  it("refuses a pooler host", () => {
    try {
      requireWriterEnv({
        SUBSTRATE_DATABASE_URL:
          "postgres://u@ep-lucky-truth-pooler.c-7.us-east-1.aws.neon.tech/hauska_mcp",
        CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex",
      });
      expect.fail("expected POOLER_HOST_REFUSED");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("POOLER_HOST_REFUSED");
    }
  });

  it("refuses a missing atoms URL", () => {
    try {
      requireWriterEnv({
        CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex",
      });
      expect.fail("expected MISSING_ENV");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("MISSING_ENV");
    }
  });
});
