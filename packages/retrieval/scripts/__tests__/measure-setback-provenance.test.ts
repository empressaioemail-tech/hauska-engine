import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../measure-setback-provenance.mjs",
);

describe("measure-setback-provenance classifier", () => {
  it("self-test fails on side/rear placeholder fixtures and passes on layer-23", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/"selfTest":"pass"/);
    expect(out).toMatch(/fieldProvenance.side/);
    expect(out).toMatch(/fieldProvenance.rear/);
  });
});
