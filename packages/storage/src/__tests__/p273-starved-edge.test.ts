/**
 * P-273, control 4 of the 2026-09-13 ranked card: `assertEdgesNotStarved`
 * compared a computation against itself.
 *
 * THE DEFECT, in one line. The call site was
 *
 *     const links = appliesToLinksFromPropertyAtoms(instances);
 *     assertEdgesNotStarved(instances, links.length);
 *
 * and `appliesToLinksFromPropertyAtoms` skips exactly the three conditions
 * `expectedAppliesToCount` skips (entityType === "parcel-node", no
 * parcelNodeId, isCountyCoverageParcelNodeId). The two sides of the comparison
 * were therefore EQUAL BY CONSTRUCTION: no input could make the function throw,
 * so the control reported success for every write, including a write whose
 * edges never reached the store.
 *
 * WHAT IS PROVEN HERE, in both directions, in one run:
 *   1. the pre-fix input is degenerate -- the two derivations provably agree on
 *      a fixture whose edges the store then refuses to persist, which is why
 *      the throw was unreachable;
 *   2. the post-fix input is a second derivation -- the store's own count -- and
 *      on that same broken store the write FAILS with STARVED_EDGE.
 *
 * The broken store is a fault injection on purpose. The failure mode the control
 * exists for is "the edges were derived and did not land", and a store that
 * drops them is the only honest way to produce it. The integration twin,
 * p273-starved-edge.integration.test.ts, produces the same failure on a real
 * Postgres with a BEFORE INSERT trigger that silently skips one edge row.
 */
import { describe, expect, it } from "vitest";

import {
  STARVED_EDGE,
  appliesToLinksFromPropertyAtoms,
  assertEdgesNotStarved,
  buildPresentFloodHazardFactAtom,
  expectedAppliesToCount,
  type AtomLink,
  type PropertyAtomInstance,
} from "@hauska-engine/atoms";

import { InMemoryStorage } from "../in-memory-storage.js";

const provenance = {
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceCitation: "FEMA NFHL fixture",
  sourceUrl: "https://example.test/nfhl",
  observedAt: "2026-08-21T00:00:00.000Z",
  jurisdictionTenant: "tx_48021",
  contentHash: "fnv1a64:p273-starved-edge",
};

function floodFacts(parcelNodeIds: ReadonlyArray<string>): PropertyAtomInstance[] {
  return parcelNodeIds.map((parcelNodeId, i) =>
    buildPresentFloodHazardFactAtom(
      { parcelNodeId, inSpecialFloodHazardArea: false, floodZone: null },
      { ...provenance, contentHash: `fnv1a64:p273-starved-edge-${i}` },
    ),
  );
}

/** A store whose edge write silently drops everything -- the failure mode. */
class EdgeDroppingStorage extends InMemoryStorage {
  override async writeAtomLinks(_links: ReadonlyArray<AtomLink>): Promise<void> {
    return;
  }
}

describe("P-273 control 4: the starvation check can fire", () => {
  it("THE DEFECT: the pre-fix derivation is degenerate, so the pre-fix call never threw on a store that persisted no edges", () => {
    const atoms = floodFacts(["48021:27303"]);
    // The pre-fix second argument, verbatim.
    const preFixLinksWritten = appliesToLinksFromPropertyAtoms(atoms).length;
    // The value it was compared against.
    const expected = expectedAppliesToCount(atoms);
    expect(preFixLinksWritten).toBe(expected);
    expect(preFixLinksWritten).toBe(1);
    // ...and with the two inputs equal, the assertion is a no-op even though the
    // store below keeps zero edges. This is the recorded defect, not a claim.
    expect(() => assertEdgesNotStarved(atoms, preFixLinksWritten)).not.toThrow();
  });

  it("THE FIX: the same broken store now fails the batch with STARVED_EDGE", async () => {
    const atoms = floodFacts(["48021:27303"]);
    await expect(new EdgeDroppingStorage().writePropertyAtomsBatch(atoms)).rejects.toMatchObject({
      code: STARVED_EDGE,
    });
  });

  it("the store-derived count is the control: it reports 0 on the broken store and 1 on a working one", async () => {
    const atoms = floodFacts(["48021:27303"]);
    const broken = new EdgeDroppingStorage();
    const working = new InMemoryStorage();

    // Broken store: no edges land, so a store-derived count cannot equal the
    // body-derived expectation and the write is refused rather than reported OK.
    await expect(broken.writePropertyAtomsBatch(atoms)).rejects.toMatchObject({
      code: STARVED_EDGE,
    });
    // Working store: the same input lands its edge and is accepted. The control
    // is not refusing everything -- a gate that always refuses is not a gate.
    await working.writePropertyAtomsBatch(atoms);
    const snap = await working.exportSnapshot();
    expect(snap.links.filter((l) => l.linkType === "applies-to")).toHaveLength(1);
  });

  it("an idempotent re-run is not a false positive (ON CONFLICT DO NOTHING inserts zero rows and is not starvation)", async () => {
    const atoms = floodFacts(["48021:27303", "48021:27304"]);
    const storage = new InMemoryStorage();
    await storage.writePropertyAtomsBatch(atoms);
    // Second write of the same edges: every derived edge is already present, so
    // a presence count is 2 while the inserted-row count would be 0. Asserting
    // on rows inserted would make this a permanently-red gate.
    await expect(storage.writePropertyAtomsBatch(atoms)).resolves.toBeDefined();
    const snap = await storage.exportSnapshot();
    expect(snap.links.filter((l) => l.linkType === "applies-to")).toHaveLength(2);
  });

  it("a duplicate atom in one batch is not a false positive: both derivations count it twice and the store answers twice", async () => {
    const atoms = floodFacts(["48021:27303"]);
    const duplicated = [...atoms, ...atoms];
    // The body-derived expectation counts multiplicity...
    expect(expectedAppliesToCount(duplicated)).toBe(2);
    // ...and the store-derived count does too, so the batch is accepted and the
    // edge is stored once. Counting DISTINCT store rows here instead would make
    // any batch carrying a repeated atom a permanent false failure.
    const storage = new InMemoryStorage();
    await expect(storage.writePropertyAtomsBatch(duplicated)).resolves.toBeDefined();
    const snap = await storage.exportSnapshot();
    expect(snap.links.filter((l) => l.linkType === "applies-to")).toHaveLength(1);
  });
});
