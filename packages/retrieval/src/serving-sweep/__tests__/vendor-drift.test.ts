/**
 * VENDOR DRIFT — the vendored serving code must stay byte-identical to
 * hauska-map, apart from the import specifiers explicitly declared as rewritten.
 *
 * The sweep's whole claim is that it runs the REAL serving transforms. That
 * claim decays silently the moment someone edits a vendored file to make a
 * number come out differently, which is the most tempting edit available in
 * this directory. This test makes that edit fail loudly.
 *
 * It needs a hauska-map checkout to compare against. When one is not reachable
 * — CI runners for this repo do not clone the map repo — it SKIPS, and says so
 * in the test name rather than passing quietly. A guardrail that reports green
 * when it did not run is the fail-open shape DEV_PROCESS 2.2 exists to stop, so
 * the skip is visible and the local pre-push run is where this actually bites.
 *
 * Line endings are normalised before comparison: a Windows checkout stores CRLF
 * and the comparison is about CONTENT, not about `core.autocrlf`.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(here, "..", "vendor");

const MAP_ROOTS = [
  process.env.HAUSKA_MAP_ROOT,
  "P:/hauska-map",
  "/p/hauska-map",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const mapRoot = MAP_ROOTS.find((root) =>
  fs.existsSync(path.join(root, "apps", "property-explorer", "src", "lib", "baked-facets.ts")),
);

/** vendored file -> origin path under apps/property-explorer, and its allowed edits. */
const VENDORED: Array<{
  file: string;
  origin: string;
  /** Lines allowed to differ, as [vendored, original] pairs. */
  allowedRewrites: Array<[string, string]>;
}> = [
  {
    file: "setback-not-specified.ts",
    origin: "api/_lib/setback-not-specified.ts",
    allowedRewrites: [],
  },
  {
    file: "atom-chain-to-facets.ts",
    origin: "api/_lib/atom-chain-to-facets.ts",
    allowedRewrites: [],
  },
  {
    file: "buildable-display-vocab.ts",
    origin: "src/lib/buildable-display-vocab.ts",
    allowedRewrites: [],
  },
  {
    file: "buildable-envelope-types.d.ts",
    origin: "src/lib/buildable-envelope.d.ts",
    allowedRewrites: [],
  },
  {
    file: "baked-facets.ts",
    origin: "src/lib/baked-facets.ts",
    allowedRewrites: [
      [
        'import { formatSetbackDisplay } from "./setback-not-specified.js"; // VENDOR-PATH-REWRITE (was ../../api/_lib/setback-not-specified)',
        'import { formatSetbackDisplay } from "../../api/_lib/setback-not-specified";',
      ],
      [
        'import { mapBuildableDisplay } from "./buildable-display-vocab.js"; // VENDOR-PATH-REWRITE (extension added)',
        'import { mapBuildableDisplay } from "./buildable-display-vocab";',
      ],
      [
        '} from "./buildable-envelope-types.js"; // VENDOR-PATH-REWRITE (was ./buildable-envelope.js; the shim stays a .d.ts, verbatim)',
        '} from "./buildable-envelope.js";',
      ],
    ],
  },
];

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
}

describe("vendored serving code has not drifted", () => {
  it(
    mapRoot
      ? `compares against ${mapRoot}`
      : "SKIPPED — no hauska-map checkout reachable, so this control did NOT run",
    () => {
      if (!mapRoot) {
        expect(mapRoot).toBeUndefined();
        return;
      }
      const sha = fs
        .readFileSync(path.join(vendorDir, "VENDOR_SOURCE_SHA.txt"), "utf8")
        .trim();
      expect(sha, "VENDOR_SOURCE_SHA.txt must name a commit").toMatch(/^[0-9a-f]{40}$/);
    },
  );

  for (const v of VENDORED) {
    it(
      mapRoot
        ? `${v.file} is verbatim apart from ${v.allowedRewrites.length} declared rewrite(s)`
        : `${v.file} — SKIPPED, no hauska-map checkout`,
      () => {
        if (!mapRoot) return;
        const mine = lines(path.join(vendorDir, v.file));
        const theirs = lines(
          path.join(mapRoot, "apps", "property-explorer", ...v.origin.split("/")),
        );
        expect(mine.length, "line count changed").toBe(theirs.length);

        const rewrites = new Map(v.allowedRewrites);
        const unexplained: Array<{ line: number; mine: string; theirs: string }> = [];
        for (let i = 0; i < mine.length; i++) {
          const a = mine[i] ?? "";
          const b = theirs[i] ?? "";
          if (a === b) continue;
          if (rewrites.get(a) === b) continue;
          unexplained.push({ line: i + 1, mine: a, theirs: b });
        }
        expect(
          unexplained,
          `undeclared edits to vendored serving code in ${v.file}`,
        ).toEqual([]);
      },
    );
  }
});
