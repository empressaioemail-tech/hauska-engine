import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WARDEN_SRC_DIR = join(HERE, "..");

/**
 * Module-name fragments that indicate an atom-write / storage-write helper.
 * Any src/warden/** import statement referencing one of these would violate
 * the files-never-fixes structural guarantee (the Warden reads and reports;
 * it never mints or persists an atom). Mirrors the repo's grep-source-text
 * precedent (property-reasoning/__tests__/cascade-unzoned-envelope-decline.test.ts)
 * but applied as an import-statement scan across a whole directory rather
 * than a single script's function body.
 */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "emit-zoning-fact",
  "emit-setback-rule",
  "emit-buildable-envelope",
  "emit-road-node",
  "emit-county-road-node",
  "emit-county-roadway-node",
  "emit-caldwell-cad-road-node",
  "bake-property-atom-county",
  "bake-property-atom-gold-set",
  "bake-property-atom-metro",
  "bake-from-tier1-snapshot",
  "cascade-unzoned-envelope-decline",
  "boundary-primitive/persist",
  "boundary-primitive/consume",
];

/** Recursively lists every .ts file under a directory, excluding __tests__ subdirectories. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Extracts every `import ... from "<spec>"` / `export ... from "<spec>"` module specifier in a file's source text. */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specifiers.push(m[1]!);
  }
  return specifiers;
}

describe("files-never-fixes structural guard — src/warden/** imports no atom-write / storage-write helper", () => {
  const sourceFiles = listSourceFiles(WARDEN_SRC_DIR);

  it("finds at least the expected warden source modules (sanity check the scan itself is not vacuous)", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(6);
    const basenames = sourceFiles.map((f) => f.replace(/\\/g, "/").split("/").pop());
    expect(basenames).toContain("types.ts");
    expect(basenames).toContain("neighbor-consistency.ts");
    expect(basenames).toContain("serve-path-truth.ts");
    expect(basenames).toContain("cross-store-consistency.ts");
    expect(basenames).toContain("cert-freshness.ts");
    expect(basenames).toContain("ledger-write.ts");
  });

  for (const file of listSourceFiles(WARDEN_SRC_DIR)) {
    const relName = file.replace(/\\/g, "/").split("/warden/").pop();
    it(`${relName} imports no atom-write / storage-write helper module`, () => {
      const source = readFileSync(file, "utf8");
      const specifiers = extractImportSpecifiers(source);
      for (const spec of specifiers) {
        for (const forbidden of FORBIDDEN_IMPORT_FRAGMENTS) {
          expect(
            spec.includes(forbidden),
            `${relName} imports "${spec}", which matches forbidden write-helper fragment "${forbidden}"`,
          ).toBe(false);
        }
      }
    });
  }

  it("the scripts/warden-sweep.mjs CLI also imports no atom-write / storage-write helper module", () => {
    const scriptPath = join(HERE, "../../../scripts/warden-sweep.mjs");
    const source = readFileSync(scriptPath, "utf8");
    const specifiers = extractImportSpecifiers(source);
    for (const spec of specifiers) {
      for (const forbidden of FORBIDDEN_IMPORT_FRAGMENTS) {
        expect(
          spec.includes(forbidden),
          `scripts/warden-sweep.mjs imports "${spec}", which matches forbidden write-helper fragment "${forbidden}"`,
        ).toBe(false);
      }
    }
  });
});
