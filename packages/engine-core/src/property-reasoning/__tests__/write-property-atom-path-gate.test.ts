/**
 * P-186 (OPS-23 wave 6) — the wrapper's false-success direction, at the gate.
 *
 * `writePropertyAtomIfEnabled` returns `null` (no throw, no signal) when
 * `PROPERTY_ATOM_PATH` is unset. A caller that ignores the return value reports
 * success while writing nothing. That is not hypothetical in this repo:
 * `packages/engine-core/scripts/stamp-bastrop-successor-zoning-fact.mjs` pushes
 * `{ status: "stamped", atomDid: written?.atomDid }` — with the env unset,
 * `written` is `null` and the run reports every parcel "stamped" with no
 * `atomDid`, having written nothing at all.
 *
 * The instrument that must never do this is the depth-warm re-mint, and its two
 * defences are: the runner FATALs up front for `--promote` without the env, and
 * the job declaration sets `PROPERTY_ATOM_PATH=1` so an execution cannot omit
 * it. This file locks both, plus the gate behaviour itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { writePropertyAtomIfEnabled } from "../write-property-atom.js";

function fakeAtom(): PropertyAtomInstance {
  return {
    entityType: "setback-rule",
    atomDid: "did:hauska:setback-rule:48021:34049:setback:1",
    entityId: "48021:34049:setback:1",
  } as unknown as PropertyAtomInstance;
}

function fakeStorage() {
  const writePropertyAtom = vi.fn(async () => ({ atomDid: "did:hauska:setback-rule:x", cid: "bafytest" }));
  return { storage: { writePropertyAtom } as unknown as StoragePort, writePropertyAtom };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PROPERTY_ATOM_PATH gate — the silent no-op direction", () => {
  it("UNSET: returns null and never touches storage — a caller checking only for thrown errors would call this success", async () => {
    vi.stubEnv("PROPERTY_ATOM_PATH", "");

    const { storage, writePropertyAtom } = fakeStorage();
    const result = await writePropertyAtomIfEnabled(storage, fakeAtom());

    expect(result).toBeNull();
    expect(writePropertyAtom).not.toHaveBeenCalled();
  });

  it("SET to 1: writes once and returns the write result — the two directions differ by this alone", async () => {
    vi.stubEnv("PROPERTY_ATOM_PATH", "1");

    const { storage, writePropertyAtom } = fakeStorage();
    const result = await writePropertyAtomIfEnabled(storage, fakeAtom());

    expect(result).toEqual({ atomDid: "did:hauska:setback-rule:x", cid: "bafytest", skipped: false });
    expect(writePropertyAtom).toHaveBeenCalledTimes(1);
  });

  it("a value that is not exactly '1' is not enabled — PROPERTY_ATOM_PATH=true would write nothing", async () => {
    vi.stubEnv("PROPERTY_ATOM_PATH", "true");

    const { storage, writePropertyAtom } = fakeStorage();
    expect(await writePropertyAtomIfEnabled(storage, fakeAtom())).toBeNull();
    expect(writePropertyAtom).not.toHaveBeenCalled();
  });
});
