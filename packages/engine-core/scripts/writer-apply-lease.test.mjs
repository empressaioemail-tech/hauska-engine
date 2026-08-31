import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APPLY_LEASE_MESSAGE,
  consumeRunIdArg,
  persistRailAtoms,
  railLeaseArgs,
  refuseApplyWithoutRunId,
} from "./writer-apply-lease.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseWithConsume(argv) {
  const out = { runId: null };
  for (let i = 0; i < argv.length; i++) {
    const next = consumeRunIdArg(argv[i], argv, i, out);
    if (next !== null) i = next;
  }
  return out;
}

describe("writer-apply-lease helpers", () => {
  it("parses spaced and --run-id= forms", () => {
    expect(parseWithConsume(["--run-id", "abc"]).runId).toBe("abc");
    expect(parseWithConsume(["--run-id=def"]).runId).toBe("def");
    expect(parseWithConsume(["--county=48021"]).runId).toBeNull();
  });

  it("refuses apply without run-id and does not refuse the other arm", () => {
    expect(refuseApplyWithoutRunId("well-fact-county.refused", true, null)).toBe(true);
    expect(refuseApplyWithoutRunId("well-fact-county.refused", true, "row-1")).toBe(false);
    expect(refuseApplyWithoutRunId("well-fact-county.refused", false, null)).toBe(false);
  });

  it("scopes a rail to its own entity_type, never cad-parcel-roll", () => {
    const args = railLeaseArgs({
      entityType: "well-fact",
      countyFips: "48021",
      runId: "row-1",
      holderFallback: "well-fact-writer",
    });
    expect(args.scope).toEqual({
      scope_type: "write",
      entity_type: "well-fact",
      county_fips: "48021",
    });
    expect(args.run_id).toBe("row-1");
    expect(() =>
      railLeaseArgs({
        entityType: "cad-parcel-roll",
        countyFips: "48021",
        runId: "row-1",
        holderFallback: "no",
      }),
    ).toThrow(/cad-parcel-roll/);
  });

  it("persistRailAtoms refuses a missing lease and threads a present one", async () => {
    const calls = [];
    const storage = {
      writePropertyAtomsBatch: async (atoms, lease) => {
        calls.push({ atoms, lease });
      },
    };
    await expect(persistRailAtoms(storage, [{ id: 1 }], null)).rejects.toThrow(
      /HeldLease/,
    );
    const lease = { holder_token: "t", scope: { entity_type: "setback" } };
    await persistRailAtoms(storage, [{ id: 1 }], lease);
    expect(calls).toEqual([{ atoms: [{ id: 1 }], lease }]);
  });
});

describe("four writers: --apply without --run-id is LEASE_REQUIRED before planning", () => {
  const writers = [
    {
      file: "write-well-fact-county.mjs",
      env: { WELL_FACT_PATH: "1" },
    },
    {
      file: "write-building-footprint-county.mjs",
      env: { BUILDING_FOOTPRINT_PATH: "1" },
    },
    {
      file: "write-utility-easement-county.mjs",
      env: { UTILITY_EASEMENT_PATH: "1" },
    },
    {
      file: "write-setback-city.mjs",
      env: { SETBACK_PATH: "1" },
      extraArgs: ["--city=elgin-tx"],
    },
  ];

  for (const w of writers) {
    it(`${w.file} exits 2 at parse with no county plan`, () => {
      const r = spawnSync(
        process.execPath,
        [
          path.join(here, "../node_modules/tsx/dist/cli.mjs"),
          path.join(here, w.file),
          "--apply",
          "--county=48021",
          ...(w.extraArgs ?? []),
        ],
        {
          env: { ...process.env, ...w.env },
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("LEASE_REQUIRED");
      expect(r.stderr).toContain(APPLY_LEASE_MESSAGE);
      expect(r.stdout).not.toMatch(/dry-run-prediction|\.plan\b|atomsBuilt/);
    });
  }
});
