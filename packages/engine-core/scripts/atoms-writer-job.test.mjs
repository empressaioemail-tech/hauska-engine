import { test } from "node:test";
import assert from "node:assert/strict";
import { requireWriterEnv } from "./atoms-writer-job.mjs";

test("writer env refuses a pooler host", () => {
  assert.throws(
    () =>
      requireWriterEnv({
        SUBSTRATE_DATABASE_URL: "postgres://u@ep-lucky-truth-pooler.c-7.us-east-1.aws.neon.tech/hauska_mcp",
        CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex",
      }),
    (err) => err.code === "POOLER_HOST_REFUSED",
  );
});

test("writer env refuses a missing atoms URL", () => {
  assert.throws(
    () => requireWriterEnv({ CORTEX_DATABASE_URL: "postgres://u@ep-source.example/cortex" }),
    (err) => err.code === "MISSING_ENV",
  );
});
