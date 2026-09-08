import { defineConfig } from "vitest/config";

/**
 * This package's tests are integration-shaped: many of them generate REAL
 * PDF, DXF and IFC bytes, embedding four unsubsetted Barlow faces per
 * document. Several legitimately run 4-5 seconds, which sat directly against
 * vitest's 5-second default — so whether the suite went green depended on how
 * much else the machine happened to be doing, and adding any new test file
 * tipped unrelated tests over.
 *
 * A suite that passes or fails on machine load is not measuring the code. The
 * timeout is raised to a value no honest test should reach; a test that hits
 * 30 seconds is hung, not slow, and should still fail.
 *
 * This weakens no assertion. Every correctness check in the package is
 * unchanged — only the wall-clock ceiling moved, and it moved because the old
 * ceiling was measuring the wrong thing.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
