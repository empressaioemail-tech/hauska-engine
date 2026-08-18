/**
 * ASSEMBLY DIVERGENCE — the paired-control test DEV_PROCESS 2.4 requires.
 *
 * `chain-assembly.ts` and `HybridRetrieval.getPropertyAtomChain` are two
 * implementations of one rule: which atoms a parcel serves after R13/R27
 * stale-setback suppression. CTRL-1 in this program was exactly that shape —
 * one rule, two implementations, and a change taught to one of them. The fix
 * there was not two careful edits, it was a divergence test. This is that test.
 *
 * It runs BOTH implementations over the same in-memory storage port and asserts
 * they agree on every slot, across the cases where they could disagree: a clean
 * city parcel on the authoritative layer-23 source, a stale breadth-bake city
 * parcel whose setback must be suppressed and whose envelope must die with it,
 * a stale city parcel whose envelope is depth-warm promoted and must SURVIVE
 * suppression, an Elgin parcel that must not be suppressed at all because the
 * rule is Bastrop-city-scoped, and a retired atom that must not be served.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@hauska-engine/storage";
import { HybridRetrieval } from "../../index.js";
import { assembleChain, dedupeParcelAtoms, type AtomLike } from "../chain-assembly.js";

function zoningFact(parcelNodeId: string, district: string | null, sourceAdapter: string, absenceKind?: string) {
  return {
    entityType: "zoning-fact",
    entityId: parcelNodeId,
    parcelNodeId,
    atomTier: "data",
    accessPolicy: "public-free",
    status: "active",
    jurisdictionTenant: `tx_${parcelNodeId.slice(0, 5)}`,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    extractedAt: "2026-08-01T00:00:00.000Z",
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    sourceAdapter,
    sourceUrl: "https://example.invalid/zoning",
    sourceCitation: "test",
    contentHash: "fnv1a64:0000000000000001",
    reasoningChain: { reasoningKind: "observed" },
    verificationStatus: "machine",
    ...(district ? { district } : {}),
    ...(absenceKind ? { absence: { kind: absenceKind, reason: "no stamp here" } } : {}),
  } as unknown as AtomLike;
}

function setbackRule(parcelNodeId: string, sourceAdapter: string, sourceCodeAtomDid?: string) {
  return {
    entityType: "setback-rule",
    entityId: parcelNodeId,
    parcelNodeId,
    atomTier: "data",
    accessPolicy: "public-free",
    status: "active",
    jurisdictionTenant: `tx_${parcelNodeId.slice(0, 5)}`,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    extractedAt: "2026-08-01T00:00:00.000Z",
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    sourceAdapter,
    sourceUrl: "https://example.invalid/setbacks",
    sourceCitation: "test",
    contentHash: "fnv1a64:0000000000000002",
    reasoningChain: { reasoningKind: "observed" },
    verificationStatus: "machine",
    front: 20,
    side: 5,
    rear: 20,
    districtCode: "GC",
    ...(sourceCodeAtomDid ? { sourceCodeAtomRef: { atomDid: sourceCodeAtomDid } } : {}),
  } as unknown as AtomLike;
}

function envelope(parcelNodeId: string, opts: { depthWarm?: boolean } = {}) {
  return {
    entityType: "buildable-envelope",
    entityId: parcelNodeId,
    parcelNodeId,
    atomTier: "data",
    accessPolicy: "public-free",
    status: "active",
    jurisdictionTenant: `tx_${parcelNodeId.slice(0, 5)}`,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    extractedAt: "2026-08-01T00:00:00.000Z",
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    sourceAdapter: "buildable-envelope-v1",
    sourceUrl: "https://example.invalid/envelope",
    sourceCitation: "test",
    contentHash: "fnv1a64:0000000000000003",
    reasoningChain: { reasoningKind: "derived" },
    verificationStatus: "machine",
    outcome: { kind: "buildable", areaSqFt: 6325 },
    geojson: { type: "FeatureCollection", features: [{ type: "Feature" }] },
    ...(opts.depthWarm ? { depthWarmPromotion: "depth-warm-promoted-v1" } : {}),
  } as unknown as AtomLike;
}

const CASES: Array<{ name: string; parcelNodeId: string; atoms: AtomLike[] }> = [
  {
    name: "bastrop city, authoritative layer-23 setback — nothing suppressed",
    parcelNodeId: "48021:1001",
    atoms: [
      zoningFact("48021:1001", "GC", "txgio-zoning-stamp:bastrop-city-tx"),
      setbackRule("48021:1001", "bastrop-per-parcel-record-layer-23"),
      envelope("48021:1001"),
    ],
  },
  {
    name: "bastrop city, stale breadth-bake setback — setback AND envelope suppressed",
    parcelNodeId: "48021:1002",
    atoms: [
      zoningFact("48021:1002", "GC", "txgio-zoning-stamp:bastrop-city-tx"),
      setbackRule("48021:1002", "cortex-tier1-snapshot-breadth-bake"),
      envelope("48021:1002"),
    ],
  },
  {
    name: "bastrop city, stale setback but depth-warm envelope — envelope SURVIVES",
    parcelNodeId: "48021:1003",
    atoms: [
      zoningFact("48021:1003", "GC", "txgio-zoning-stamp:bastrop-city-tx"),
      setbackRule("48021:1003", "descriptor-fixture", "did:hauska:code-section:bastrop-b3-code-april-2025:1"),
      envelope("48021:1003", { depthWarm: true }),
    ],
  },
  {
    name: "elgin stamp with the same stale adapter — Bastrop-city rule must NOT reach it",
    parcelNodeId: "48021:1004",
    atoms: [
      zoningFact("48021:1004", "R-1", "txgio-zoning-stamp:elgin-tx"),
      setbackRule("48021:1004", "cortex-tier1-snapshot-breadth-bake"),
      envelope("48021:1004"),
    ],
  },
  {
    name: "unstamped county parcel — honest absence, no setback rule at all",
    parcelNodeId: "48021:1005",
    atoms: [zoningFact("48021:1005", null, "txgio-parcel-record", "no-zoning-stamp")],
  },
  {
    name: "retired atom must not be served by either implementation",
    parcelNodeId: "48021:1006",
    atoms: [
      zoningFact("48021:1006", "GC", "txgio-zoning-stamp:bastrop-city-tx"),
      { ...setbackRule("48021:1006", "bastrop-per-parcel-record-layer-23"), status: "retired" },
    ],
  },
  {
    name: "different county entirely — suppression is county-scoped",
    parcelNodeId: "48453:2001",
    atoms: [
      zoningFact("48453:2001", "SF-3", "txgio-zoning-stamp:austin-tx"),
      setbackRule("48453:2001", "cortex-tier1-snapshot-breadth-bake"),
      envelope("48453:2001"),
    ],
  },
];

/** Slot identity as the PE adapter would read it: which atom, by entityId. */
function slots(chain: {
  zoningFact: unknown;
  setbackRule: unknown;
  buildableEnvelope: unknown;
  atoms?: ReadonlyArray<{ type?: string; kind?: string }>;
}) {
  const id = (a: unknown) =>
    a && typeof a === "object" ? String((a as { entityId?: unknown }).entityId ?? "") : null;
  return {
    zoningFact: id(chain.zoningFact),
    setbackRule: id(chain.setbackRule),
    buildableEnvelope: id(chain.buildableEnvelope),
    atomTypes: [...(chain.atoms ?? [])]
      .map((a) => String(a.type ?? a.kind ?? ""))
      .sort(),
  };
}

describe("bulk chain assembly does not diverge from the live retrieval service", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const storage = new InMemoryStorage();
      for (const atom of c.atoms) {
        await storage.writePropertyAtom(atom as never);
      }
      const service = new HybridRetrieval(storage as never);
      const live = await service.getPropertyAtomChain(c.parcelNodeId);

      const rows = await storage.listPropertyAtomsByParcelNodeId(c.parcelNodeId);
      const bulk = assembleChain(
        c.parcelNodeId,
        dedupeParcelAtoms(c.parcelNodeId, rows as unknown as AtomLike[]),
      );

      expect(slots(bulk)).toEqual(slots(live as never));
    });
  }

  it("dedupe prefers the canonical entityId over a suffixed sibling", () => {
    const canonical = zoningFact("48021:1007", "GC", "txgio-zoning-stamp:bastrop-city-tx");
    const suffixed = {
      ...zoningFact("48021:1007", "RR", "txgio-zoning-stamp:bastrop-city-tx"),
      entityId: "48021:1007:2025",
    };
    // Suffixed first, so a naive "last wins" would pick the wrong one.
    const picked = dedupeParcelAtoms("48021:1007", [suffixed, canonical]);
    expect(picked).toHaveLength(1);
    expect(picked[0].entityId).toBe("48021:1007");
  });

  it("dedupe drops a retired atom and a foreign-parcel prefix collision", () => {
    const retired = { ...zoningFact("48021:1008", "GC", "a"), status: "retired" };
    const foreign = { ...zoningFact("48021:1008", "GC", "a"), parcelNodeId: "48021:10080" };
    expect(dedupeParcelAtoms("48021:1008", [retired, foreign])).toHaveLength(0);
  });
});
