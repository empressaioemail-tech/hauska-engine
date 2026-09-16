/**
 * P-262 item 4 — DIVERGENCE TEST for the two edge labellers.
 *
 * THE PAIR. Two independent implementations at two repos, with no package
 * dependency between them (neither can import the other):
 *
 *   engine  — packages/engine-core/src/depth-warm/edgeLabeling.ts (this repo)
 *   LDT     — legacy-design-tools
 *             artifacts/api-server/src/lib/buildableEnvelope/edgeLabeling.ts
 *
 * P-282's shared harness (one fixture set through both sides of a pair) does not
 * exist yet, so this is the plain fixture test the dispatch allows. What makes it
 * a divergence test rather than a golden file:
 *
 *   - the LDT numbers are not transcribed by hand. They are produced by running
 *     LDT's OWN `labelEdges` over THIS repo's fixture inputs, by
 *     packages/engine-core/scripts/p262-emit-ldt-labels.mjs, whose output
 *     (fixtures/p262LdtLabelPin.json) names the LDT commit, the sha256 of every
 *     LDT file the bundle consumed and the exact regeneration command;
 *   - the comparison is EXHAUSTIVE both ways: every edge of every fixture is
 *     compared, a difference that is not in the pin's declaredDifferences list
 *     FAILS ("unexplained divergence"), and a declared difference that no longer
 *     differs also FAILS (so an entry cannot rot into a hiding place);
 *   - the pin cannot drift away from the other path unnoticed: when an LDT
 *     checkout is present, this test RE-RUNS LDT's labeller from source and
 *     requires the labels it produces to equal the pin. A checkout is skipped
 *     with a printed reason when absent (CI has none), so the engine side is
 *     always live and the LDT side is live wherever LDT is checked out.
 *
 * The pin as of 2026-09-16 (LDT b1ef76de): 14 differences, every one of them
 * explained. 48453:427599 is IDENTICAL in both paths — the control parcel, and
 * the reason it is the control: every internal turn measures 89.4-95.0 degrees,
 * so its ring has no artifact run for the two paths to group differently.
 *
 * WHAT THIS DOES NOT CLAIM. It compares per-edge ROLES only: not setbacks, not
 * envelopes, not LDT's confidence or corner disclosure. Those live on LDT's side
 * of the pair and are P-249's and P-282's to pin.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { labelEdgesFromRoads } from "../edgeLabeling.js";
import {
  PARCEL_48209_97658_SAN_MARCOS,
  PARCEL_48453_427599_PFLUGERVILLE,
  ROADS_AROUND_48209_97658,
  ROADS_AROUND_48453_427599,
  SITUS_48209_97658,
  SITUS_48453_427599,
} from "../fixtures/p262Parcels.js";
import {
  PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
  PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
  ROADS_AROUND_KNOCKOUT_ROSE,
  SITUS_312_KNOCKOUT_ROSE,
  SITUS_324_KNOCKOUT_ROSE,
} from "../fixtures/p262CurvedFrontage.js";
import type { Ring } from "../geometry.js";
import type { WarmEdgeRole, WarmRoadSource } from "../types.js";

interface LdtEdgeLabel {
  signal: string;
  confidence: number;
  note: string;
  edges: Array<[number, string]>;
}

interface Pin {
  pinVersion: number;
  regenerationCommand: string;
  otherPath: {
    repo: string;
    commit: string | null;
    checkoutAtGeneration: string;
    labellerDir: string;
    files: Record<string, string>;
  };
  comparisonContract: {
    equalityOn: string[];
    containmentOn: string[];
    unexplainedDifferenceFails: boolean;
  };
  fixtures: Array<{
    id: string;
    what: string;
    situsAddress: string;
    edges: number;
    roads: string[];
    ldt: LdtEdgeLabel | null;
  }>;
  declaredDifferences: Array<{
    fixture: string;
    edgeIndex: number;
    engine: WarmEdgeRole;
    ldt: WarmEdgeRole | null;
    class: string | null;
    reason: string | null;
  }>;
}

const PIN: Pin = JSON.parse(
  fs.readFileSync(new URL("../fixtures/p262LdtLabelPin.json", import.meta.url), "utf8"),
);

/** The same fixtures the emitter fed to LDT, from this repo's fixture modules. */
const CASES: Array<{
  id: string;
  ring: Ring;
  situsAddress: string;
  roads: ReadonlyArray<WarmRoadSource>;
}> = [
  {
    id: "48209:97658",
    ring: PARCEL_48209_97658_SAN_MARCOS,
    situsAddress: SITUS_48209_97658,
    roads: ROADS_AROUND_48209_97658,
  },
  {
    id: "48453:427599",
    ring: PARCEL_48453_427599_PFLUGERVILLE,
    situsAddress: SITUS_48453_427599,
    roads: ROADS_AROUND_48453_427599,
  },
  {
    id: "324-knockout-rose",
    ring: PARCEL_324_KNOCKOUT_ROSE_SAN_MARCOS,
    situsAddress: SITUS_324_KNOCKOUT_ROSE,
    roads: ROADS_AROUND_KNOCKOUT_ROSE,
  },
  {
    id: "312-knockout-rose",
    ring: PARCEL_312_KNOCKOUT_ROSE_SAN_MARCOS,
    situsAddress: SITUS_312_KNOCKOUT_ROSE,
    roads: ROADS_AROUND_KNOCKOUT_ROSE,
  },
];

function engineLabels(testCase: (typeof CASES)[number]): WarmEdgeRole[] {
  const res = labelEdgesFromRoads({
    parcelRing: testCase.ring,
    roads: testCase.roads,
    situsAddress: testCase.situsAddress,
  });
  if (!res.ok) throw new Error(`${testCase.id} declined: ${res.decline}`);
  return res.edgeLabels.map((e) => e.label);
}

function pinLabels(fixtureId: string): WarmEdgeRole[] {
  const fixture = PIN.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) throw new Error(`fixture ${fixtureId} is not in the pin`);
  if (!fixture.ldt) throw new Error(`${fixtureId}: the pin records NO labelling from the other path`);
  const byIndex = new Map(fixture.ldt.edges);
  return Array.from({ length: fixture.edges }, (_, i) => (byIndex.get(i) ?? "side") as WarmEdgeRole);
}

/* ------------------- the other path, run from source when present --------- */

/** LDT checkout to re-run against: --ldt / P262_LDT_CHECKOUT, else the pin's path. */
function ldtCheckout(): { root: string; reason?: string } {
  const candidates = [process.env.P262_LDT_CHECKOUT, PIN.otherPath.checkoutAtGeneration].filter(
    (v): v is string => Boolean(v),
  );
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "artifacts", "api-server", "src", "lib", "buildableEnvelope"))) {
      return { root: c };
    }
  }
  return {
    root: "",
    reason:
      `no legacy-design-tools checkout found (tried ${candidates.join(", ")}; set ` +
      `P262_LDT_CHECKOUT) — the LDT side of this pair is pinned, not live, in this run`,
  };
}

/**
 * Run LDT's own labeller from source. Mirrors
 * scripts/p262-emit-ldt-labels.mjs: esbuild bundle of LDT's edgeLabeling.ts with
 * polygon-clipping aliased to the committed stub (labelEdges never calls it).
 */
async function ldtLabelsFromSource(root: string): Promise<Map<string, WarmEdgeRole[]>> {
  const scriptPath = path.resolve(
    fileURLToPath(new URL("../../../scripts/p262-emit-ldt-labels.mjs", import.meta.url)),
  );
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p262-live-")), "labels.json");
  execFileSync(process.execPath, [scriptPath, "--ldt", root, "--out", out], {
    stdio: "pipe",
    encoding: "utf8",
  });
  const written: Pin = JSON.parse(fs.readFileSync(out, "utf8"));
  const map = new Map<string, WarmEdgeRole[]>();
  for (const f of written.fixtures) {
    if (!f.ldt) throw new Error(`${f.id}: live LDT run returned no labelling`);
    map.set(f.id, f.ldt.edges.map(([, label]) => label as WarmEdgeRole));
  }
  return map;
}

describe("P-262 item 4 — the two labellers agree on the shared fixtures", () => {
  it("the pin names the other path, its commit and its file hashes", () => {
    expect(PIN.otherPath.repo).toBe("legacy-design-tools");
    expect(PIN.otherPath.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(PIN.otherPath.files).length).toBeGreaterThanOrEqual(2);
    expect(PIN.regenerationCommand).toContain("p262-emit-ldt-labels.mjs");
    expect(PIN.comparisonContract.unexplainedDifferenceFails).toBe(true);
    // Every fixture in this test must be in the pin, with the same edge count.
    for (const c of CASES) {
      const fixture = PIN.fixtures.find((f) => f.id === c.id);
      expect(fixture, `${c.id} missing from the pin`).toBeTruthy();
      expect(fixture!.edges).toBe(c.ring.length - 1);
    }
  });

  it("every declared difference is explained and still differs", () => {
    const unexplained = PIN.declaredDifferences.filter((d) => !d.reason || !d.class);
    expect(
      unexplained.map((d) => `${d.fixture}#${d.edgeIndex}`),
      "a difference between the two paths has no recorded reason — explain it or fix it",
    ).toEqual([]);

    const stale: string[] = [];
    for (const d of PIN.declaredDifferences) {
      const testCase = CASES.find((c) => c.id === d.fixture);
      expect(testCase, `${d.fixture} not in this test`).toBeTruthy();
      const engine = engineLabels(testCase!)[d.edgeIndex];
      const ldt = pinLabels(d.fixture)[d.edgeIndex];
      if (engine === ldt) stale.push(`${d.fixture}#${d.edgeIndex} (both now ${engine})`);
      else if (engine !== d.engine || ldt !== d.ldt)
        stale.push(
          `${d.fixture}#${d.edgeIndex} declared ${d.engine}/${d.ldt}, measured ${engine}/${ldt}`,
        );
    }
    expect(stale, "a declared difference no longer matches: re-run the emitter and re-annotate").toEqual(
      [],
    );
  });

  it("differs from the other path ONLY where the pin declares it", () => {
    const undeclared: string[] = [];
    for (const c of CASES) {
      const engine = engineLabels(c);
      const ldt = pinLabels(c.id);
      const declared = new Set(
        PIN.declaredDifferences.filter((d) => d.fixture === c.id).map((d) => d.edgeIndex),
      );
      expect(engine.length).toBe(ldt.length);
      for (let i = 0; i < engine.length; i++) {
        if (engine[i] === ldt[i]) continue;
        if (!declared.has(i)) undeclared.push(`${c.id}#${i} engine=${engine[i]} ldt=${ldt[i]}`);
      }
      for (const index of declared) {
        if (engine[index] === ldt[index]) {
          undeclared.push(`${c.id}#${index} declared a difference but the two paths agree`);
        }
      }
    }
    expect(
      undeclared,
      "unexplained divergence between the engine labeller and LDT's labeller",
    ).toEqual([]);
  });

  it("48453:427599 — the control — is identical edge for edge", () => {
    for (const id of PIN.comparisonContract.equalityOn) {
      const testCase = CASES.find((c) => c.id === id)!;
      expect({ id, labels: engineLabels(testCase) }).toEqual({ id, labels: pinLabels(id) });
    }
  });

  it("every front the other path claims is a front here too", () => {
    for (const id of PIN.comparisonContract.containmentOn) {
      const testCase = CASES.find((c) => c.id === id)!;
      const engine = engineLabels(testCase);
      const ldt = pinLabels(id);
      const missed = ldt
        .map((label, index) => (label === "front" && engine[index] !== "front" ? index : -1))
        .filter((i) => i >= 0);
      const engineFronts = engine.filter((l) => l === "front").length;
      const ldtFronts = ldt.filter((l) => l === "front").length;
      expect(missed, `${id}: the engine does not cover LDT's front edge(s)`).toEqual([]);
      expect(engineFronts).toBeGreaterThanOrEqual(ldtFronts);
    }
  });

  it("the pin still matches the other path run from source", async () => {
    const { root, reason } = ldtCheckout();
    if (!root) {
      console.log(`[p262 divergence] SKIPPED live LDT leg: ${reason}`);
      return;
    }
    const liveFiles = Object.entries(PIN.otherPath.files);
    const drifted = liveFiles.filter(([file, sha]) => {
      const p = path.join(root, "artifacts", "api-server", "src", "lib", "buildableEnvelope", file);
      if (!fs.existsSync(p)) return true;
      return createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== sha;
    });
    const live = await ldtLabelsFromSource(root);
    const disagreements: string[] = [];
    for (const c of CASES) {
      const liveLabels = live.get(c.id);
      if (!liveLabels) {
        disagreements.push(`${c.id}: live LDT run produced no labelling`);
        continue;
      }
      const pinned = pinLabels(c.id);
      for (let i = 0; i < pinned.length; i++) {
        if (pinned[i] !== liveLabels[i])
          disagreements.push(`${c.id}#${i} pin=${pinned[i]} live=${liveLabels[i]}`);
      }
    }
    if (drifted.length > 0) {
      console.log(
        `[p262 divergence] the other path's source has changed since the pin: ${drifted
          .map(([f]) => f)
          .join(", ")} — ${PIN.regenerationCommand}`,
      );
    }
    expect(
      disagreements,
      `the pin disagrees with ${PIN.otherPath.repo} run from source at ${root}: ` +
        `re-run ${PIN.regenerationCommand} and re-annotate any new difference`,
    ).toEqual([]);
  });
});
