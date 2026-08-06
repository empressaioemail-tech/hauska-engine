/**
 * bake-property-atom-county.mjs — --prop-ids-file scoped mode pins (T1 WS5).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(HERE, "../bake-property-atom-county.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

function parseArgs(argv: string[]) {
  const out = {
    county: null as string | null,
    limit: 0,
    offset: 0,
    batch: 500,
    spikePp: 40,
    dryRun: false,
    cascadeAbsenceOnly: false,
    rewordCityParcels: false,
    apply: false,
    citySegments: null as string | null,
    parcelMin: null as string | null,
    parcelMax: null as string | null,
    cascadeIdsOut: null as string | null,
    propIdsFile: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length);
    else if (a === "--prop-ids-file")
      out.propIdsFile = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--prop-ids-file="))
      out.propIdsFile = a.slice("--prop-ids-file=".length).trim() || null;
  }
  return out;
}

function normalizePropId(propId: string) {
  const t = String(propId ?? "").trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

function parsePropIdsFile(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("--prop-ids-file is empty (no usable lines)");
  }
  const ids = new Set<string>();
  for (const line of lines) {
    const afterColon = line.includes(":") ? line.split(":").pop()! : line;
    const trimmed = String(afterColon ?? "").trim();
    if (!trimmed) {
      throw new Error(`--prop-ids-file: unparseable line "${line}"`);
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `--prop-ids-file: line "${line}" is not a positive integer prop id`,
      );
    }
    ids.add(normalizePropId(trimmed));
  }
  return ids;
}

function placeKeysForPropIds(countyFips: string, propIds: Set<string>) {
  return [...propIds].map((id) => `node:${countyFips}:${id}`);
}

describe("bake-property-atom-county.mjs — prop-ids-file scoped mode (pinned)", () => {
  it("parses --prop-ids-file (flag and = forms)", () => {
    expect(
      parseArgs(["--county=48021", "--prop-ids-file", "P:/tmp/roster.txt"]),
    ).toEqual(
      expect.objectContaining({ propIdsFile: "P:/tmp/roster.txt" }),
    );
    expect(parseArgs(["--county=48021", "--prop-ids-file=P:/tmp/roster.txt"])).toEqual(
      expect.objectContaining({ propIdsFile: "P:/tmp/roster.txt" }),
    );
    expect(scriptSource).toContain('a === "--prop-ids-file"');
    expect(scriptSource).toContain('a.startsWith("--prop-ids-file=")');
  });

  it("script uses place_key = ANY for scoped cortex reads (not county prefix scan)", () => {
    expect(scriptSource).toContain("function placeKeysForPropIds(");
    expect(scriptSource).toContain("and place_key = ANY(${keys})");
    expect(scriptSource).toContain("scopedPlaceKeys");
  });

  it("reports scoped listSize / matched / notFoundInTier1 in ledger + done event", () => {
    expect(scriptSource).toContain("notFoundInTier1");
    expect(scriptSource).toContain("...(ledger.scoped ? { scoped: ledger.scoped } : {})");
  });
});

describe("parsePropIdsFile (bake-property-atom-county)", () => {
  it("parses raw ids, dedupes, ignores comments", () => {
    const ids = parsePropIdsFile("31131\n32634\n# comment\n31131\n");
    expect([...ids].sort()).toEqual(["31131", "32634"]);
  });

  it("strips county prefix from parcelNodeId lines", () => {
    const ids = parsePropIdsFile("48021:31131\n48021:32634\n");
    expect([...ids].sort()).toEqual(["31131", "32634"]);
  });

  it("builds cortex place_keys from county + prop ids", () => {
    const keys = placeKeysForPropIds("48021", new Set(["31131", "32634"]));
    expect(keys.sort()).toEqual(["node:48021:31131", "node:48021:32634"]);
  });

  it("fails loud on empty roster file", () => {
    expect(() => parsePropIdsFile("")).toThrow(/empty/i);
  });
});
