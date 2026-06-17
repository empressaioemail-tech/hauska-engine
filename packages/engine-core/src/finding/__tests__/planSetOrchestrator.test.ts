import { describe, expect, it } from "vitest";
import {
  generateOrchestratedFindings,
  resolveFindingOrchestratedMode,
} from "../planSet/orchestrator";
import type { GenerateFindingsInput } from "../types";

function makeBaseInput(): GenerateFindingsInput {
  return {
    submission: {
      id: "sub-orch-1",
      jurisdiction: "Bastrop, TX",
      projectName: "Multi-sheet test",
      note: null,
    },
    sources: [
      {
        id: "src-zoning",
        layerKind: "qgis-zoning",
        sourceKind: "manual-upload",
        provider: "Bastrop UDC",
        snapshotDate: "2026-01-01",
        note: null,
      },
    ],
    codeSections: [
      { atomId: "code-bastrop-udc-4-3-2-b", label: "Bastrop UDC §4.3.2.B" },
      { atomId: "code-nec-210", label: "NEC 210" },
    ],
    bimElements: [{ ref: "wall:north", label: "North wall" }],
  };
}

describe("generateOrchestratedFindings", () => {
  it("runs a specialist pass per discipline and tags findings", async () => {
    const result = await generateOrchestratedFindings(
      {
        baseInput: makeBaseInput(),
        pieceCandidates: [
          {
            pieceId: "sheet-a",
            kind: "sheet",
            label: "A-101 — Floor Plan",
            text: "General notes",
            sheetNumber: "A-101",
          },
          {
            pieceId: "sheet-e",
            kind: "sheet",
            label: "E-101 — Electrical Plan",
            text: "Panel schedule",
            sheetNumber: "E-101",
          },
        ],
      },
      { mode: "mock", ulid: () => "ULIDORCH1" },
    );

    expect(result.orchestration.orchestrated).toBe(true);
    expect([...result.orchestration.disciplinesRun].sort()).toEqual([
      "building",
      "electrical",
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.atomId.startsWith("finding:sub-orch-1:")).toBe(true);
      expect(f.discipline).toBeTruthy();
      expect(f.citations.length).toBeGreaterThan(0);
    }
    const disciplines = new Set(result.findings.map((f) => f.discipline));
    expect(disciplines.has("building") || disciplines.has("electrical")).toBe(
      true,
    );
  });

  it("resolveFindingOrchestratedMode reads AIR_FINDING_ORCHESTRATED", () => {
    const prev = process.env.AIR_FINDING_ORCHESTRATED;
    process.env.AIR_FINDING_ORCHESTRATED = "true";
    expect(resolveFindingOrchestratedMode()).toBe(true);
    process.env.AIR_FINDING_ORCHESTRATED = "0";
    expect(resolveFindingOrchestratedMode()).toBe(false);
    if (prev === undefined) delete process.env.AIR_FINDING_ORCHESTRATED;
    else process.env.AIR_FINDING_ORCHESTRATED = prev;
  });
});
