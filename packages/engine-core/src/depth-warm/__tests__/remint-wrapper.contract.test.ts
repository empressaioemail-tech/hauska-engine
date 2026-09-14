/**
 * P-186 (OPS-23 wave 6) — the WRAPPER contract, asserted against the two files
 * that make the apply leg possible: the job declaration and the runner.
 *
 * A wrapper can lie in ways no unit of its own code can catch:
 *
 *   1. the job declaration fails to set `PROPERTY_ATOM_PATH=1`. Then
 *      `writePropertyAtomIfEnabled` returns `null` and nothing is written. The
 *      runner's own FATAL is the defence, and it only holds while that FATAL is
 *      still there — so the FATAL is asserted here.
 *   2. the job's BAKED args are the apply leg. Then a bare
 *      `gcloud run jobs execute` fires a live in-place upsert with no deliberate
 *      act. The declaration below bakes the DRY LEG; this test fails if someone
 *      changes that, because the difference is not visible in a diff review.
 *   3. the runbook loses the rollback capture. There is no version or history
 *      table for property atoms, so that SELECT is the only rollback artifact
 *      that can exist.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const JOB_YAML = `${REPO_ROOT}cloudbuild.depth-warm-remint.yaml`;
const RUNBOOK = `${REPO_ROOT}RUNBOOK.depth-warm-remint.md`;
const RUNNER = `${REPO_ROOT}packages/engine-core/scripts/depth-warm-city-batch.mjs`;
const PREVIEW_MODULE = `${REPO_ROOT}packages/engine-core/src/depth-warm/remint-preview.ts`;

const yaml = readFileSync(JOB_YAML, "utf8");
const runbook = readFileSync(RUNBOOK, "utf8");
const runner = readFileSync(RUNNER, "utf8");
const previewModule = readFileSync(PREVIEW_MODULE, "utf8");

/**
 * The declaration minus its own commentary. The header comments deliberately
 * NAME the rejected cohort flags and the forbidden `gcloud run jobs update`, so
 * the negative assertions below must look at the executable lines only — a
 * comment explaining why a flag is forbidden is not the flag.
 */
const yamlCode = yaml
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("depth-warm re-mint wrapper — the job declaration", () => {
  it("sets PROPERTY_ATOM_PATH=1, so no execution has to remember it", () => {
    expect(yaml).toContain("PROPERTY_ATOM_PATH=1");
  });

  it("runs the bounded per-parcel arm of the depth-warm runner, not a cohort", () => {
    expect(yamlCode).toContain("scripts/depth-warm-city-batch.mjs");
    expect(yamlCode).toContain("--parcel=${_PARCEL}");
    expect(yamlCode).toContain("--row-id=${_ROW_ID}");
    // A cohort flag in this declaration would re-warm a whole cohort and, with
    // --force-overwrite, rewrite stored envelope geometry across it.
    expect(yamlCode).not.toContain("--city-cohort");
    expect(yamlCode).not.toContain("--force-overwrite");
  });

  it("bakes the DRY LEG as the default args — the apply leg is an explicit --args override", () => {
    const argsLine = yamlCode
      .split(/\r?\n/)
      .find((l) => l.includes("--args=") && l.includes("--row-id="));
    expect(argsLine).toBeDefined();
    expect(argsLine).toContain("--dry-run");
    expect(argsLine).toContain("--remint-preview");
    // If this ever contains --promote, a bare `gcloud run jobs execute` writes.
    expect(argsLine).not.toContain("--promote");
  });

  it("pins a digest rather than deploying a floating tag, and never updates a live template", () => {
    expect(yamlCode).toContain("--image=\"$$DIGEST\"");
    expect(yamlCode).toContain("*@sha256:*");
    expect(yamlCode).toContain("--set-secrets=");
    expect(yamlCode).not.toContain("gcloud run jobs update");
  });
});

describe("depth-warm re-mint wrapper — the runner's own guards", () => {
  it("FATALs on --promote without PROPERTY_ATOM_PATH, so an unset env cannot pass as success", () => {
    expect(runner).toContain("PROPERTY_ATOM_PATH=1 required for promote");
  });

  it("refuses --remint-preview without --parcel, and refuses it combined with --promote", () => {
    // The refusal is a pure function in the preview module (executable — see
    // `remint-preview.test.ts`) and the runner must actually apply it, exiting
    // non-zero before any store connection opens.
    expect(runner).toContain("remintPreviewRefusal({");
    expect(runner).toContain("process.exit(1)");
    expect(previewModule).toContain("--remint-preview requires --parcel");
    expect(previewModule).toContain("--remint-preview is a dry-leg flag and must not be combined with --promote");
  });
});

describe("depth-warm re-mint wrapper — the runbook's rollback artifact", () => {
  it("opens with the read-only capture of the live row and its content_hash", () => {
    expect(runbook).toContain("entity_type = 'setback-rule'");
    expect(runbook).toContain("COALESCE(body->>'status','active') = 'active'");
    expect(runbook).toContain("content_hash");
    expect(runbook).toMatch(/Rollback capture/i);
  });

  it("says there is no lease on this write and no history table to restore from", () => {
    expect(runbook).toMatch(/no version row and no history/i);
    expect(runbook).toMatch(/takes \*\*NO lease\*\*/);
  });
});
