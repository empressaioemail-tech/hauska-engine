/**
 * bake-property-atom-county.mjs — cascade keyspace sharding pins (T5, 2026-08-05).
 *
 * The CLI script cannot be imported directly (top-level side effects). This
 * file re-declares the pure helpers and pins the script source for arg parsing,
 * default batch, summary fields, and SQL shard bounds.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(HERE, "../bake-property-atom-county.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

/** Matches bake-property-atom-county.mjs parseArgs (pure subset). */
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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--county") out.county = String(argv[++i] || "").trim();
    else if (a.startsWith("--county=")) out.county = a.slice("--county=".length);
    else if (a === "--limit") out.limit = Number(argv[++i] || 0);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
    else if (a === "--offset") out.offset = Number(argv[++i] || 0);
    else if (a.startsWith("--offset=")) out.offset = Number(a.slice("--offset=".length));
    else if (a === "--batch") out.batch = Number(argv[++i] || 500);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice("--batch=".length));
    else if (a === "--spike-pp") out.spikePp = Number(argv[++i] || 40);
    else if (a.startsWith("--spike-pp="))
      out.spikePp = Number(a.slice("--spike-pp=".length));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--cascade-absence-only") out.cascadeAbsenceOnly = true;
    else if (a === "--reword-city-parcels") out.rewordCityParcels = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--city-segments")
      out.citySegments = String(argv[++i] || "");
    else if (a.startsWith("--city-segments="))
      out.citySegments = a.slice("--city-segments=".length);
    else if (a === "--parcel-min")
      out.parcelMin = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--parcel-min="))
      out.parcelMin = a.slice("--parcel-min=".length).trim() || null;
    else if (a === "--parcel-max")
      out.parcelMax = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--parcel-max="))
      out.parcelMax = a.slice("--parcel-max=".length).trim() || null;
    else if (a === "--cascade-ids-out")
      out.cascadeIdsOut = String(argv[++i] || "").trim() || null;
    else if (a.startsWith("--cascade-ids-out="))
      out.cascadeIdsOut = a.slice("--cascade-ids-out=".length).trim() || null;
  }
  return out;
}

function deriveShardId(parcelMin: string | null, parcelMax: string | null) {
  if (!parcelMin && !parcelMax) return "full";
  const lo = parcelMin ?? "";
  const hi = parcelMax ?? "";
  return `${lo}..${hi}`;
}

/** Mock postgres.js tagged template for cascadeKeyspaceBoundsSql shape tests. */
function mockSql(strings: TemplateStringsArray, ...values: unknown[]) {
  return { strings: [...strings], values };
}
mockSql.unsafe = (s: string) => s;

function cascadeKeyspaceBoundsSql(
  sql: typeof mockSql,
  parcelMin: string | null,
  parcelMax: string | null,
) {
  return sql`
    ${parcelMin ? sql`AND body->>'parcelNodeId' >= ${parcelMin}` : sql``}
    ${parcelMax ? sql`AND body->>'parcelNodeId' <= ${parcelMax}` : sql``}
  `;
}

describe("bake-property-atom-county.mjs — cascade keyspace sharding (pinned)", () => {
  it("default batch is 500 for county-scale runs", () => {
    expect(parseArgs([]).batch).toBe(500);
    expect(scriptSource).toContain("batch: 500");
    expect(scriptSource).not.toMatch(/batch: 200,/);
  });

  it("parses --parcel-min and --parcel-max (flag and = forms)", () => {
    expect(
      parseArgs([
        "--county=48309",
        "--parcel-min",
        "48309:0",
        "--parcel-max=48309:999999999",
      ]),
    ).toEqual(
      expect.objectContaining({
        parcelMin: "48309:0",
        parcelMax: "48309:999999999",
      }),
    );
    expect(scriptSource).toContain('a === "--parcel-min"');
    expect(scriptSource).toContain('a.startsWith("--parcel-min=")');
    expect(scriptSource).toContain('a === "--parcel-max"');
    expect(scriptSource).toContain('a.startsWith("--parcel-max=")');
  });

  it("deriveShardId labels full vs bounded keyspaces", () => {
    expect(deriveShardId(null, null)).toBe("full");
    expect(deriveShardId("48309:0", "48309:249999999")).toBe(
      "48309:0..48309:249999999",
    );
    expect(deriveShardId("48309:0", null)).toBe("48309:0..");
    expect(scriptSource).toContain("function deriveShardId(");
    expect(scriptSource).toContain('shardId');
    expect(scriptSource).toContain("...(args.parcelMin ? { parcelMin: args.parcelMin } : {})");
  });

  it("runCascadeAbsenceOnly SQL includes optional >= parcelMin and <= parcelMax bounds", () => {
    expect(scriptSource).toContain("function cascadeKeyspaceBoundsSql(");
    expect(scriptSource).toContain("body->>'parcelNodeId' >= ${parcelMin}");
    expect(scriptSource).toContain("body->>'parcelNodeId' <= ${parcelMax}");
    expect(scriptSource).toContain(
      "cascadeKeyspaceBoundsSql(sql, args.parcelMin, args.parcelMax)",
    );
  });

  it("pageSize cap remains 500", () => {
    expect(scriptSource).toMatch(/Math\.min\(args\.batch, 500\)/);
  });
});

describe("cascadeKeyspaceBoundsSql (mock sql fragment composition)", () => {
  it("emits no parcel bound values when min/max unset", () => {
    const frag = cascadeKeyspaceBoundsSql(mockSql, null, null);
    const parcelBounds = frag.values.filter(
      (v) => typeof v === "string" && v.includes("48309"),
    );
    expect(parcelBounds).toHaveLength(0);
  });

  it("emits lower bound fragment when parcelMin set", () => {
    const frag = cascadeKeyspaceBoundsSql(mockSql, "48309:0", null);
    const boundFrag = frag.values.find(
      (v) =>
        v &&
        typeof v === "object" &&
        "values" in v &&
        (v as { values: unknown[] }).values.includes("48309:0"),
    );
    expect(boundFrag).toBeDefined();
  });

  it("emits both bounds when min and max set", () => {
    const frag = cascadeKeyspaceBoundsSql(
      mockSql,
      "48309:0",
      "48309:249999999",
    );
    const nested = frag.values.filter((v) => v && typeof v === "object");
    expect(nested.length).toBe(2);
  });
});
