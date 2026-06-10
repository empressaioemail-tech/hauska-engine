/**
 * Per-discipline Claude Opus 4.8 high-resolution vision read (P2).
 *
 * HR-12 escalation: operator-approved for Miami Beach whole-review bootstrap.
 * Reads classified plan-set sheet images against retrieved code atoms; output
 * is merged into piece text before Grok finding synthesis.
 *
 * Opus 4.8: no temperature/top_p/budget_tokens (400 if sent) — adaptive thinking only.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { CodeSectionInput } from "./types";
import type { PlanSetPieceInput } from "./planSet/types";

/** Operator-approved HR-12 escalation for per-sheet drawing read. */
export const FINDING_VISION_ANTHROPIC_MODEL = "claude-opus-4-8";

export const FINDING_VISION_MAX_TOKENS = 4096;

/** Max sheet images per discipline vision pass (token budget guard). */
export const FINDING_VISION_MAX_SHEETS_PER_PASS = 6;

export interface AttachedSheetImage {
  pieceId: string;
  pngBase64: string;
  label?: string;
}

type VisionContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/png"; data: string };
    };

const VISION_SYSTEM_PROMPT = [
  "You are a licensed plan reviewer reading architectural drawing sheets.",
  "Examine every supplied sheet image at high resolution.",
  "For the given discipline scope, report ONLY observable compliance issues",
  "or missing information visible on the drawings — panel schedules, return-air",
  "sizes, riser diagrams, equipment tags, notes, dimensions.",
  "Cite code sections from the reference block when applicable.",
  "Do NOT invent sheet content not visible in the images.",
  "Respond with plain-text observations (not JSON). One paragraph per sheet.",
].join(" ");

function describeCodeSection(c: CodeSectionInput): string {
  const lines = [`- atomId=${c.atomId}`, `  label: ${c.label}`];
  if (c.snippet) {
    lines.push(`  snippet: ${c.snippet.replace(/\n/g, " ").trim()}`);
  }
  return lines.join("\n");
}

function buildVisionUserBlocks(
  discipline: string,
  pieces: ReadonlyArray<PlanSetPieceInput>,
  images: ReadonlyArray<AttachedSheetImage>,
  codeSections: ReadonlyArray<CodeSectionInput>,
): VisionContentBlock[] {
  const blocks: VisionContentBlock[] = [];
  const imageByPiece = new Map(images.map((i) => [i.pieceId, i]));

  blocks.push({
    type: "text",
    text:
      `<discipline_scope>${discipline}</discipline_scope>\n` +
      `Read these ${pieces.length} sheet(s) for ${discipline} issues.`,
  });

  if (codeSections.length > 0) {
    blocks.push({
      type: "text",
      text:
        `<reference_code_atoms>\n` +
        `${codeSections.map(describeCodeSection).join("\n")}\n` +
        `</reference_code_atoms>`,
    });
  }

  for (const piece of pieces.slice(0, FINDING_VISION_MAX_SHEETS_PER_PASS)) {
    const img = imageByPiece.get(piece.pieceId);
    if (!img) continue;
    blocks.push({
      type: "text",
      text: `<sheet pieceId="${piece.pieceId}" label="${piece.label}">`,
    });
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: img.pngBase64,
      },
    });
    blocks.push({
      type: "text",
      text: `</sheet>`,
    });
  }

  return blocks;
}

export interface VisionSheetReadResult {
  observations: string;
  model: string;
  sheetCount: number;
}

/**
 * Run Claude Opus vision read for one discipline's classified sheets.
 * Returns observation text appended to specialist input before Grok synthesis.
 */
export async function runDisciplineVisionRead(
  client: Anthropic,
  args: {
    discipline: string;
    pieces: ReadonlyArray<PlanSetPieceInput>;
    images: ReadonlyArray<AttachedSheetImage>;
    codeSections: ReadonlyArray<CodeSectionInput>;
    log?: (msg: string, meta?: Record<string, unknown>) => void;
  },
): Promise<VisionSheetReadResult | null> {
  const withImages = args.pieces.filter((p) =>
    args.images.some((i) => i.pieceId === p.pieceId),
  );
  if (withImages.length === 0) return null;

  args.log?.("finding vision read: claude-opus-4-8 escalation starting", {
    discipline: args.discipline,
    sheetCount: withImages.length,
    model: FINDING_VISION_ANTHROPIC_MODEL,
  });

  const userBlocks = buildVisionUserBlocks(
    args.discipline,
    withImages,
    args.images,
    args.codeSections,
  );

  const response = await client.messages.create({
    model: FINDING_VISION_ANTHROPIC_MODEL,
    max_tokens: FINDING_VISION_MAX_TOKENS,
    system: VISION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
  });

  const observations = response.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  args.log?.("finding vision read: claude-opus-4-8 escalation completed", {
    discipline: args.discipline,
    observationChars: observations.length,
    model: FINDING_VISION_ANTHROPIC_MODEL,
  });

  return {
    observations,
    model: FINDING_VISION_ANTHROPIC_MODEL,
    sheetCount: withImages.length,
  };
}

/** Merge vision observations into plan-set piece text for Grok synthesis. */
export function enrichPiecesWithVisionObservations(
  pieces: ReadonlyArray<PlanSetPieceInput>,
  observations: string,
): PlanSetPieceInput[] {
  if (!observations.trim()) return [...pieces];
  const visionBlock =
    `[vision-read claude-opus-4-8]\n${observations.trim()}`;
  return pieces.map((p) => ({
    ...p,
    text: p.text?.trim()
      ? `${p.text.trim()}\n\n${visionBlock}`
      : visionBlock,
  }));
}
