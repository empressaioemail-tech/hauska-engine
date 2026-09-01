import { describe, expect, it } from "vitest";

import {
  instantiateParcelRecord,
  texasCtxPermitSourcingUnsourced,
  texasCtxPermitSourcingWithAustin,
} from "../index.js";
import {
  AUSTIN_SODA_PERMIT_SOURCE,
  applyPermitsToRecord,
  normalizeAustinSodaPermitRow,
  placeKeyFromTcadId,
  tcadIdToTravisPropId,
} from "../ingest-permits.js";
import {
  isPermitsSourcedEmptyCell,
  isPermitsUnsourcedCell,
  permitsServeStatesAreDistinct,
  projectPermitsServeField,
  sourcedEmptyPermitsCell,
  unsourcedPermitsCell,
} from "../permits-field.js";

describe("permits column type distinction", () => {
  it("unsourced absent-verified is not the same serve shape as sourced empty-set", () => {
    const unsourced = projectPermitsServeField({
      jurisdictionKey: "bastrop_tx",
      permitsCell: unsourcedPermitsCell("bastrop_tx"),
      companionRows: [],
    });
    const empty = projectPermitsServeField({
      jurisdictionKey: "austin_tx",
      permitsCell: sourcedEmptyPermitsCell(AUSTIN_SODA_PERMIT_SOURCE, "2026-09-01"),
      companionRows: [],
    });
    expect(unsourced.renderAs).toBe("unsourced");
    expect(empty.renderAs).toBe("empty-set");
    expect(permitsServeStatesAreDistinct(unsourced, empty)).toBe(true);
  });

  it("instantiate stamps bastrop unsourced and austin unaccounted when only austin is sourced", () => {
    const sourcing = texasCtxPermitSourcingWithAustin();
    const bastrop = instantiateParcelRecord({
      countyFips: "48021",
      propId: "34137",
      incorporated: true,
      permitsJurisdictionKey: "bastrop_tx",
      permitSourcing: sourcing,
    });
    expect(isPermitsUnsourcedCell(bastrop.cells.permits)).toBe(true);
    expect(bastrop.cells.permits).toMatchObject({
      kind: "absent-verified",
      basis: "permits unsourced for jurisdiction bastrop_tx",
    });

    const austin = instantiateParcelRecord({
      countyFips: "48453",
      propId: "128040103",
      incorporated: true,
      permitsJurisdictionKey: "austin_tx",
      permitSourcing: sourcing,
    });
    expect(austin.cells.permits.kind).toBe("unaccounted");
  });

  it("default registry leaves all known jurisdictions unsourced at instantiate", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48021",
      propId: "1",
      incorporated: true,
      permitsJurisdictionKey: "bastrop_tx",
      permitSourcing: texasCtxPermitSourcingUnsourced(),
    });
    expect(isPermitsUnsourcedCell(rec.cells.permits)).toBe(true);
  });

  it("ingest writes sourced empty-set distinct from unsourced", () => {
    const rec = instantiateParcelRecord({
      countyFips: "48453",
      propId: "128040103",
      incorporated: true,
      permitsJurisdictionKey: "austin_tx",
      permitSourcing: texasCtxPermitSourcingWithAustin(),
    });
    applyPermitsToRecord(rec, [], AUSTIN_SODA_PERMIT_SOURCE, "2026-09-01T12:00:00Z");
    expect(isPermitsSourcedEmptyCell(rec.cells.permits)).toBe(true);

    const unsourced = unsourcedPermitsCell("austin_tx");
    expect(rec.cells.permits.kind).not.toBe(unsourced.kind);
    if (rec.cells.permits.kind === "value" && unsourced.kind === "absent-verified") {
      expect(true).toBe(true);
    }
  });
});

describe("Austin SODA tcad join", () => {
  it("strips leading zeros on numeric tcad_id for Travis prop_id", () => {
    expect(tcadIdToTravisPropId("0128040103")).toBe("128040103");
    expect(placeKeyFromTcadId("0128040103")).toBe("48453:128040103");
  });

  it("preserves non-numeric tcad account ids verbatim", () => {
    expect(tcadIdToTravisPropId("R064814")).toBe("R064814");
  });

  it("normalizes a fixture row into ParcelPermitRow", () => {
    const row = normalizeAustinSodaPermitRow({
      permit_number: "2026-TEST-001 BP",
      permit_type_desc: "Building Permit",
      status_current: "Active",
      issue_date: "2026-07-01T00:00:00.000",
      link: { url: "https://example.test/permit/1" },
    });
    expect(row).toMatchObject({
      permitNumber: "2026-TEST-001 BP",
      permitType: "Building Permit",
      status: "Active",
      sourceId: AUSTIN_SODA_PERMIT_SOURCE,
    });
    expect(row?.issueDate).toMatch(/^2026-07-01/);
  });
});
