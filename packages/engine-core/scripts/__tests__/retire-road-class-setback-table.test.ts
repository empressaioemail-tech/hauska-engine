import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectsRetiredSetbackWrite,
  scanRepoForRetiredWrites,
} from "../retire-road-class-setback-table.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../retire-road-class-setback-table.mjs",
);

describe("retire-road-class-setback-table CI check", () => {
  it("fails on a deliberate reintroduction and passes on a clean tree", () => {
    expect(
      detectsRetiredSetbackWrite(
        `provenance: "road-class-setback-table"`,
      ),
    ).toBe(true);
    expect(
      detectsRetiredSetbackWrite(`provenance: "district-setback-table"`),
    ).toBe(false);

    const poisonRoot = mkdtempSync(join(tmpdir(), "f11-poison-"));
    mkdirSync(join(poisonRoot, "packages", "engine-core", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(poisonRoot, "packages", "engine-core", "src", "poison.ts"),
      `export const setback = { feet: 15, provenance: "road-class-setback-table" };\n`,
    );
    const poisonHits = scanRepoForRetiredWrites(poisonRoot);
    expect(poisonHits.some((h) => h.endsWith("poison.ts"))).toBe(true);

    const cleanHits = scanRepoForRetiredWrites();
    expect(cleanHits).toEqual([]);

    const out = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(out).toMatch(/clean/);
  });
});
