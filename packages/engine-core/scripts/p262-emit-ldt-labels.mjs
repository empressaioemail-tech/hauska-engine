#!/usr/bin/env node
/**
 * P-262 item 4 — emit the OTHER implementation's answer for the divergence
 * fixture set.
 *
 * The two labellers are independent implementations in two repos: this repo's
 * `packages/engine-core/src/depth-warm/edgeLabeling.ts` and legacy-design-tools'
 * `artifacts/api-server/src/lib/buildableEnvelope/edgeLabeling.ts` (repo
 * `hauska-engine` and `legacy-design-tools` respectively; there is no package
 * dependency between them, so neither can import the other). P-282's shared
 * harness does not exist yet; until it does, this script is what keeps the pair
 * honest:
 *
 *   1. it dumps THIS repo's fixture inputs (the rings, situs strings and road
 *      centerlines the fixtures in src/depth-warm/fixtures already carry),
 *   2. bundles LDT's labeller from an LDT checkout with the repo's own esbuild,
 *   3. runs LDT's own `labelEdges` on those inputs and writes
 *      src/depth-warm/fixtures/p262LdtLabelPin.json with provenance (LDT
 *      commit, LDT file hashes, the exact command), so
 *      __tests__/p262-labeller-divergence.test.ts compares the two paths on the
 *      same fixtures and fails on disagreement.
 *
 * Run:
 *   node packages/engine-core/scripts/p262-emit-ldt-labels.mjs \
 *     --ldt P:/tmp/legacy-design-tools
 *
 * The LDT checkout must be at the commit the pin names. Re-running this script
 * REWRITES the pin, so the diff it produces IS the reviewable record of what
 * the other path now says; `declaredDifferences[].reason` annotations are
 * dropped by a regeneration and must be re-authored (the divergence test fails
 * on an unexplained difference, by design).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_CORE = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(ENGINE_CORE, "..", "..");
const PIN_PATH = path.join(ENGINE_CORE, "src", "depth-warm", "fixtures", "p262LdtLabelPin.json");
const STUB = path.join(HERE, "p262-ldt-polygon-clipping-stub.mjs");
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Where the pin is written: --out <path>, else the checked-in pin. */
const OUT_PATH = path.resolve(argValue("--out") ?? PIN_PATH);

const ldtRoot = path.resolve(
  argValue("--ldt") ?? process.env.P262_LDT_CHECKOUT ?? "P:/tmp/legacy-design-tools",
);
if (!fs.existsSync(ldtRoot)) {
  console.error(
    `LDT checkout not found at ${ldtRoot}. Pass --ldt <path> or set P262_LDT_CHECKOUT.`,
  );
  process.exit(2);
}

/* ------------------------------- esbuild --------------------------------- */
const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  const candidates = fs.existsSync(pnpmDir)
    ? fs
        .readdirSync(pnpmDir)
        .filter((d) => d.startsWith("esbuild@"))
        .map((d) => path.join(pnpmDir, d, "node_modules", "esbuild"))
    : [];
  const found = candidates.find((c) => {
    try {
      require.resolve(path.join(c, "package.json"));
      return true;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error("esbuild not found in this repo's node_modules");
  esbuild = require(found);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p262-ldt-pin-"));

async function bundle(entry, { aliasPolygonClipping = false, external = [] } = {}) {
  const outfile = path.join(tmpDir, `${path.basename(entry).replace(/\W/g, "_")}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    ...(aliasPolygonClipping ? { alias: { "polygon-clipping": STUB } } : {}),
    ...(external.length ? { external } : {}),
  });
  return outfile;
}

/* --------------------- this repo's fixture inputs ------------------------- */
async function fixtureInputs() {
  const fixtures = ["p262Parcels.ts", "p262CurvedFrontage.ts"];
  const mods = {};
  for (const f of fixtures) {
    const entry = path.join(ENGINE_CORE, "src", "depth-warm", "fixtures", f);
    const out = await bundle(entry, { external: ["@hauska-engine/atoms"] });
    mods[f] = await import(pathToFileURL(out).href);
  }
  const roads = (rs) =>
    rs.map((r) => ({
      name: r.name ?? null,
      osmWayId: r.osmWayId ?? null,
      classification: r.classification ?? null,
      polyline: r.polyline,
    }));
  const p = mods["p262Parcels.ts"];
  const c = mods["p262CurvedFrontage.ts"];
  return [
    {
      id: "48209:97658",
      what: "dispatch parcel, San Marcos (Hays) — nine-edge county ring with three artifact runs",
      situsAddress: p.SITUS_48209_97658,
      ring: p.PARCEL_48209_97658_SAN_MARCOS,
      roads: roads(p.ROADS_AROUND_48209_97658),
    },
    {
      id: "48453:427599",
      what: "control parcel, Pflugerville (Travis) — four edges, every internal turn 89.4-95.0 degrees",
      situsAddress: p.SITUS_48453_427599,
      ring: p.PARCEL_48453_427599_PFLUGERVILLE,
      roads: roads(p.ROADS_AROUND_48453_427599),
    },
    {
      id: "324-knockout-rose",
      what: "curved FRONTAGE, San Marcos (Hays) — the curve is the street frontage",
      situsAddress: c.SITUS_324_KNOCKOUT_ROSE,
      ring: c.PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
      roads: roads(c.ROADS_AROUND_KNOCKOUT_ROSE),
    },
    {
      id: "312-knockout-rose",
      what: "negative control, San Marcos (Hays) — a curve at the BACK of the lot, 41.8-45.8 m off the street",
      situsAddress: c.SITUS_312_KNOCKOUT_ROSE,
      ring: c.PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
      roads: roads(c.ROADS_AROUND_KNOCKOUT_ROSE),
    },
  ];
}

/* ------------------------- LDT's own labeller ----------------------------- */
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ldtCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function ldtLabels(inputs) {
  const labellerDir = path.join(
    ldtRoot,
    "artifacts",
    "api-server",
    "src",
    "lib",
    "buildableEnvelope",
  );
  const files = ["edgeLabeling.ts", "geometry.ts", "roadClassSetbacks.ts", "roadClassify.ts"].filter(
    (f) => fs.existsSync(path.join(labellerDir, f)),
  );
  const bundlePath = await bundle(path.join(labellerDir, "edgeLabeling.ts"), {
    aliasPolygonClipping: true,
  });
  const ldt = await import(pathToFileURL(bundlePath).href);
  const labels = {};
  for (const c of inputs) {
    const res = ldt.labelEdges({
      ring: c.ring,
      roads: c.roads.map((r) => ({ name: r.name, polyline: r.polyline })),
      situsAddress: c.situsAddress,
    });
    labels[c.id] = res
      ? {
          signal: res.signal,
          confidence: res.confidence,
          note: res.note,
          edges: res.edges.map((e) => [e.index, e.label]),
        }
      : null;
  }
  return { labels, files, labellerDir };
}

/* ---------------------------------- main ---------------------------------- */
const inputs = await fixtureInputs();
const ldt = await ldtLabels(inputs);

const pin = {
  $comment:
    "GENERATED by packages/engine-core/scripts/p262-emit-ldt-labels.mjs — do not hand-edit the " +
    "LDT numbers; re-run the script against an LDT checkout at a named commit. " +
    "declaredDifferences[].reason IS hand-authored: the divergence test fails on a difference " +
    "whose reason is null, so a regeneration forces each difference to be re-explained.",
  pinVersion: 1,
  method:
    "legacy-design-tools' own labelEdges (artifacts/api-server/src/lib/buildableEnvelope/edgeLabeling.ts) " +
    "bundled with this repo's esbuild and run over this repo's fixture inputs (rings, situs strings " +
    "and road centerlines from src/depth-warm/fixtures/p262Parcels.ts and p262CurvedFrontage.ts). " +
    "polygon-clipping is aliased to scripts/p262-ldt-polygon-clipping-stub.mjs because LDT's " +
    "geometry.ts imports it at module scope while labelEdges never calls it.",
  regenerationCommand:
    "node packages/engine-core/scripts/p262-emit-ldt-labels.mjs --ldt <legacy-design-tools checkout>",
  otherPath: {
    repo: "legacy-design-tools",
    commit: ldtCommit(ldtRoot),
    checkoutAtGeneration: ldtRoot,
    labellerDir: ldt.labellerDir,
    files: Object.fromEntries(ldt.files.map((f) => [f, sha256(path.join(ldt.labellerDir, f))])),
  },
  comparisonContract: {
    equalityOn: ["48453:427599"],
    containmentOn: ["48209:97658", "324-knockout-rose", "312-knockout-rose"],
    unexplainedDifferenceFails: true,
  },
  fixtures: inputs.map((c) => ({
    id: c.id,
    what: c.what,
    situsAddress: c.situsAddress,
    edges: c.ring.length - 1,
    roads: c.roads.map((r) => r.name),
    ldt: ldt.labels[c.id],
  })),
  declaredDifferences: [],
};

fs.writeFileSync(OUT_PATH, JSON.stringify(pin, null, 1) + "\n");
console.log(`wrote ${OUT_PATH}`);
console.log(`LDT commit ${pin.otherPath.commit} at ${ldtRoot}`);
for (const f of pin.fixtures) {
  console.log(`  ${f.id}: ${f.ldt ? JSON.stringify(f.ldt.edges) : "NULL labelling"}`);
}
fs.rmSync(tmpDir, { recursive: true, force: true });
