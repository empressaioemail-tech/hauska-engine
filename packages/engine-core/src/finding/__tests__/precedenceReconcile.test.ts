/**
 * Precedence reconciliation tests — ADR-019/021 rules + ADA/FHA/A117.1 demo.
 */

import { describe, expect, it } from "vitest";
import {
  buildAdaFhaA117DoorClearanceRequirements,
  buildFederalPreemptPair,
  buildLocalAmendmentOverlayRequirement,
  A1171_DOOR_CLEARANCE_ATOM_ID,
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  reconcileRequirementsByTopic,
  reconcileStandardPrecedence,
  formatPrecedenceFindingText,
  detectStandardDescriptor,
  compareStringency,
} from "../precedence";
import type { ApplicableRequirement } from "../precedence";

describe("reconcileStandardPrecedence — most-stringent-governs", () => {
  it("selects the higher minimum among federal accessibility requirements", () => {
    const requirements = buildFederalPreemptPair();
    const result = reconcileStandardPrecedence(requirements, {
      domain: "accessibility",
    });

    expect(result).not.toBeNull();
    expect(result!.governing.atomId).toBe(FHA_DOOR_CLEARANCE_ATOM_ID);
    expect(result!.governing.numericValue).toBe(24);
    expect(result!.ruleApplied).toBe("most-stringent-governs");
    expect(result!.compared).toHaveLength(2);
    expect(result!.citations).toHaveLength(2);
    expect(result!.citations.every((c) => c.kind === "code-section")).toBe(true);
    expect(result!.confidence).toBe(0.91);
    expect(result!.reasoningChain.some((s) => s.includes("most-stringent"))).toBe(
      true,
    );
  });
});

describe("reconcileStandardPrecedence — federal-preempts", () => {
  it("two federal plus model-code: federal preempt in chain, most-stringent governs", () => {
    const requirements = buildAdaFhaA117DoorClearanceRequirements();
    const result = reconcileStandardPrecedence(requirements, {
      domain: "accessibility",
    });

    expect(result).not.toBeNull();
    expect(result!.governing.atomId).toBe(FHA_DOOR_CLEARANCE_ATOM_ID);
    expect(result!.governing.numericValue).toBe(24);
    expect(result!.ruleApplied).toBe("most-stringent-governs");
    expect(result!.compared).toHaveLength(3);
    expect(result!.citations.map((c) => (c.kind === "code-section" ? c.atomId : c.id))).toEqual(
      expect.arrayContaining([
        ADA_DOOR_CLEARANCE_ATOM_ID,
        FHA_DOOR_CLEARANCE_ATOM_ID,
        A1171_DOOR_CLEARANCE_ATOM_ID,
      ]),
    );
    expect(result!.confidence).toBe(0.75);
    expect(
      result!.reasoningChain.some((s) => s.includes("preempt model-code")),
    ).toBe(true);
    expect(
      result!.reasoningChain.some((s) => s.includes("most-stringent-governs")),
    ).toBe(true);
    expect(
      result!.reasoningChain.some((s) => s.includes("A117.1")),
    ).toBe(true);
    expect(result!.conflicts.every((c) => c.competingAtomIds.length === 3)).toBe(
      true,
    );
  });

  it("single federal preempts model-code when no intra-tier stringency contest", () => {
    const requirements = buildAdaFhaA117DoorClearanceRequirements().filter(
      (r) => r.authority !== "federal" || r.atomId === FHA_DOOR_CLEARANCE_ATOM_ID,
    );
    const result = reconcileStandardPrecedence(requirements, {
      domain: "accessibility",
    });

    expect(result).not.toBeNull();
    expect(result!.governing.atomId).toBe(FHA_DOOR_CLEARANCE_ATOM_ID);
    expect(result!.ruleApplied).toBe("federal-preempts-where-applicable");
    expect(result!.compared).toHaveLength(2);
    expect(
      result!.reasoningChain.some((s) => s.includes("preempt model-code")),
    ).toBe(true);
  });

  it("surfaces every compared standard in formatted finding text with citations", () => {
    const result = reconcileStandardPrecedence(
      buildAdaFhaA117DoorClearanceRequirements(),
      { domain: "accessibility" },
    )!;
    const text = formatPrecedenceFindingText(result);

    expect(text).toContain(`[[CODE:${ADA_DOOR_CLEARANCE_ATOM_ID}]]`);
    expect(text).toContain(`[[CODE:${FHA_DOOR_CLEARANCE_ATOM_ID}]]`);
    expect(text).toContain(`[[CODE:${A1171_DOOR_CLEARANCE_ATOM_ID}]]`);
    expect(text).toContain("most-stringent-governs");
    expect(text).toContain("24");
  });
});

describe("reconcileStandardPrecedence — local-amendment-overlay", () => {
  it("local amendment overlays model-code before federal preempt", () => {
    const base = buildAdaFhaA117DoorClearanceRequirements();
    const modelOnly = base.filter((r) => r.authority === "model-code");
    const local = buildLocalAmendmentOverlayRequirement(modelOnly[0]!.atomId);
    const requirements = [...modelOnly, local];

    const result = reconcileStandardPrecedence(requirements, {
      domain: "dimensional",
      federalPreempts: false,
    });

    expect(result).not.toBeNull();
    expect(result!.ruleApplied).toBe("local-amendment-overlays-model-code");
    expect(result!.governing.numericValue).toBe(20);
    expect(result!.governing.authority).toBe("local-amendment");
    expect(
      result!.reasoningChain.some((s) => s.includes("Local amendment")),
    ).toBe(true);
  });
});

describe("reconcileStandardPrecedence — conflict-surface", () => {
  it("emits conflict-unresolved for incomparable qualitative requirements", () => {
    const a: ApplicableRequirement = {
      atomId: "code/a/1",
      standardKey: "ada-2010",
      standardLabel: "ADA",
      authority: "federal",
      topic: "signage",
      dimension: "tactile character height",
      requirementKind: "qualitative",
      textValue: "Uppercase sans-serif",
      citationLabel: "ADA §703.2",
      confidence: 0.9,
    };
    const b: ApplicableRequirement = {
      atomId: "code/b/1",
      standardKey: "fha-design-manual",
      standardLabel: "FHA",
      authority: "federal",
      topic: "signage",
      dimension: "tactile character height",
      requirementKind: "qualitative",
      textValue: "Uppercase mixed-case allowed",
      citationLabel: "FHA §7.4",
      confidence: 0.85,
    };

    const result = reconcileStandardPrecedence([a, b], { domain: "accessibility" });
    expect(result!.ruleApplied).toBe("conflict-unresolved");
    expect(result!.conflicts.some((c) => c.status === "unresolved")).toBe(true);
    expect(result!.compared).toHaveLength(2);
  });

  it("never silently drops a compared standard from citations", () => {
    const result = reconcileStandardPrecedence(
      buildAdaFhaA117DoorClearanceRequirements(),
      { domain: "accessibility" },
    )!;
    const citedIds = new Set(
      result.citations.map((c) => (c.kind === "code-section" ? c.atomId : c.id)),
    );
    for (const req of result.compared) {
      expect(citedIds.has(req.atomId)).toBe(true);
    }
  });
});

describe("reconcileRequirementsByTopic", () => {
  it("reconciles each topic group independently", () => {
    const door = buildAdaFhaA117DoorClearanceRequirements();
    const grabBar: ApplicableRequirement = {
      atomId: "federal-accessibility-standards/2010-ada-standards/609.4",
      standardKey: "ada-2010",
      standardLabel: "2010 ADA Standards",
      authority: "federal",
      topic: "grab-bar-height",
      dimension: "height above floor",
      requirementKind: "minimum",
      numericValue: 33,
      numericUnit: "in",
      citationLabel: "ADA §609.4",
      confidence: 0.93,
    };
    const grabBarFha: ApplicableRequirement = {
      ...grabBar,
      atomId: "federal-accessibility-standards/fha-design-manual/grab-bar",
      standardKey: "fha-design-manual",
      standardLabel: "FHA Design Manual",
      topic: "grab-bar-height",
      citationLabel: "FHA Ch.6 grab bars",
      numericValue: 33,
      confidence: 0.9,
    };

    const { reconciliations, uncontested } = reconcileRequirementsByTopic({
      requirements: [...door, grabBar, grabBarFha],
      options: { domain: "accessibility" },
    });

    expect(reconciliations).toHaveLength(2);
    expect(uncontested).toHaveLength(0);
    expect(reconciliations.map((r) => r.topic).sort()).toEqual([
      "door-maneuvering-clearance",
      "grab-bar-height",
    ]);
  });
});

describe("detectStandardDescriptor", () => {
  it("recognizes ADA, FHA, and A117.1 corpus atom ids", () => {
    expect(
      detectStandardDescriptor(
        ADA_DOOR_CLEARANCE_ATOM_ID,
        "ADA §404.2.3",
      )?.standardKey,
    ).toBe("ada-2010");
    expect(
      detectStandardDescriptor(
        FHA_DOOR_CLEARANCE_ATOM_ID,
        "FHA door clearance",
      )?.standardKey,
    ).toBe("fha-design-manual");
    expect(
      detectStandardDescriptor(
        A1171_DOOR_CLEARANCE_ATOM_ID,
        "A117.1 §404",
      )?.authority,
    ).toBe("model-code");
  });
});

describe("compareStringency", () => {
  it("ranks higher minimum as more stringent", () => {
    const ada = buildAdaFhaA117DoorClearanceRequirements()[0]!;
    const fha = buildAdaFhaA117DoorClearanceRequirements()[1]!;
    const cmp = compareStringency(fha, ada);
    expect(cmp.comparable).toBe(true);
    expect(cmp.delta).toBeGreaterThan(0);
  });
});
