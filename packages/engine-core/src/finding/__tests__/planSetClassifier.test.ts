import { describe, expect, it } from "vitest";
import {
  classifyPlanSetPiece,
  classifyPlanSetPieces,
  groupPiecesByDiscipline,
  normalizeSheetNumber,
  toPlanSetPieceInputs,
} from "../planSet/classifier";

describe("planSet classifier", () => {
  it("maps electrical sheet prefixes to electrical discipline", () => {
    const result = classifyPlanSetPiece({
      pieceId: "s1",
      kind: "sheet",
      label: "E-101 — Electrical Plan",
      text: null,
      sheetNumber: "E-101",
    });
    expect(result.discipline).toBe("electrical");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("maps fire protection sheets to fire-life-safety", () => {
    const result = classifyPlanSetPiece({
      pieceId: "s2",
      kind: "sheet",
      label: "FP-101 — Fire Protection",
      text: null,
      sheetNumber: "FP-101",
    });
    expect(result.discipline).toBe("fire-life-safety");
  });

  it("keyword overrides sheet prefix when accessibility terms appear", () => {
    const result = classifyPlanSetPiece({
      pieceId: "s3",
      kind: "sheet",
      label: "A-601 — Accessibility Details",
      text: "ADA clearances and grab bars at restrooms",
      sheetNumber: "A-601",
    });
    expect(result.discipline).toBe("accessibility");
  });

  it("classifies attached calculation documents as building by default", () => {
    const result = classifyPlanSetPiece({
      pieceId: "d1",
      kind: "attached-document",
      label: "Structural calc package",
      text: "Beam design per IBC",
      documentType: "calculation",
    });
    expect(result.discipline).toBe("building");
  });

  it("groups classified pieces by discipline", () => {
    const candidates = [
      {
        pieceId: "s1",
        kind: "sheet" as const,
        label: "A-101",
        text: null,
        sheetNumber: "A-101",
      },
      {
        pieceId: "s2",
        kind: "sheet" as const,
        label: "E-101",
        text: null,
        sheetNumber: "E-101",
      },
    ];
    const classified = classifyPlanSetPieces(candidates);
    const pieces = toPlanSetPieceInputs(candidates, classified);
    const grouped = groupPiecesByDiscipline(pieces);
    expect(grouped.get("building")?.length).toBe(1);
    expect(grouped.get("electrical")?.length).toBe(1);
  });

  it("normalizes sheet numbers for prefix matching", () => {
    expect(normalizeSheetNumber("A-101")).toBe("A101");
    expect(normalizeSheetNumber("fp 2.01")).toBe("FP201");
  });
});
