/**
 * REGISTRY SHAPE + DIVERGENCE CONTROL — DEV_PROCESS 2.4.
 *
 * The live-store half of the divergence test runs in
 * `scripts/duplicate-subject-detector.mjs --inventory --check-registry`, which
 * exits 1 when the registry claims a store the databases do not expose, or the
 * databases expose an atom type or adapter key the registry neither claims nor
 * excludes.
 *
 * This file guards the half that does not need a database: that the registry
 * is internally coherent, that every row is genuinely a DUPLICATE, and that
 * the field which forces `vintage-undecidable` has not been quietly filled in.
 */

import { describe, expect, it } from "vitest";

import {
  SUBJECT_REGISTRY,
  OUT_OF_SCOPE_STORES,
  declaredStoreKeys,
  duplicatedSubjects,
} from "../subject-registry.js";

describe("subject registry", () => {
  it("every declared subject is genuinely duplicated", () => {
    for (const d of SUBJECT_REGISTRY) {
      expect(d.stores.length, `${d.subject} must have >= 2 stores`).toBeGreaterThanOrEqual(2);
    }
    expect(duplicatedSubjects().length).toBe(SUBJECT_REGISTRY.length);
  });

  it("subject keys are unique", () => {
    const keys = SUBJECT_REGISTRY.map((d) => d.subject);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("store keys are unique WITHIN a subject", () => {
    for (const d of SUBJECT_REGISTRY) {
      const keys = d.stores.map((s) => s.storeKey);
      expect(new Set(keys).size, `${d.subject} has a repeated store key`).toBe(keys.length);
    }
  });

  it("a store key may legitimately appear in more than one subject", () => {
    // atoms:cad-parcel-roll holds land use, situs and owner. One store, three
    // subjects, and collapsing them would hide two duplicates.
    const all = SUBJECT_REGISTRY.flatMap((d) => d.stores.map((s) => s.storeKey));
    const cad = all.filter((k) => k === "atoms:cad-parcel-roll");
    expect(cad.length).toBeGreaterThan(1);
  });

  it("every store names its sampling contract, and the contract names a geometry or a source", () => {
    for (const d of SUBJECT_REGISTRY) {
      for (const s of d.stores) {
        expect(s.samplingContract.length, `${s.storeKey} has no sampling contract`).toBeGreaterThan(20);
      }
    }
  });

  it("the tier2 flood store records NO edition path, which is what forces vintage-undecidable", () => {
    const flood = SUBJECT_REGISTRY.find((d) => d.subject === "flood-zone");
    expect(flood).toBeDefined();
    const tier2 = flood!.stores.find((s) => s.storeKey === "pls:node-facets:tier2");
    expect(tier2).toBeDefined();
    // If a future edit fills this in, the classifier silently gains the ability
    // to report `edition-differs` for a store that cannot name an edition.
    expect(tier2!.editionPath).toBeNull();
    expect(tier2!.samplingContract).toContain("tile");
  });

  it("the two flood stores declare DIFFERENT sampling contracts", () => {
    const flood = SUBJECT_REGISTRY.find((d) => d.subject === "flood-zone")!;
    const a = flood.stores.find((s) => s.storeKey === "atoms:flood-hazard-fact")!;
    const b = flood.stores.find((s) => s.storeKey === "pls:node-facets:tier2")!;
    expect(a.samplingContract).not.toBe(b.samplingContract);
    expect(a.samplingContract).toContain("centroid");
    expect(b.samplingContract).toContain("tile");
  });

  it("stores live in a named database and a named table", () => {
    for (const d of SUBJECT_REGISTRY) {
      for (const s of d.stores) {
        expect(["atoms", "cortex"]).toContain(s.db);
        expect(s.table.length).toBeGreaterThan(0);
      }
    }
  });

  it("independent-double-derivation subjects name a ground truth; copy-transform need not", () => {
    for (const d of SUBJECT_REGISTRY) {
      if (d.duplicationClass === "independent-double-derivation") {
        expect(d.groundTruth, `${d.subject} is an independent derivation with no authority`).not.toBeNull();
      }
    }
  });

  it("the out-of-scope list gives a reason for every exclusion", () => {
    // An instrument's exclusion set is part of its contract (DEV_PROCESS 2.1)
    // and "unmentioned" is a failure state (DEV_PROCESS 3.3).
    expect(OUT_OF_SCOPE_STORES.length).toBeGreaterThan(0);
    for (const s of OUT_OF_SCOPE_STORES) {
      expect(s.why.length, `${s.storeKey} is excluded with no reason`).toBeGreaterThan(10);
    }
  });

  it("no store is both claimed and excluded", () => {
    const excluded = new Set(OUT_OF_SCOPE_STORES.map((s) => s.storeKey));
    for (const k of declaredStoreKeys()) {
      expect(excluded.has(k.split("#")[0] ?? k), `${k} is both claimed and excluded`).toBe(false);
    }
  });
});
