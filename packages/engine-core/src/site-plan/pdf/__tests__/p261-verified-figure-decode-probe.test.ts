/**
 * P-261 / A-180 falsifiers 3 and 4 — the dispatch's instrument: regenerate the
 * PDFs and DECODE them.
 *
 * The operator ruled (2026-09-16, A-180) that a buildable-area figure appears
 * only when a VERIFIED envelope atom backs it. Before this change
 * `site-model.ts` gated the printed figure on atom-backing alone: any persisted
 * `buildable-envelope` atom with an area printed its number in the largest type
 * on the cover — including an atom nothing had ever verified.
 *
 * Four legs, in order of how far they travel:
 *
 *  1. the predicate itself (`envelope-promotion.ts`), including the trap A-183
 *     left behind: the wire field is `depthWarmPromotion`, and there is NO
 *     `depthWarmPromoted` field on the atom, so a fixture that sets one must
 *     NOT be read as verified;
 *  2. the composer's decision (`printedBuildable`) for each atom;
 *  3. the DECODED PDF: the unpromoted fixture's figure is absent from every
 *     page of the feasibility study and the site plan — narrative included —
 *     while the promoted fixture's figure is on every surface that printed one
 *     before (P-159's control);
 *  4. the same decision reached from a STORE, through the one place the atom is
 *     loaded (`resolveEnvelopeOutcome`, `author.ts`), so the predicate is proven
 *     wired rather than merely present.
 *
 * Set `P261_PROBE_OUT=<dir>` to write the regenerated PDFs and decoded text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";
import type { PropertyAtomInstance, SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { composeSitePlanModelForParcel } from "../../author.js";
import { DEPTH_WARM_PROMOTION_MARKER } from "../../../depth-warm/types.js";
import { isDepthWarmPromotedAtom } from "../../envelope-promotion.js";
import { composeParcelReportFacts } from "../../report-model.js";
import { composeSitePlanModel } from "../../site-model.js";
import { findUnauthorizedBuildableFigures } from "../../narrative-generator.js";
import { boundaryEdgesForRing } from "../../__tests__/boundary-edge-fixture.js";
import { emitPdfFeasibility } from "../feasibility.js";
import { emitPdfSitePlan } from "../render.js";
import { decodeAllContentStreams } from "./decode-pdf-text.js";

const PARCEL = "48029:105129";

const bbox = { westLng: -98.5, southLat: 29.4, eastLng: -98.4995, northLat: 29.4004 };
const dem = {
  width: 4,
  height: 4,
  values: new Float32Array([
    200, 200.5, 201, 201.2, 199.8, 200.2, 200.7, 201.0, 199.5, 200.0, 200.4, 200.8, 199.2, 199.7, 200.1, 200.5,
  ]),
  minElevation: 199.2,
  maxElevation: 201.2,
  nodataCount: 0,
};
const ringWgs84: Array<[number, number]> = [
  [-98.4998, 29.4001],
  [-98.4996, 29.4001],
  [-98.4996, 29.4003],
  [-98.4998, 29.4003],
  [-98.4998, 29.4001],
];
const setback: SetbackRuleAtomInstance = {
  entityType: "setback-rule",
  atomDid: "san_antonio_tx/setback/48029:105129/1",
  entityId: `${PARCEL}:setback:1`,
  jurisdictionTenant: "san_antonio_tx",
  parcelNodeId: PARCEL,
  fetchedAt: "2026-09-16T00:00:00.000Z",
  extractedAt: "2026-09-16T00:00:00.000Z",
  sourceAdapter: "san-antonio-tx-udc",
  sourceUrl: "https://library.municode.com/tx/san_antonio/udc/35-310.01",
  sourceCitation: "Setback rule for R-6 cited to san_antonio_tx/udc/35-310.01",
  accessPolicy: "public-free",
  atomTier: "data",
  status: "active",
  versionStamp: `${PARCEL}:setback-rule:1`,
  front: 10,
  side: 5,
  rear: 20,
  sourceCodeAtomRef: {
    atomDid: "san_antonio_tx/udc/35-310.01/35-310.01",
    role: "rule",
    entityType: "code-section",
  },
} as unknown as SetbackRuleAtomInstance;
const boundaryEdges = boundaryEdgesForRing(ringWgs84, [
  { role: "front", feet: 10 },
  { role: "side", feet: 5 },
  { role: "rear", feet: 20 },
  { role: "side", feet: 5 },
]);

const ATOM_REF = `did:hauska:buildable-envelope:${PARCEL}:1`;

/**
 * The envelope atom as `resolveEnvelopeOutcome` reads it: its own bare
 * `outcome` union, plus the promotion fact the store carries beside it.
 * `promotion` is the raw wire value on purpose — a fixture must not be able to
 * pass a field the contract does not have.
 */
function envelopeAtom(promotion: unknown): PropertyAtomInstance {
  return {
    entityType: "buildable-envelope",
    atomDid: ATOM_REF,
    entityId: `${PARCEL}:envelope`,
    parcelNodeId: PARCEL,
    outcome: { kind: "buildable", areaSqFt: ATOM_AREA_SQ_FT },
    ...(promotion === undefined ? {} : { depthWarmPromotion: promotion }),
    sourceCitation: "buildable-envelope derive (fixture)",
    status: "active",
    accessPolicy: "public-free",
    atomTier: "data",
    sourceAdapter: "fixture",
    sourceUrl: "fixture://",
    contentHash: "p261-probe",
    extractedAt: "2026-09-16T00:00:00.000Z",
    fetchedAt: "2026-09-16T00:00:00.000Z",
    versionStamp: `${PARCEL}:buildable-envelope:1`,
  } as unknown as PropertyAtomInstance;
}

function modelWith(envelopeOutcome: Parameters<typeof composeSitePlanModel>[0]["envelopeOutcome"]) {
  return composeSitePlanModel({
    parcelNodeId: PARCEL,
    bbox,
    ringWgs84,
    dem,
    contourIntervalMeters: 0.5,
    setback,
    boundaryEdges,
    descriptor: { address: "1127 N PINE ST, SAN ANTONIO, TX 78202", countyName: "Bexar County" },
    zoning: { district: "R-6" },
    floodZone: { honestUnavailable: true, reason: "probe fixture: no network egress" },
    geometrySourceRef: "txgio-parcel:48029:105129:stratmap25-landparcels_48029_2025",
    envelopeOutcome,
  });
}

const BASE_MODEL = modelWith(undefined);
const LOCAL_AREA_SQ_FT = Math.round(BASE_MODEL.summary.buildableAreaSqFt!);
/** Deliberately far from the local derive, so a leak is unmistakable (P-159). */
const ATOM_AREA_SQ_FT = LOCAL_AREA_SQ_FT + 4_000;

const ATOM_STR = `${ATOM_AREA_SQ_FT.toLocaleString("en-US")} sq ft`;
const LOCAL_STR = `${LOCAL_AREA_SQ_FT.toLocaleString("en-US")} sq ft`;

const PROBE_OUT = process.env.P261_PROBE_OUT;
const evidence: Record<string, unknown> = {};

function capture(name: string, bytes: Uint8Array, decoded: string, excerpt: string[]): void {
  evidence[name] = { byteCount: bytes.byteLength, excerpt };
  if (!PROBE_OUT) return;
  mkdirSync(PROBE_OUT, { recursive: true });
  writeFileSync(join(PROBE_OUT, `${name}.pdf`), Buffer.from(bytes));
  writeFileSync(join(PROBE_OUT, `${name}.decoded.txt`), decoded, "utf8");
}

function excerpts(decoded: string, needles: string[]): string[] {
  return needles.map((needle) => {
    const at = decoded.indexOf(needle);
    return at < 0 ? `<<ABSENT>> ${needle}` : decoded.slice(at, at + needle.length + 60).split("\n")[0]!;
  });
}

/**
 * Inter's ligature glyphs come back through the decoder's `beginbfchar` CMap as
 * the Unicode presentation forms — `verified` / `file` / `figure` decode with a
 * `ﬁ` (U+FB01), not an `f` + `i` — so no plain-ASCII needle matches drawn prose
 * containing one until they are folded back.
 */
function foldLigatures(text: string): string {
  return text
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/\uFB05|\uFB06/g, "st")
    .replace(/\u00A0/g, " ");
}

/**
 * `decodeAllContentStreams` returns three reconstructions of the same streams.
 * The last one joins every text-showing operand with a space, which is the only
 * view in which a sentence DRAWN ACROSS A LINE BREAK still reads as a sentence
 * (each wrapped line is its own operand). Collapsing runs of whitespace then
 * heals the doubled space at each wrap, where the first line's trailing space
 * meets the join's own separator. Presence assertions for drawn prose belong
 * here; the raw stream stays the view for what must NOT be printed, because a
 * figure cannot hide from it.
 *
 * The section marker carries a control byte before the word (see
 * `sheet-standard.test.ts`), so locate the word itself.
 */
function drawnProse(decoded: string): string {
  const at = decoded.lastIndexOf("SPACED");
  return foldLigatures(at < 0 ? decoded : decoded.slice(at)).replace(/\s+/g, " ");
}

describe("P-261 — only a VERIFIED envelope atom prints a buildable figure", { timeout: 120_000 }, () => {
  it("the predicate reads `depthWarmPromotion`, and refuses the field the atom does not have", () => {
    expect(DEPTH_WARM_PROMOTION_MARKER).toBe("depth-warm-promoted-v1");
    // The shape `promote.ts` writes.
    expect(isDepthWarmPromotedAtom({ depthWarmPromotion: "depth-warm-promoted-v1" })).toBe(true);
    // hauska-map's `sourceCitation` fallback, for an atom whose marker field was
    // dropped by an older store or a projection.
    expect(isDepthWarmPromotedAtom({ sourceCitation: "… depth-warm-verified …" })).toBe(true);
    // A-183's teardown trap: `depthWarmPromoted` DOES NOT EXIST on the atom.
    // A fixture (or a future caller) setting it must not be read as verified.
    expect(isDepthWarmPromotedAtom({ depthWarmPromoted: true })).toBe(false);
    // Everything else: a cold derive, a warm-verify decline, no provenance.
    expect(isDepthWarmPromotedAtom({ sourceCitation: "regrid derive" })).toBe(false);
    expect(isDepthWarmPromotedAtom({})).toBe(false);
    expect(isDepthWarmPromotedAtom(null)).toBe(false);
    expect(isDepthWarmPromotedAtom(undefined)).toBe(false);
  });

  it("falsifier 3: an unpromoted buildable fixture prints NO figure anywhere, and the refusal carries no number", async () => {
    const sitePlan = modelWith({ kind: "buildable", areaSqFt: ATOM_AREA_SQ_FT, atomDid: ATOM_REF });
    expect(sitePlan.summary.printedBuildable.kind).toBe("refused");
    expect(
      sitePlan.summary.printedBuildable.kind === "refused" && sitePlan.summary.printedBuildable.reason,
    ).toContain("not depth-warm verified");
    // "refused with a reason that prints no number" (dispatch, P-261 Done): the
    // reason is drawn on the cover of two documents, so any digit in it is a
    // leak of the figure it exists to withhold.
    expect(sitePlan.summary.printedBuildable.kind === "refused" && sitePlan.summary.printedBuildable.reason).not.toMatch(/\d/);

    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: { listPropertyAtomsByParcelNodeId: async () => [] } as never,
      geometry: { status: "present", model: sitePlan },
      drainage: { status: "absent", reason: "probe fixture: drainage not composed" },
    });

    const feasibility = await emitPdfFeasibility(model, { sitePlan: { model: sitePlan } });
    const decoded = decodeAllContentStreams(feasibility.bytes);
    // The figure, in every spelling it could leak in (grouped and bare, with
    // its unit) — a bare digit run is NOT asserted: a content stream is full of
    // unrelated coordinates, and a match there would prove nothing.
    expect(decoded).not.toContain(ATOM_STR);
    expect(decoded).not.toContain(ATOM_AREA_SQ_FT.toLocaleString("en-US"));
    expect(decoded).not.toContain(`${ATOM_AREA_SQ_FT} sq ft`);
    expect(decoded).not.toContain(LOCAL_STR);
    expect(decoded).not.toMatch(/% of lot/);
    // The honest refusal does print, and it prints no number.
    const flow = drawnProse(decoded);
    expect(flow).toContain("Buildable area withheld");
    expect(flow).toContain("not depth-warm verified");
    capture(
      "p261_unpromoted_feasibility",
      feasibility.bytes,
      decoded,
      excerpts(flow, ["Buildable area withheld", "not depth-warm verified"]),
    );

    const sitePlanPdf = await emitPdfSitePlan(sitePlan, {
      aerial: { fetchImage: async () => new Uint8Array(0) },
    });
    const sitePlanDecoded = decodeAllContentStreams(sitePlanPdf.bytes);
    expect(sitePlanDecoded).not.toContain(ATOM_STR);
    expect(sitePlanDecoded).not.toContain(LOCAL_STR);
    expect(sitePlanDecoded).not.toMatch(/% of lot/);
    // The drawing's own refusal chip says why, in the same drawn-prose view.
    const sitePlanFlow = drawnProse(sitePlanDecoded);
    expect(sitePlanFlow).toContain("Buildable area withheld");
    expect(sitePlanFlow).toContain("not depth-warm verified");
    capture(
      "p261_unpromoted_site_plan",
      sitePlanPdf.bytes,
      sitePlanDecoded,
      excerpts(sitePlanFlow, ["Buildable area withheld", "not depth-warm verified"]),
    );
  });

  it("falsifier 4: the promoted fixture prints its figure on every surface that printed one before", async () => {
    const sitePlan = modelWith({
      kind: "buildable",
      areaSqFt: ATOM_AREA_SQ_FT,
      atomDid: ATOM_REF,
      depthWarmPromoted: true,
    });
    expect(sitePlan.summary.printedBuildable).toEqual({
      kind: "atom",
      areaSqFt: ATOM_AREA_SQ_FT,
      atomRef: ATOM_REF,
    });

    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: { listPropertyAtomsByParcelNodeId: async () => [] } as never,
      geometry: { status: "present", model: sitePlan },
      drainage: { status: "absent", reason: "probe fixture: drainage not composed" },
    });
    const feasibility = await emitPdfFeasibility(model, { sitePlan: { model: sitePlan } });
    const decoded = decodeAllContentStreams(feasibility.bytes);

    // P-159's own control, unchanged: ONE figure, on every surface that prints
    // one (cover, facts page, appended site-plan summary), never the local.
    const occurrences = decoded.split(ATOM_STR).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    expect(decoded).not.toContain(LOCAL_STR);
    const expectedPct = Math.round((ATOM_AREA_SQ_FT / sitePlan.summary.lotAreaSqFt) * 100);
    expect(decoded).toContain(`${expectedPct}%`);
    capture("p261_promoted_feasibility", feasibility.bytes, decoded, excerpts(decoded, [ATOM_STR]));
  });

  it("the store decides, not the caller: `resolveEnvelopeOutcome` reads the marker off the atom", async () => {
    const promoted = new InMemoryStorage();
    await promoted.writePropertyAtom(envelopeAtom(DEPTH_WARM_PROMOTION_MARKER));
    const unpromoted = new InMemoryStorage();
    await unpromoted.writePropertyAtom(envelopeAtom(undefined));

    const common = {
      parcelNodeId: PARCEL,
      bboxOverride: bbox,
      ringOverride: ringWgs84,
      setback,
      contourIntervalMeters: 0.5,
      fetchFloodZone: async () => ({
        honestUnavailable: true as const,
        reason: "probe fixture: no network egress",
      }),
      fetchDem: (async (bboxArg: unknown, opts: { resolutionMeters: number }) => ({
        bytes: new Uint8Array(0),
        contentType: "image/tiff",
        bbox: bboxArg,
        resolutionMeters: opts.resolutionMeters,
        resolutionMetersRequested: opts.resolutionMeters,
        resolutionMetersActual: null,
        widthPx: dem.width,
        heightPx: dem.height,
        endpoint: "https://fake.usgs.example/exportImage",
        fetchedAt: new Date().toISOString(),
      })) as never,
      parseDem: (async () => dem) as never,
    };

    const fromPromoted = await composeSitePlanModelForParcel({ ...common, storage: promoted } as never);
    const fromUnpromoted = await composeSitePlanModelForParcel({ ...common, storage: unpromoted } as never);

    expect(fromPromoted.model.summary.printedBuildable).toEqual({
      kind: "atom",
      areaSqFt: ATOM_AREA_SQ_FT,
      atomRef: ATOM_REF,
    });
    expect(fromUnpromoted.model.summary.printedBuildable.kind).toBe("refused");

    // Decoded, from the same store-backed composition the export uses.
    const bytes = (
      await emitPdfSitePlan(fromUnpromoted.model, { aerial: { fetchImage: async () => new Uint8Array(0) } })
    ).bytes;
    const decoded = decodeAllContentStreams(bytes);
    expect(decoded).not.toContain(ATOM_STR);
    expect(decoded).not.toMatch(/% of lot/);
    capture("p261_store_unpromoted_site_plan", bytes, decoded, excerpts(decoded, ["Buildable area"]));
  });

  it("falsifier 3, narrative leg: the prose guard refuses the figure the sheets refused", () => {
    const unpromoted = modelWith({ kind: "buildable", areaSqFt: ATOM_AREA_SQ_FT, atomDid: ATOM_REF });
    const promoted = modelWith({
      kind: "buildable",
      areaSqFt: ATOM_AREA_SQ_FT,
      atomDid: ATOM_REF,
      depthWarmPromoted: true,
    });
    const lotAreaSqFt = BASE_MODEL.summary.lotAreaSqFt;
    // The sentence the narrative would have to be fooled into writing. The
    // guard (`narrative-generator.ts`, P-159 item 3) scans the model's OWN
    // output for a buildable-area figure and refuses the whole narrative when
    // it does not trace to `printedBuildable` — or when nothing is printed.
    const prose = `The buildable envelope yields ${ATOM_STR} of developable ground.`;

    expect(findUnauthorizedBuildableFigures(prose, unpromoted.summary.printedBuildable, lotAreaSqFt)).not.toHaveLength(0);
    // Paired control: the SAME prose clears once the atom is promoted, so the
    // refusal above is the promotion gate and not the guard refusing everything.
    expect(findUnauthorizedBuildableFigures(prose, promoted.summary.printedBuildable, lotAreaSqFt)).toHaveLength(0);
  });

  it.runIf(Boolean(PROBE_OUT))("writes the probe's decoded evidence", () => {
    writeFileSync(join(PROBE_OUT!, "p261_decoded_evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
    expect(Object.keys(evidence).length).toBeGreaterThan(0);
  });
});
