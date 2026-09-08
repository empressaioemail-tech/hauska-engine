import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { composeParcelReportFacts } from "../report-model.js";
import { absent, present, type AbsenceKind } from "../feasibility-model.js";

/**
 * P-120 R-04. The absence taxonomy exists so that five genuinely different
 * situations stop rendering as one gray UNAVAILABLE chip.
 *
 * The load-bearing distinction is `clear` versus `blocked-at-source`. Both
 * produce an empty list. One means "we checked a source that covers this
 * parcel and there is nothing there", which is GOOD NEWS a buyer can act on.
 * The other means "nothing looked". Collapsing them is the absent/zero/
 * unmeasured error, and it is what the old two-state union did.
 */

const geometry = { status: "absent" as const, reason: "no geometry in this fixture" };
const drainage = { status: "absent" as const, reason: "no drainage in this fixture" };

async function factsWith(atoms: unknown[]) {
  const storage = new InMemoryStorage();
  for (const atom of atoms) await storage.writePropertyAtom(atom as never);
  return composeParcelReportFacts({
    parcelNodeId: "48021:52726",
    storage,
    geometry,
    drainage,
  } as never);
}

/** A "checked, found nothing" row: the shape these families really persist. */
function absenceRow(entityType: string) {
  return {
    entityType,
    atomDid: `test/${entityType}/48021:52726/1`,
    entityId: `48021:52726:${entityType}:1`,
    parcelNodeId: "48021:52726",
    jurisdictionTenant: "property-spine",
    fetchedAt: new Date().toISOString(),
    extractedAt: new Date().toISOString(),
    sourceAdapter: "test",
    sourceUrl: "https://example.test",
    sourceCitation: "test fixture",
    accessPolicy: "public-free",
    atomTier: "data",
    status: "active",
    versionStamp: `48021:52726:${entityType}:1`,
    absence: { kind: "checked-none-found" },
  };
}

describe("absence taxonomy: which kind of nothing", () => {
  it("the type FORCES a kind — this is the control, not a convention", () => {
    // `absent()` takes kind first and required. A producer cannot omit the
    // question. If this ever compiles with one argument the control is gone.
    const a = absent("clear", "checked, nothing there");
    expect(a).toMatchObject({ status: "absent", kind: "clear" });
    const kinds: AbsenceKind[] = [
      "clear",
      "not-applicable",
      "out-of-scope",
      "blocked-at-source",
      "failed-this-run",
    ];
    expect(new Set(kinds).size).toBe(5);
  });

  it("carries a consequence, so a fact is a deliverable and not just data", () => {
    const a = absent("clear", "reason text", "what it means for you");
    expect(a).toMatchObject({ consequence: "what it means for you" });
    // Present facts can carry one too.
    expect(present({ x: 1 }, { consequence: "so what" })).toMatchObject({
      consequence: "so what",
    });
  });

  it("CHECKED-AND-NOTHING-THERE is `clear`, and says what it means", async () => {
    const facts = await factsWith([
      absenceRow("special-district-fact"),
      absenceRow("well-fact"),
      absenceRow("building-footprint"),
    ]);

    expect(facts.facts.specialDistricts).toMatchObject({ status: "absent", kind: "clear" });
    expect(facts.facts.wellsPipelines).toMatchObject({ status: "absent", kind: "clear" });
    expect(facts.facts.footprint).toMatchObject({ status: "absent", kind: "clear" });

    // Good news has to READ as good news, or the taxonomy bought nothing.
    const sd = facts.facts.specialDistricts as { consequence?: string };
    expect(sd.consequence).toMatch(/No MUD, PID or special-assessment district applies/);
  });

  it("NOTHING-LOOKED is `blocked-at-source`, never `clear`", async () => {
    // Same empty lists, no absence rows at all. This is the violation case:
    // if these came back `clear`, we would be reporting an unchecked parcel as
    // confirmed good news, which is the defect this whole taxonomy prevents.
    const facts = await factsWith([]);

    expect(facts.facts.specialDistricts).toMatchObject({
      status: "absent",
      kind: "blocked-at-source",
    });
    expect(facts.facts.wellsPipelines).toMatchObject({
      status: "absent",
      kind: "blocked-at-source",
    });
    expect(facts.facts.footprint).toMatchObject({
      status: "absent",
      kind: "blocked-at-source",
    });
  });

  it("VERIFIED BY VIOLATION: the two cases differ ONLY by the absence row", async () => {
    // The whole claim in one assertion. Identical inputs except the presence of
    // a checked-none-found row, and the kind flips. If this ever stops flipping,
    // the collapse is back.
    const checked = await factsWith([absenceRow("special-district-fact")]);
    const unchecked = await factsWith([]);
    const a = checked.facts.specialDistricts as { kind?: string };
    const b = unchecked.facts.specialDistricts as { kind?: string };
    expect(a.kind).toBe("clear");
    expect(b.kind).toBe("blocked-at-source");
    expect(a.kind).not.toBe(b.kind);
  });

  it("a FAILED READ is `failed-this-run` and is never dressed as a finding", async () => {
    // A storage that throws. This must not become `clear` or `blocked-at-source`:
    // it is the only kind that means WE failed, and conflating it with a
    // finding about the parcel is how a system gap reaches a customer as fact.
    const storage = {
      async listPropertyAtomsByParcelNodeId() {
        throw new Error("connection reset");
      },
      async listBoundaryEdgesByParcelNodeId() {
        return [];
      },
    };
    const facts = await composeParcelReportFacts({
      parcelNodeId: "48021:52726",
      storage: storage as never,
      geometry,
      drainage,
    } as never);

    for (const section of ["parcelOwnership", "flood", "specialDistricts", "footprint"] as const) {
      expect(facts.facts[section]).toMatchObject({
        status: "absent",
        kind: "failed-this-run",
      });
    }
  });

  it("no customer-facing absence reason leaks internal vocabulary", async () => {
    const facts = await factsWith([]);
    const reasons = Object.values(facts.facts)
      .filter((f): f is { status: "absent"; reason: string } => (f as { status?: string }).status === "absent")
      .map((f) => f.reason);
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) {
      // "atom", "row", "fact atom" are log vocabulary wearing a serif font.
      expect(r).not.toMatch(/\batom\b/i);
      expect(r).not.toMatch(/-fact\b/i);
    }
  });
});
