/**
 * Content-stream reader and rewriter for the pdf-lib sheet output.
 *
 * SCOPE, and why it is this narrow. pdf-lib 1.17 emits one rigidly uniform
 * shape for every `page.drawText` call:
 *
 *     q
 *     BT
 *     <r> <g> <b> rg
 *     /FontResourceName <size> Tf
 *     <leading> TL
 *     <a> <b> <c> <d> <e> <f> Tm
 *     <hex> Tj
 *     T*
 *     ET
 *     Q
 *
 * Measured on the site-plan export at `origin/main` d3f3794: 458 of 458 text
 * blocks across all three sheets match that shape exactly, and every other
 * line in the stream is a vector-path operator. This module therefore parses
 * exactly that grammar and REFUSES anything else. It is not a general PDF
 * content-stream parser and must never be used as one; a stream it does not
 * recognise raises instead of being passed through, because a half-tagged PDF
 * that reports success is the defect this whole exercise exists to remove.
 *
 * THE REWRITE IS POSITION-PRESERVING BY CONSTRUCTION. Every glyph keeps its
 * own `rg`, its own `Tf` and its own ABSOLUTE `Tm`. Merging consecutive
 * single-glyph blocks only removes the `q`/`BT`/`TL`/`T*`/`ET`/`Q` scaffolding
 * BETWEEN them; no coordinate, font, size or colour operand is recomputed, so
 * the rendered page cannot move. `TL` and `T*` are droppable precisely because
 * the next operator is always an absolute `Tm` (or `ET`), which discards
 * whatever the text-line matrix had become.
 *
 * WHY MERGE AT ALL. The renderer draws letter-spaced runs one glyph per
 * `drawText`, each with its own `T*`. A text extractor sees a line break after
 * every letter: 300 of 461 extracted lines on the sample sheet are a single
 * character. Merging the blocks makes the run one text object again, which is
 * what a reader, an extractor and a structure element all need.
 */

/** Thrown when the stream does not match the grammar above. Never swallowed. */
export class ContentStreamRefusal extends Error {
  constructor(message: string) {
    super(`content-stream refusal: ${message}`);
    this.name = "ContentStreamRefusal";
  }
}

export interface TextBlock {
  kind: "text";
  /** Inner operator lines to re-emit, with TL and T* removed. */
  glyphLines: string[];
  /** The original `q .. Q` block, byte for byte. */
  raw: string;
  fontSize: number;
  /** Text-space translation from the block's `Tm` (a b c d e f). */
  x: number;
  y: number;
  matrix: [number, number, number, number, number, number];
  /** Hex show operands in this block, in order. */
  hexes: string[];
}

export interface RawSegment {
  kind: "raw";
  text: string;
  /** True when `q`/`Q` are balanced inside the segment and never go negative. */
  balanced: boolean;
}

export type Segment = TextBlock | RawSegment;

const TM_RE = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm$/;
const TF_RE = /^\/(\S+)\s+(-?[\d.]+)\s+Tf$/;
const TL_RE = /^(-?[\d.]+)\s+TL$/;
const RG_RE = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg$/;
const TJ_RE = /^<([0-9A-Fa-f]+)>\s+Tj$/;

/** Splits a decoded page content stream into text blocks and raw runs. */
export function parseContentStream(stream: string): Segment[] {
  const lines = stream.split("\n");
  const segments: Segment[] = [];
  let rawBuffer: string[] = [];

  const flushRaw = (): void => {
    if (rawBuffer.length === 0) return;
    const text = rawBuffer.join("\n");
    segments.push({ kind: "raw", text, balanced: isBalanced(rawBuffer) });
    rawBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "q" && lines[i + 1]?.trim() === "BT") {
      const etIndex = findLine(lines, i + 2, "ET");
      if (etIndex === -1) throw new ContentStreamRefusal("BT with no matching ET");
      if (lines[etIndex + 1]?.trim() !== "Q") {
        throw new ContentStreamRefusal("text block does not close with Q after ET");
      }
      const inner = lines.slice(i + 2, etIndex).map((l) => l.trim()).filter((l) => l.length > 0);
      const block = parseTextBlock(inner, lines.slice(i, etIndex + 2).join("\n"));
      flushRaw();
      segments.push(block);
      i = etIndex + 2;
      continue;
    }
    rawBuffer.push(line);
    i += 1;
  }
  flushRaw();
  return segments;
}

function findLine(lines: string[], from: number, token: string): number {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i]!.trim() === token) return i;
  }
  return -1;
}

function isBalanced(lines: string[]): boolean {
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === "q") depth += 1;
    else if (t === "Q") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function parseTextBlock(inner: string[], raw: string): TextBlock {
  const glyphLines: string[] = [];
  const hexes: string[] = [];
  let fontSize: number | null = null;
  let matrix: [number, number, number, number, number, number] | null = null;

  for (const line of inner) {
    if (TL_RE.test(line)) continue; // leading only feeds T*, which we drop
    if (line === "T*") continue; // always followed by an absolute Tm or ET
    const tf = TF_RE.exec(line);
    if (tf) {
      fontSize = Number(tf[2]);
      glyphLines.push(line);
      continue;
    }
    const tm = TM_RE.exec(line);
    if (tm) {
      matrix = [
        Number(tm[1]),
        Number(tm[2]),
        Number(tm[3]),
        Number(tm[4]),
        Number(tm[5]),
        Number(tm[6]),
      ];
      glyphLines.push(line);
      continue;
    }
    const tj = TJ_RE.exec(line);
    if (tj) {
      hexes.push(tj[1]!);
      glyphLines.push(line);
      continue;
    }
    if (RG_RE.test(line)) {
      glyphLines.push(line);
      continue;
    }
    throw new ContentStreamRefusal(`unrecognised operator inside a text block: ${line}`);
  }

  if (fontSize === null) throw new ContentStreamRefusal("text block has no Tf");
  if (matrix === null) throw new ContentStreamRefusal("text block has no Tm");
  if (hexes.length === 0) throw new ContentStreamRefusal("text block shows no text");

  return {
    kind: "text",
    glyphLines,
    raw,
    fontSize,
    x: matrix[4],
    y: matrix[5],
    matrix,
    hexes,
  };
}

/**
 * Consecutive single-glyph blocks that belong to one letter-spaced run.
 *
 * MERGE PREDICATE, stated where it is used: adjacent in the stream, exactly
 * one show operand each, identical font size, identical `Tm` a/b/c/d, the same
 * baseline to within 0.01pt, x strictly increasing, and an x step no larger
 * than 1.25x the font size.
 *
 * The step ceiling is what keeps two different words on one line from being
 * welded together: a letter step is one glyph advance plus tracking (about
 * 0.5x to 0.9x the size), while the step from the end of one word to the start
 * of the next is the whole preceding word. It is a positive test for
 * "continues the same run", not a test for "is nearby".
 */
export function groupGlyphRuns(segments: readonly Segment[]): Array<TextBlock[]> {
  const groups: Array<TextBlock[]> = [];
  let current: TextBlock[] = [];

  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const segment of segments) {
    if (segment.kind !== "text") {
      flush();
      continue;
    }
    if (current.length === 0) {
      current = [segment];
      continue;
    }
    const previous = current[current.length - 1]!;
    if (continuesRun(previous, segment)) current.push(segment);
    else {
      flush();
      current = [segment];
    }
  }
  flush();
  return groups;
}

function continuesRun(previous: TextBlock, next: TextBlock): boolean {
  if (previous.hexes.length !== 1 || next.hexes.length !== 1) return false;
  if (previous.fontSize !== next.fontSize) return false;
  for (let i = 0; i < 4; i += 1) {
    if (previous.matrix[i] !== next.matrix[i]) return false;
  }
  if (Math.abs(previous.y - next.y) > 0.01) return false;
  const step = next.x - previous.x;
  if (step <= 0) return false;
  return step <= previous.fontSize * 1.25;
}

export interface RewriteResult {
  /** The rewritten content stream. */
  stream: string;
  /** One entry per marked-content sequence written, in stream order. */
  marks: Array<{ mcid: number; x: number; y: number; fontSize: number; glyphCount: number }>;
  /** Raw runs emitted WITHOUT artifact marking because q/Q was unbalanced. */
  unmarkedRawSegments: number;
  /** Text blocks folded into a preceding block by the merge predicate. */
  mergedBlocks: number;
}

/**
 * Rewrites a page's content stream so every text run is one marked-content
 * sequence carrying an /MCID, and every vector run is marked /Artifact.
 *
 * Degradation is DECLARED, never silent: a raw run whose `q`/`Q` do not
 * balance is emitted verbatim and counted in `unmarkedRawSegments`, because
 * wrapping it would produce improperly nested marked content, which is a
 * worse defect than an unmarked artifact.
 */
export function rewriteContentStream(segments: readonly Segment[], startMcid = 0): RewriteResult {
  const groups = groupGlyphRuns(segments);
  const groupByFirst = new Map<TextBlock, TextBlock[]>();
  for (const group of groups) groupByFirst.set(group[0]!, group);
  const inGroup = new Set<TextBlock>();
  for (const group of groups) for (const block of group.slice(1)) inGroup.add(block);

  const out: string[] = [];
  const marks: RewriteResult["marks"] = [];
  let mcid = startMcid;
  let unmarkedRawSegments = 0;
  let mergedBlocks = 0;

  for (const segment of segments) {
    if (segment.kind === "raw") {
      if (segment.text.trim().length === 0) {
        out.push(segment.text);
        continue;
      }
      if (segment.balanced) {
        out.push("/Artifact BMC");
        out.push(segment.text);
        out.push("EMC");
      } else {
        unmarkedRawSegments += 1;
        out.push(segment.text);
      }
      continue;
    }
    if (inGroup.has(segment)) continue; // already emitted by its group leader

    const group = groupByFirst.get(segment) ?? [segment];
    out.push(`/P <</MCID ${mcid}>> BDC`);
    if (group.length === 1) {
      out.push(segment.raw);
    } else {
      mergedBlocks += group.length - 1;
      out.push("q");
      out.push("BT");
      for (const block of group) out.push(...block.glyphLines);
      out.push("ET");
      out.push("Q");
    }
    out.push("EMC");
    marks.push({
      mcid,
      x: segment.x,
      y: segment.y,
      fontSize: segment.fontSize,
      glyphCount: group.reduce((n, b) => n + b.hexes.length, 0),
    });
    mcid += 1;
  }

  return { stream: out.join("\n"), marks, unmarkedRawSegments, mergedBlocks };
}
