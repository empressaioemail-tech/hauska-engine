import { describe, expect, it, vi } from "vitest";
import {
  enrichPiecesWithVisionObservations,
  FINDING_VISION_ANTHROPIC_MODEL,
  runDisciplineVisionRead,
} from "../visionSheetRead";
import type { PlanSetPieceInput } from "../planSet/types";

describe("runDisciplineVisionRead", () => {
  it("returns null when no images match discipline pieces", async () => {
    const client = {
      messages: { create: vi.fn() },
    };
    const result = await runDisciplineVisionRead(client as never, {
      discipline: "electrical",
      pieces: [
        {
          pieceId: "a",
          kind: "sheet",
          label: "E-101",
          text: null,
          discipline: "electrical",
          confidence: 0.9,
        },
      ],
      images: [],
      codeSections: [],
    });
    expect(result).toBeNull();
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("calls claude-opus-4-8 without temperature/top_p/budget_tokens", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Panel schedule shows 200A main." }],
    });
    const client = { messages: { create } };
    const pieces: PlanSetPieceInput[] = [
      {
        pieceId: "doc:page1",
        kind: "attached-document",
        label: "E-101",
        text: null,
        discipline: "electrical",
        confidence: 0.8,
      },
    ];
    const result = await runDisciplineVisionRead(client as never, {
      discipline: "electrical",
      pieces,
      images: [{ pieceId: "doc:page1", pngBase64: "abc123" }],
      codeSections: [
        { atomId: "nec-408", label: "NEC Art. 408", snippet: "panelboards" },
      ],
    });
    expect(result?.model).toBe(FINDING_VISION_ANTHROPIC_MODEL);
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-opus-4-8");
    expect(args.temperature).toBeUndefined();
    expect(args.top_p).toBeUndefined();
    expect(args.budget_tokens).toBeUndefined();
    expect(result?.observations).toContain("Panel schedule");
  });
});

describe("enrichPiecesWithVisionObservations", () => {
  it("appends vision block to piece text", () => {
    const pieces: PlanSetPieceInput[] = [
      {
        pieceId: "x",
        kind: "sheet",
        label: "M-101",
        text: "existing",
        discipline: "mechanical",
        confidence: 1,
      },
    ];
    const enriched = enrichPiecesWithVisionObservations(
      pieces,
      "Return air grille undersized at 12x12.",
    );
    expect(enriched[0].text).toContain("existing");
    expect(enriched[0].text).toContain("claude-opus-4-8");
    expect(enriched[0].text).toContain("Return air");
  });
});
