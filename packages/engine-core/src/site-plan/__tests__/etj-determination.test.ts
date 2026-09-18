// P-358 (OPS-24): the PDF says what the panel says about ETJ.
//
// PRECEDENCE OF TRUTH: since P-332 (hauska-map #419, live 2026-09-18) the
// Property Explorer panel serves a four-state ETJ determination — `present` /
// `absent` / `unresolved` / `conflicting`, where `conflicting` is emitted ONLY
// when city limits say `incorporated` and the ETJ read says `present`. Before
// this lane the engine wrote the answer as a literal, so every PDF in every
// county said `unresolved` while the panel named the determination.
//
// These tests are the pre-registered falsifiers from
// `_inbox/2026-09-18_p358-pdf-forwards-etj_cp1.json`, turned into assertions.
// The falsifier DIRECTION matters as much as the assertion: several cases below
// pair a positive assertion with the wrong expectation that must FAIL (F2's
// "verbatim forwarding", F3's "absent rendered as a conflict"), because a test
// that only asserts the happy path cannot tell a rule from a hardcoded answer.
//
// Everything here is in-process: a hand-built `RecordReaderClient` (no network,
// no store, no production PDF build), the real `composeParcelReportFacts`, the
// real `emitPdfFeasibility`, and the real content-stream decoder the other PDF
// tests use. The rendered text is asserted, not just the model field, because
// the defect this lane removes was a defect in what a customer READS.

import { describe, expect, it } from "vitest";
import type { StoragePort } from "@hauska-engine/storage";

import { composeParcelReportFacts } from "../report-model.js";
import type { ParcelReportModel } from "../report-model.js";
import type {
  ParcelRecordRail,
  ParcelRecordResponse,
  RecordReaderClient,
} from "../parcel-record-reader-client.js";
import {
  ETJ_STATUSES,
  NO_DETERMINATION_REASON,
  UNSLATED_ETJ_REASON,
  readEtjReading,
  resolveEtjDetermination,
  type EtjCityLimitsReading,
} from "../etj-determination.js";
import { emitPdfFeasibility } from "../pdf/feasibility.js";
import { decodeAllContentStreams } from "../pdf/__tests__/decode-pdf-text.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const parcelNodeId = "48453:134392"; // the dispatch's conflicting fixture parcel

const ABSENT_GEOMETRY = { status: "absent" as const, reason: "P-358 test fixture: geometry not composed" };
const NO_DRAINAGE = { status: "absent" as const, reason: "P-358 test fixture: drainage not composed" };

function fakeStorage(): StoragePort {
  return { listPropertyAtomsByParcelNodeId: async () => [] } as unknown as StoragePort;
}

function rail(
  serve: ParcelRecordRail["serve"],
  cell: Record<string, unknown> | null,
  refusal: ParcelRecordRail["refusal"] = null,
): ParcelRecordRail {
  return {
    cell,
    gate: { verdict: null, evaluatedAt: null },
    serve,
    refusal,
    atom: null,
    atomBacked: false,
    rendering: null,
    companions: [],
  };
}

/** A REAL macrotask delay, for the reason `parcel-record-reader-integration.test.ts` records: an instant fake reader can mask a bug in the bounded-fetch branch. */
function delayed<T>(value: T, ms = 5): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fakeReader(rails: Record<string, ParcelRecordRail>, countyFips = "48453"): RecordReaderClient {
  const record: ParcelRecordResponse = {
    parcelNodeId,
    placeKey: parcelNodeId,
    countyFips,
    railRegistrySha: "sha",
    readAt: "2026-09-18T00:00:00.000Z",
    rails,
    refused: null,
  };
  return { fetchRecord: () => delayed({ ok: true, record }) };
}

function failingReader(reason: string): RecordReaderClient {
  return { fetchRecord: () => delayed({ ok: false, reason }) };
}

// The two named live shapes. `cityLimits` as an incorporated value cell; the
// already-verified-absent cityLimits cell is the unincorporated carrier.
function incorporatedCity(cityName: string): Record<string, unknown> {
  return { kind: "value", value: cityName, source: "landing_parcel_jurisdiction", vintage: "2026-09-01T00:00:00.000Z" };
}
const UNINCORPORATED_CITY = {
  kind: "absent-verified",
  source: "landing_parcel_jurisdiction",
  reason: "verified: this point is not inside any incorporated place",
};

/** F1's determination: a P-332 `EtjFactWire`, present on a published Austin ring. */
const ETJ_PRESENT_FACT = {
  status: "present",
  source: "tx_etj_boundary",
  basis: "point-in-polygon against tx_etj_boundary etj_id=austin-tx:39",
  cityKey: "austin-tx",
  cityName: "Austin",
  ringLabel: "AUSTIN 2 MILE ETJ",
  etjId: "austin-tx:39",
  sourceCitation: "TxGIO tx_etj_boundary (austin-tx:39)",
};

/** F3's determination: the 48209:97658 shape — checked, one ring consulted, nothing reached the point. */
const ETJ_ABSENT_FACT = {
  status: "absent",
  source: "tx_etj_boundary",
  basis:
    "point-in-polygon against 1 published ETJ ring(s) from 1 publisher(s); no published ETJ ring contains it, so ETJ is verified absent here",
  coveredBy: ["san-marcos-tx"],
  ringsConsulted: 1,
  sourceCitation: "TxGIO tx_etj_boundary (san-marcos-tx)",
};

/** The ledger's own declared conflict (shape C3): both readings, both sources. */
const ETJ_DECLARED_CONFLICT = {
  state: "conflicting",
  cityLimits: {
    state: "incorporated",
    source: "landing_parcel_jurisdiction",
    basis: "landing_parcel_jurisdiction says this point falls inside Austin",
    cityName: "Austin",
  },
  etj: {
    state: "present",
    source: "tx_etj_boundary",
    basis: "point-in-polygon against tx_etj_boundary etj_id=austin-tx:39",
    ringLabel: "AUSTIN 2 MILE ETJ",
    etjId: "austin-tx:39",
  },
  note:
    "City limits say this point is incorporated (landing_parcel_jurisdiction) while the ETJ read says it is " +
    'inside a published ETJ ring (tx_etj_boundary: "AUSTIN 2 MILE ETJ").',
};

async function composeFor(
  rails: Record<string, ParcelRecordRail>,
  options: { withReader?: boolean; reader?: RecordReaderClient; countyFips?: string } = {},
): Promise<ParcelReportModel> {
  const reader =
    options.reader ?? (options.withReader === false ? undefined : fakeReader(rails, options.countyFips));
  return composeParcelReportFacts({
    parcelNodeId,
    storage: fakeStorage(),
    geometry: ABSENT_GEOMETRY,
    drainage: NO_DRAINAGE,
    ...(reader ? { recordReader: reader } : {}),
  });
}

/** The rendered, customer-visible text of the real PDF for this model. */
async function renderedText(model: ParcelReportModel): Promise<string> {
  const result = await emitPdfFeasibility(model);
  return decodeAllContentStreams(result.bytes);
}

// ── the shared vocabulary ───────────────────────────────────────────────────

describe("P-358: the four-state vocabulary is the panel's, not a re-spelling", () => {
  it("exports exactly the four served states, in the panel's order", () => {
    expect([...ETJ_STATUSES]).toEqual(["present", "absent", "unresolved", "conflicting"]);
  });

  it("has NO_DETERMINATION_REASON byte-identical to hauska-map's, so P-331's drift table sees one literal", () => {
    expect(NO_DETERMINATION_REASON).toBe(
      "no ETJ determination was served for this point; P-332: ETJ is never derived from city limits, nor city limits from ETJ.",
    );
  });

  it("has UNSLATED_ETJ_REASON byte-identical to the sentence the pre-change PDF printed for every parcel", () => {
    // This exact string is what `pdf/feasibility.ts` hardcoded before P-358 and
    // what `feasibility-model.ts`'s comment asserted. F5 depends on it: an
    // unslated county's document must be UNCHANGED.
    expect(UNSLATED_ETJ_REASON).toBe(
      "No ETJ boundary source is wired for this county yet, so extraterritorial-jurisdiction status is unverified.",
    );
  });
});

// ── the rule ────────────────────────────────────────────────────────────────

describe("P-358 F7: the shared rule over the five-cell (city-limits x raw) matrix", () => {
  const cityLimits = (status: EtjCityLimitsReading["status"]): EtjCityLimitsReading => ({
    status,
    cityName: status === "incorporated" ? "Austin" : null,
    source: "parcel_record (landing_parcel_jurisdiction)",
    basis: "the city-limits cell's own words",
  });

  const reading = (value: unknown) => {
    const parsed = readEtjReading(value);
    if (!parsed) throw new Error(`fixture did not parse: ${JSON.stringify(value)}`);
    return parsed;
  };

  const cells: Array<{
    cityLimits: EtjCityLimitsReading["status"];
    raw: "present" | "absent";
    expected: "present" | "absent" | "conflicting";
  }> = [
    { cityLimits: "incorporated", raw: "present", expected: "conflicting" },
    { cityLimits: "incorporated", raw: "absent", expected: "absent" },
    { cityLimits: "unincorporated", raw: "present", expected: "present" },
    { cityLimits: "unincorporated", raw: "absent", expected: "absent" },
    { cityLimits: "unresolved", raw: "present", expected: "present" },
  ];

  for (const cell of cells) {
    it(`${cell.cityLimits} + ${cell.raw} -> ${cell.expected}`, () => {
      const served = resolveEtjDetermination({
        cityLimits: cityLimits(cell.cityLimits),
        reading: reading(
          cell.raw === "present"
            ? ETJ_PRESENT_FACT
            : ETJ_ABSENT_FACT,
        ),
        fallbackReason: UNSLATED_ETJ_REASON,
      });
      expect(served.etjStatus).toBe(cell.expected);
      expect(served.etjReason).toBeNull();
      if (cell.expected === "conflicting") {
        expect(served.etjConflict).not.toBeNull();
        // BOTH readings are named with their OWN sources -- the whole point.
        expect(served.etjConflict?.cityLimits.source).toBe("parcel_record (landing_parcel_jurisdiction)");
        expect(served.etjConflict?.etj.source).toBe("tx_etj_boundary");
      } else {
        expect(served.etjConflict).toBeNull();
      }
    });
  }

  it("a bare `conflicting` string is normalised back to raw `present`, so the rule — not the payload — decides", () => {
    // Mirror of the panel's `rawEtjStatusInHand`: `present` is the only raw that
    // can produce `conflicting`, and beside UNINCORPORATED city limits the
    // coherent answer is `present`, not a conflict the rule cannot produce.
    const uninc = resolveEtjDetermination({
      cityLimits: cityLimits("unincorporated"),
      reading: reading("conflicting"),
      fallbackReason: UNSLATED_ETJ_REASON,
    });
    expect(uninc.etjStatus).toBe("present");
    expect(uninc.etjConflict).toBeNull();

    const inc = resolveEtjDetermination({
      cityLimits: cityLimits("incorporated"),
      reading: reading("conflicting"),
      fallbackReason: UNSLATED_ETJ_REASON,
    });
    expect(inc.etjStatus).toBe("conflicting");
    expect(inc.etjConflict?.note).toContain("City limits say this point is incorporated");
  });

  it("a DECLARED conflict block (both readings / both sources) is carried through verbatim", () => {
    const served = resolveEtjDetermination({
      cityLimits: cityLimits("unincorporated"), // deliberately contradictory: the LEDGER declared it, so it stands
      reading: reading(ETJ_DECLARED_CONFLICT),
      fallbackReason: UNSLATED_ETJ_REASON,
    });
    expect(served.etjStatus).toBe("conflicting");
    expect(served.etjConflict?.etj.ringLabel).toBe("AUSTIN 2 MILE ETJ");
    expect(served.etjConflict?.cityLimits.cityName).toBe("Austin");
    expect(served.etjConflict?.note).toBe(ETJ_DECLARED_CONFLICT.note);
  });
});

describe("P-358: the rule is never DERIVED from the other rail, in either direction", () => {
  it("reads city limits to PRODUCE present/absent only through the conflict test — unincorporated+present serves present, it does not serve unincorporated", () => {
    const served = resolveEtjDetermination({
      cityLimits: { status: "unincorporated", cityName: null, source: "s", basis: "b" },
      reading: readEtjReading(ETJ_PRESENT_FACT) ?? null,
      fallbackReason: UNSLATED_ETJ_REASON,
    });
    expect(served.etjStatus).toBe("present");
  });

  it("serves city-limits status from its OWN rail: an ETJ `present` read never turns unincorporated land into `incorporated`", async () => {
    const model = await composeFor({
      cityLimits: rail("record", UNINCORPORATED_CITY),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unincorporated");
    expect(model.facts.jurisdiction.etjStatus).toBe("present");
  });

  it("an ETJ `absent` read never turns incorporated land into unincorporated", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("San Marcos")),
      etjStatus: rail("record", { kind: "value", value: ETJ_ABSENT_FACT }),
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("incorporated");
    expect(model.facts.jurisdiction.etjStatus).toBe("absent");
  });
});

// ── the four states, end to end through the PDF ─────────────────────────────

describe("P-358 F1: `present` names the city and the ring on the page", () => {
  it("composes present and renders it, with the determination's own source carried", async () => {
    const model = await composeFor({
      cityLimits: rail("record", UNINCORPORATED_CITY),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });

    expect(model.facts.jurisdiction.etjStatus).toBe("present");
    expect(model.facts.jurisdiction.etjFact?.cityName).toBe("Austin");
    expect(model.facts.jurisdiction.etjFact?.etjId).toBe("austin-tx:39");
    expect(model.facts.jurisdiction.etjConflict).toBeUndefined();
    expect(model.facts.jurisdiction.etjReason).toBeUndefined();

    const text = await renderedText(model);
    expect(text).toContain("Inside Austin's extraterritorial jurisdiction");
    expect(text).toContain("AUSTIN 2 MILE ETJ");
    expect(text).toContain("tx_etj_boundary");
    // The consequence row says what the state MEANS, not the unresolved default.
    expect(text).toContain("This parcel sits inside");
    expect(text).not.toContain("No ETJ boundary source is wired for this county yet");
  });

  it("the NARRATIVE and the open-item sentence both read the state (only the cityLimits half is unresolved)", async () => {
    const model = await composeFor({
      cityLimits: rail("record", UNINCORPORATED_CITY),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });
    const narrative = model.package.narrativeSkeleton;
    expect(narrative).toContain("City limits read unincorporated");
    expect(narrative).toContain("this parcel sits inside a published extraterritorial jurisdiction");
    expect(narrative).toContain('ring "AUSTIN 2 MILE ETJ"');
    expect(narrative).not.toContain("City-limits and ETJ status are not yet resolved");
    // ...and the same sentence reaches the page, not just the model.
    expect(await renderedText(model)).toContain("this parcel sits inside a published extraterritorial jurisdiction");
  });
});

describe("P-358 F2: incorporated + present renders the DECLARED CONFLICT, naming BOTH readings and BOTH sources", () => {
  it("48453:134392's live shape serves conflicting (NOT present, NOT unresolved) and prints both sides", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });

    // THE DIRECTION THAT MAKES VERBATIM FORWARDING FAIL: this is the assertion
    // that would have to be wrong for a naive "forward what the rail says" fix
    // to pass. The rail's own status is `present`; the SERVED state is not.
    expect(model.facts.jurisdiction.etjStatus).not.toBe("present");
    expect(model.facts.jurisdiction.etjStatus).not.toBe("unresolved");
    expect(model.facts.jurisdiction.etjStatus).toBe("conflicting");

    expect(model.facts.jurisdiction.etjConflict?.cityLimits.source).toContain("landing_parcel_jurisdiction");
    expect(model.facts.jurisdiction.etjConflict?.etj.source).toBe("tx_etj_boundary");

    const text = await renderedText(model);
    expect(text).toContain("Conflicting reads");
    expect(text).toContain("city limits say incorporated");
    expect(text).toContain("Austin");
    expect(text).toContain("AUSTIN 2 MILE ETJ");
    expect(text).toContain("landing_parcel_jurisdiction");
    expect(text).toContain("tx_etj_boundary");
    expect(text).toContain("Both readings are stated; neither is dropped.");
    // Which authority to confirm with, per the dispatch's item 3.
    expect(text).toContain("Confirm the boundary and the reviewing authority");
    // Never the unresolved default, and never a clean present.
    expect(text).not.toContain("No ETJ boundary source is wired for this county yet");
    expect(text).not.toContain("Inside Austin's extraterritorial jurisdiction");
  });

  it("the ledger's OWN declaration is forwarded rather than re-derived", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: ETJ_DECLARED_CONFLICT }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("conflicting");
    expect(model.facts.jurisdiction.etjConflict?.note).toBe(ETJ_DECLARED_CONFLICT.note);
    const text = await renderedText(model);
    expect(text).toContain("AUSTIN 2 MILE ETJ");
  });
});

describe("P-358 F3: `absent` is a checked finding, never `unresolved` and never a conflict", () => {
  it("48209:97658's live shape serves absent with the ring count, and incorporated+absent is NOT a conflict", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("San Marcos")),
      etjStatus: rail("record", { kind: "value", value: ETJ_ABSENT_FACT }),
    });

    expect(model.facts.jurisdiction.etjStatus).toBe("absent");
    expect(model.facts.jurisdiction.etjConflict).toBeUndefined();

    const text = await renderedText(model);
    expect(text).toContain("No extraterritorial jurisdiction reaches this parcel on the rings consulted");
    expect(text).toContain("1 ring consulted");
    expect(text).not.toContain("Conflicting reads");
    expect(text).not.toContain("No ETJ boundary source is wired for this county yet");
  });

  it("an `absent-verified` CELL is promoted to the same served state, carrying the cell's own basis", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("San Marcos")),
      etjStatus: rail("record", {
        kind: "absent-verified",
        source: "tx_etj_boundary",
        reason: "point-in-polygon against 1 published ETJ ring(s); nothing contains the point",
      }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("absent");
    expect(model.facts.jurisdiction.etjFact?.basis).toContain("nothing contains the point");
    expect(await renderedText(model)).toContain("No extraterritorial jurisdiction reaches this parcel");
  });
});

describe("P-358 F4: `unresolved` carries its REAL reason, and a stated absence claims no check", () => {
  it("a determination that is itself unresolved keeps its own basis as the reason", async () => {
    const basis = "the publisher published no ring covering this point";
    const model = await composeFor({
      countyFips: "48021",
      cityLimits: rail("record", incorporatedCity("Bastrop")),
      etjStatus: rail("record", {
        kind: "value",
        value: { status: "unresolved", source: "tx_etj_boundary", basis },
      }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBe(basis);
    const text = await renderedText(model);
    expect(text).toContain(basis);
  });

  it("a `not-applicable` cell serves unresolved with the CELL's reason and does NOT print the checked-absence sentence", async () => {
    const reason = "ETJ is not applicable to this point's jurisdiction";
    const model = await composeFor({
      cityLimits: rail("record", UNINCORPORATED_CITY),
      etjStatus: rail("record", { kind: "not-applicable", source: "tx_etj_boundary", reason }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBe(reason);

    const text = await renderedText(model);
    expect(text).toContain(reason);
    // Claiming the check that never ran is the failure this asserts against.
    expect(text).not.toContain("No extraterritorial jurisdiction reaches this parcel on the rings consulted");
  });

  it("never an empty reason: every unresolved carries text a customer can read", async () => {
    for (const rails of [
      { cityLimits: rail("record", incorporatedCity("Austin")) },
      { etjStatus: rail("legacy-transitional", null) },
      { etjStatus: rail("refused", null, { code: "excluded-mid-cutover", reason: "mid-cutover" }) },
    ]) {
      const model = await composeFor(rails);
      expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
      expect(model.facts.jurisdiction.etjReason).toBeTruthy();
    }
  });
});

describe("P-358 F5: an unslated rail, no reader, and a failed fetch all render TODAY'S sentence byte for byte", () => {
  const PRE_CHANGE_SENTENCE =
    "No ETJ boundary source is wired for this county yet, so extraterritorial-jurisdiction status is unverified.";

  it("an unslated (`legacy-transitional`) rail renders the pre-change sentence verbatim", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("legacy-transitional", null),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBe(UNSLATED_ETJ_REASON);
    expect(await renderedText(model)).toContain(PRE_CHANGE_SENTENCE);
  });

  it("no `recordReader` at all renders the pre-change sentence verbatim", async () => {
    const model = await composeFor({}, { withReader: false });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBe(UNSLATED_ETJ_REASON);
    expect(await renderedText(model)).toContain(PRE_CHANGE_SENTENCE);
  });

  it("a FAILED fetch renders the pre-change sentence verbatim", async () => {
    const model = await composeFor({}, { reader: failingReader("record HTTP 503") });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBe(UNSLATED_ETJ_REASON);
    expect(await renderedText(model)).toContain(PRE_CHANGE_SENTENCE);
  });

  it("an unslated county's whole document is unchanged: the narrative sentence is the pre-change sentence too", async () => {
    const model = await composeFor({ cityLimits: rail("record", incorporatedCity("Austin")) });
    expect(model.package.narrativeSkeleton).toContain(
      "City-limits and ETJ status are not yet resolved for this jurisdiction.",
    );
    expect(await renderedText(model)).toContain(
      "City-limits and ETJ status are not yet resolved for this jurisdiction.",
    );
  });
});

describe("P-358 F6: a refusal is a declared refusal, never silence and never a substituted state", () => {
  it("a `refused` rail carries the ledger's code and reason, and is distinguishable from an unslated rail", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("refused", null, { code: "excluded-mid-cutover", reason: "the rail is mid-cutover for this county" }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    const reason = model.facts.jurisdiction.etjReason ?? "";
    expect(reason).toContain("etjStatus");
    expect(reason).toContain("excluded-mid-cutover");
    expect(reason).toContain("the rail is mid-cutover for this county");
    // Distinguishable from the unslated default -- a probe can tell them apart.
    expect(reason).not.toBe(UNSLATED_ETJ_REASON);
  });

  it("a malformed value cell is a declared refusal, not a guessed state", async () => {
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: { status: "present" } }), // no source/basis -> readEtjFact refuses
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjReason).toBeTruthy();
    expect(model.facts.jurisdiction.etjReason).not.toBe(UNSLATED_ETJ_REASON);
  });

  it("a determination with a source but NO basis is refused, not served bare", async () => {
    // A determination with no basis is not a determination -- nothing on the
    // page could state a reason for it. Matches P-332's `readEtjFact`.
    const model = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: { status: "present", source: "tx_etj_boundary" } }),
    });
    expect(model.facts.jurisdiction.etjStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.etjFact).toBeUndefined();
    expect(model.facts.jurisdiction.etjReason).not.toBe(UNSLATED_ETJ_REASON);
  });

  it("an unrecognised payload is not evidence: readEtjReading returns undefined rather than a state", () => {
    expect(readEtjReading("maybe")).toBeUndefined();
    expect(readEtjReading(42)).toBeUndefined();
    expect(readEtjReading({ status: "present" })).toBeUndefined();
    expect(readEtjReading({ status: "conflicting" })?.raw).toBe("present"); // a declared conflict with nothing behind it
  });
});

// ── the cap that silently truncates ─────────────────────────────────────────

describe("P-358: no ETJ row is silently clipped by the dossier's fact-value cap", () => {
  // `DOSSIER_CAPS.factValue` is 400 chars and `sanitizeDossierText` truncates
  // with an ellipsis, no error and no warning. The first draft of the
  // `conflicting` consequence restated the conflict and went over the cap, so
  // the "which authority" half was clipped mid-word on the page. These
  // assertions pin the CLOSING words of every state's rows, which is where a
  // truncation shows up first.
  it("present / absent / conflicting each land their closing words on the page", async () => {
    const present = await composeFor({
      cityLimits: rail("record", UNINCORPORATED_CITY),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });
    const absent = await composeFor({
      cityLimits: rail("record", incorporatedCity("San Marcos")),
      etjStatus: rail("record", { kind: "value", value: ETJ_ABSENT_FACT }),
    });
    const conflicting = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });

    const presentText = await renderedText(present);
    expect(presentText).toContain("Confirm with that city before assuming a county-only review path.");

    const absentText = await renderedText(absent);
    expect(absentText).toContain("Confirm with the county before proceeding.");

    const conflictingText = await renderedText(conflicting);
    expect(conflictingText).toContain("Both readings are stated; neither is dropped.");
    expect(conflictingText).toContain("with the county before relying on either reading.");
  });
});

// ── the two named fixture PDFs, extracted ───────────────────────────────────

describe("P-358: the two named fixture PDFs", () => {
  it("48453:134392 (conflicting) and 48209:97658 (absent) each render their own state and no other", async () => {
    const conflicting = await composeFor({
      cityLimits: rail("record", incorporatedCity("Austin")),
      etjStatus: rail("record", { kind: "value", value: ETJ_PRESENT_FACT }),
    });
    const absent = await composeFor(
      {
        cityLimits: rail("record", incorporatedCity("San Marcos")),
        etjStatus: rail("record", { kind: "value", value: ETJ_ABSENT_FACT }),
      },
      { countyFips: "48209" },
    );

    const conflictingText = await renderedText(conflicting);
    const absentText = await renderedText(absent);

    expect(conflicting.facts.jurisdiction.etjStatus).toBe("conflicting");
    expect(absent.facts.jurisdiction.etjStatus).toBe("absent");

    expect(conflictingText).toContain("Conflicting reads");
    expect(conflictingText).not.toContain("No extraterritorial jurisdiction reaches this parcel");

    expect(absentText).toContain("No extraterritorial jurisdiction reaches this parcel on the rings consulted");
    expect(absentText).not.toContain("Conflicting reads");
  });
});
