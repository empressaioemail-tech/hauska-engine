import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { looksLikeSlugSynthesizedHost } from "../catalogue.js";

const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("catalogue — no slug hostname synthesis", () => {
  it("documents slug-shaped host pattern without auto-generating URLs", () => {
    expect(looksLikeSlugSynthesizedHost("spring-tx", "https://gis.springtx.gov/arcgis/rest/services")).toBe(
      true,
    );
  });

  it("grep gate: no synthesizeHost / gis.${slug} construction in src", () => {
    const files = collectTsFiles(srcRoot);
    const violations: string[] = [];
    const patterns = [/synthesizeHostFrom/i, /synthesizeMunicipalHost/i, /buildHostFromCityKey/i];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
