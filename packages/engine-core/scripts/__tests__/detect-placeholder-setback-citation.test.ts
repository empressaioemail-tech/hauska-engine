import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectsPlaceholderSetbackCitation,
  scanRepoForPlaceholderSetbackCitations,
} from "../detect-placeholder-setback-citation.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../detect-placeholder-setback-citation.mjs",
);

const PLACEHOLDER = "storage-port-proof/phase-1a";

describe("detect-placeholder-setback-citation CI check", () => {
  it("fails on a deliberate setback-rule citation and passes on Gate A / layer-23", () => {
    expect(
      detectsPlaceholderSetbackCitation(
        `atomDid: "did:hauska:code-section:${PLACEHOLDER}"`,
      ),
    ).toBe(true);
    expect(
      detectsPlaceholderSetbackCitation(
        `atomDid: "did:hauska:code-section:bdc:14.02.003"`,
      ),
    ).toBe(false);
    expect(
      detectsPlaceholderSetbackCitation(
        `export const STORAGE_PORT_PROOF_ATOM_DID = "did:hauska:code-section:${PLACEHOLDER}";`,
      ),
    ).toBe(false);

    const poisonRoot = mkdtempSync(join(tmpdir(), "p4-poison-"));
    mkdirSync(join(poisonRoot, "packages", "engine-core", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(poisonRoot, "packages", "engine-core", "src", "poison.ts"),
      `export const rule = { atomDid: "did:hauska:code-section:${PLACEHOLDER}" };\n`,
    );
    const poisonHits = scanRepoForPlaceholderSetbackCitations(poisonRoot);
    expect(poisonHits.some((h) => h.endsWith("poison.ts"))).toBe(true);

    const cleanHits = scanRepoForPlaceholderSetbackCitations();
    expect(cleanHits).toEqual([]);

    const out = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(out).toMatch(/clean/);
  });
});
