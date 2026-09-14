/**
 * P-186 (OPS-23 wave 6, plan row P-154) — the re-mint preview, driven through the
 * REAL emit path in both directions.
 *
 * WHY THESE TWO DIRECTIONS. The wrapper's dry leg can only be honest if the two
 * ways a re-mint can mislead are distinguishable in its output:
 *
 *   (a) the descriptor was built from the CODIFIED/CORPUS table instead of the
 *       LIVE per-parcel record -> the emitted body carries NO `secondSource` at
 *       all, and because the write is `INSERT ... ON CONFLICT (atom_did) DO
 *       UPDATE SET body = EXCLUDED.body`, the apply leg would DELETE the
 *       disclosure the live row carries today. `@empressaio/setback-corpus@1.2.0`
 *       contains ZERO occurrences of `second_source`, so this is not
 *       hypothetical: it is what any snapshot/corpus-derived emit produces.
 *   (b) the descriptor WAS built from the live record but the A-148/R-1
 *       detectors did not fire -> the body carries a prose `secondSource` and no
 *       structured `conflict`, so the run is a successful no-op for the remit's
 *       purpose.
 *
 * The fixtures are the real, live-verified rows already used by the adapter and
 * engine suites for `48021:34049` (1109 Pecan St, SF-1) and the same parcel's
 * authoritative `Zone_Types/FeatureServer/25` row.
 */
import { describe, expect, it, vi } from "vitest";

import { getSetbackTable, getSetbackTableForZoning, parseBastropPerParcelAttributes } from "@hauska-engine/adapters";

import { buildBastropPerParcelSetbackDescriptor } from "../../property-reasoning/bastrop-per-parcel-setback.js";
import { emitSetbackRule } from "../../property-reasoning/emit-setback-rule.js";
import { setbackTableDescriptorFromAdapter } from "../../property-reasoning/setback-table-from-adapter.js";
import type { JurisdictionDescriptor } from "../../property-reasoning/types.js";
import { buildRemintPreview, emptyRemintPreview, remintPreviewRefusal } from "../remint-preview.js";

/**
 * Real `Parcels_One_Click/FeatureServer/23` row for prop_id 34049 — the layer
 * `fetchBastropPerParcelSetbackRecord` reads on the path this job runs.
 * Live-verified 2026-09-12 (same fixture as
 * `packages/adapters/src/local/setbacks/__tests__/bastrop-r1-integration.test.ts`'s
 * sibling in `bastrop-per-parcel-setback.test.ts`). Its numeric shortcut columns
 * (25/5/25) AGREE with its text fields, so the A-148 same-layer detector does
 * NOT fire on this record.
 */
const LIVE_LAYER_23_ROW_34049 = {
  prop_id: 34049,
  ZoneTypeClass: 3,
  FrontSetback_: 25,
  FrontSetback: "25 ft (porches may encroach up to 10 ft)",
  SideSetback_: 5,
  SideSetback: "5 ft (Corner Side Street Setback: 15 ft)",
  RearSetback_: 25,
  RearSetback: "25 ft",
  Ordinance_: "2019-51",
  LASTUPDATE: null,
};

/**
 * Real `Zone_Types/FeatureServer/25` row, OID 297 — the City of Bastrop's
 * CURRENT authoritative zoning layer, live-verified 2026-09-14. Its TEXT fields
 * say 30/10/30/20 while its unrefreshed numeric columns still say 25/5/25: this
 * is the row the A-148 same-layer detector fires on.
 */
const LIVE_ZONE_TYPES_25_ROW_34049 = {
  OBJECTID: 297,
  prop_id: 34049,
  ZoneTypeClass: 3,
  FrontSetback: "30 feet",
  SideSetback: "10 feet",
  RearSetback: "30 feet",
  CornerSideStreetSetback: "20 feet",
  FrontSetback_: 25,
  SideSetback_: 5,
  RearSetback_: 25,
  Ordinance_: "2019-51",
  LASTUPDATE: null,
};

const PARCEL = "48021:34049";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchForRow(attrs: Record<string, unknown>): typeof fetch {
  return vi.fn(async () => jsonResponse({ features: [{ attributes: attrs }] })) as unknown as typeof fetch;
}

const BASE_DESCRIPTOR: JurisdictionDescriptor = {
  key: "bastrop-development-code",
  displayName: "City of Bastrop, TX (P-186 preview test descriptor)",
  jurisdictionTenant: "bastrop-development-code",
  parcelFips: "48021",
  defaultAccessPolicy: "public-free",
  sourceAdapter: "descriptor-fixture",
  sourceUrl: "https://example.invalid/bastrop-development-code-test",
};

/** The exact emit the wrapper previews, wrapped the way `promote.ts` wraps it. */
function previewOf(descriptor: JurisdictionDescriptor, rowDistrict: string) {
  const row = descriptor.setbackTable?.rows.find((r) => r.district_code === rowDistrict);
  if (!row) throw new Error(`test descriptor has no ${rowDistrict} row`);
  const atom = emitSetbackRule(descriptor, rowDistrict, row, PARCEL);
  if ("kind" in atom) throw new Error(`emit declined: ${atom.code}`);
  return buildRemintPreview(PARCEL, { boundaryEdges: [], propertyAtoms: [atom] });
}

describe("remint preview — direction (a): a descriptor with no second source would DELETE the live disclosure", () => {
  it("a CORPUS/codified-table descriptor emits a setback-rule atom with NO secondSource, and the preview says the upsert would delete it", () => {
    // `getSetbackTable` is the codified chart — the same source
    // `@empressaio/setback-corpus@1.2.0` carries, which holds ZERO occurrences of
    // `second_source`. This is the snapshot/corpus arm the instrument must never
    // be run through.
    const corpusTable = getSetbackTable("bastrop-development-code");
    expect(corpusTable).not.toBeNull();
    const descriptor: JurisdictionDescriptor = {
      ...BASE_DESCRIPTOR,
      setbackTable: setbackTableDescriptorFromAdapter(corpusTable),
    };

    const preview = previewOf(descriptor, "SF-1");

    expect(preview.setbackRule).not.toBeNull();
    expect(preview.setbackRule!.secondSourcePresent).toBe(false);
    expect(preview.setbackRule!.conflictPresent).toBe(false);
    expect(preview.setbackRule!.conflictShape).toBeNull();
    // The regression flag — this is the finding the operator must not miss.
    expect(preview.deletesExistingDisclosure).toBe(true);
    expect(preview.note).toContain("DELETE");
  });

  it("a LIVE-record descriptor for the same parcel DOES carry a second source, so the same preview does not flag a delete", async () => {
    const live = await buildBastropPerParcelSetbackDescriptor(
      BASE_DESCRIPTOR,
      PARCEL,
      "SF-1",
      "bastrop-development-code",
      mockFetchForRow(LIVE_LAYER_23_ROW_34049),
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    const preview = previewOf(live.descriptor, "SF-1");

    expect(preview.setbackRule).not.toBeNull();
    expect(preview.setbackRule!.secondSourcePresent).toBe(true);
    expect(preview.deletesExistingDisclosure).toBe(false);
  });
});

describe("remint preview — direction (b): the live record, and whether the conflict detector fired", () => {
  it("the live layer-23 record for 48021:34049 fires NO A-148 same-layer detector (its numeric columns agree with its text)", async () => {
    const live = await buildBastropPerParcelSetbackDescriptor(
      BASE_DESCRIPTOR,
      PARCEL,
      "SF-1",
      "bastrop-development-code",
      mockFetchForRow(LIVE_LAYER_23_ROW_34049),
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    // Measured on the record the job actually fetches.
    expect(live.record.textNumericDisagreement).toBeUndefined();
  });

  it("the two-instrument R-1 arm still fires for 48021:34049, so the emitted body carries a structured conflict and is NOT a no-op", async () => {
    const live = await buildBastropPerParcelSetbackDescriptor(
      BASE_DESCRIPTOR,
      PARCEL,
      "SF-1",
      "bastrop-development-code",
      mockFetchForRow(LIVE_LAYER_23_ROW_34049),
    );
    if (!live.ok) throw new Error("expected a parsed live record");

    const preview = previewOf(live.descriptor, "SF-1");

    expect(preview.setbackRule!.secondSourcePresent).toBe(true);
    expect(preview.setbackRule!.conflictPresent).toBe(true);
    expect(preview.setbackRule!.conflictShape).toBe("second-source");
    expect(preview.setbackRule!.secondSourceNote).toBeTruthy();
    expect(preview.noOpForConflict).toBe(false);
  });

  it("the A-148 same-layer row fires the stale-numeric-columns shape, and the preview names that shape", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_ZONE_TYPES_25_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    const resolution = getSetbackTableForZoning("bastrop-development-code", "SF-1", {
      bastropPerParcelRecord: parsed,
      districtCode: "SF-1",
    });
    if (!resolution || resolution.kind !== "conflict") throw new Error("expected the conflict arm");

    const descriptor: JurisdictionDescriptor = {
      ...BASE_DESCRIPTOR,
      setbackTable: setbackTableDescriptorFromAdapter(resolution.table),
    };
    const preview = previewOf(descriptor, "SF-1");

    expect(preview.setbackRule!.conflictPresent).toBe(true);
    expect(preview.setbackRule!.conflictShape).toBe("stale-numeric-columns");
    expect(preview.deletesExistingDisclosure).toBe(false);
    expect(preview.noOpForConflict).toBe(false);
  });

  it("a district with no codified row keeps the layer's prose disclosure and NO structured conflict — the preview flags the successful no-op", () => {
    const parsed = parseBastropPerParcelAttributes(LIVE_LAYER_23_ROW_34049);
    if (parsed.kind !== "parsed") throw new Error("expected a parsed record");
    // MU has no BDC chart row, so there is nothing to resolve BETWEEN: the
    // per-parcel table (with layer-83's district prose) is the only candidate.
    const resolution = getSetbackTableForZoning("bastrop-development-code", "MU", {
      bastropPerParcelRecord: parsed,
      districtCode: "MU",
    });
    if (!resolution) throw new Error("expected a per-parcel table");
    expect(resolution.kind).toBe("table");

    const descriptor: JurisdictionDescriptor = {
      ...BASE_DESCRIPTOR,
      setbackTable: setbackTableDescriptorFromAdapter(resolution.table),
    };
    const preview = previewOf(descriptor, "MU");

    expect(preview.setbackRule!.secondSourcePresent).toBe(true);
    expect(preview.setbackRule!.conflictPresent).toBe(false);
    expect(preview.deletesExistingDisclosure).toBe(false);
    expect(preview.noOpForConflict).toBe(true);
    expect(preview.note).toContain("NO-OP FOR CONFLICT");
  });
});

describe("remint preview — the flag gate (executable, not just asserted as a string)", () => {
  it("allows exactly the bounded dry leg", () => {
    expect(remintPreviewRefusal({ remintPreview: true, parcel: PARCEL, dryRun: true })).toBeNull();
  });

  it("refuses to preview a cohort — this arm is per-parcel only", () => {
    const refusal = remintPreviewRefusal({ remintPreview: true, parcel: null, dryRun: true });
    expect(refusal).toContain("--remint-preview requires --parcel");
  });

  it("refuses the dry leg on an apply run — the payload is seen BEFORE the write, never instead of it", () => {
    const refusal = remintPreviewRefusal({ remintPreview: true, parcel: PARCEL, dryRun: false });
    expect(refusal).toContain("must not be combined with --promote");
  });

  it("says nothing when the flag is absent — a plain run is not refused by this gate", () => {
    expect(remintPreviewRefusal({ remintPreview: false, parcel: null, dryRun: false })).toBeNull();
  });
});

describe("remint preview — the empty case", () => {
  it("says nothing would be written and why, rather than printing an empty list", () => {
    const preview = emptyRemintPreview(PARCEL, "no zoning-fact row for this parcel");
    expect(preview.wouldWrite).toEqual([]);
    expect(preview.setbackRule).toBeNull();
    expect(preview.deletesExistingDisclosure).toBe(false);
    expect(preview.note).toContain("NOTHING WOULD BE WRITTEN");
    expect(preview.note).toContain("no zoning-fact row for this parcel");
  });
});
