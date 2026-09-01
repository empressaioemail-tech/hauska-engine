import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNKED = join(HERE, "../measure-setback-provenance-chunked.mjs");
const BASE = join(HERE, "../measure-setback-provenance.mjs");

describe("chunked F1 runner", () => {
  it("self-test passes and keeps timeout at 15s", () => {
    const out = execFileSync(process.execPath, [CHUNKED, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/"selfTest":"pass"/);
    expect(out).toMatch(/"timeout":"15s"/);
    expect(out).toMatch(/"pageSize":8000/);
    expect(out).toMatch(/fieldProvenance.side/);
    expect(out).toMatch(/fieldProvenance.rear/);
  });

  it("does not narrow the base instrument", () => {
    const out = execFileSync(process.execPath, [BASE, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/"selfTest":"pass"/);
    expect(out).toMatch(/fieldProvenance.side/);
    expect(out).toMatch(/fieldProvenance.rear/);
  });
});
