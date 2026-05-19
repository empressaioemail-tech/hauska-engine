/**
 * Born-digital PDF text extractor — pdfjs-dist backed.
 *
 * Used by RawPdfAdapter when the PDF is born-digital (the publisher
 * embedded selectable text in the document). Sidesteps the OCR path
 * entirely for the common case of municipal codes published as Word /
 * InDesign exports.
 *
 * The extractor returns one PdfPageText per source page. RawPdfAdapter's
 * normalize() walks the pages and infers heading hierarchy from text
 * patterns (CHAPTER N:, ARTICLE N.M, SEC. N.M.NNN — common municipal-code
 * conventions).
 */

import { Buffer } from "node:buffer";

export interface PdfPageText {
  /** 1-indexed page number from the source PDF. */
  pageNumber: number;
  /**
   * Plain text content. Lines are separated by newlines; runs within a
   * line are joined by single spaces. Layout-aware extraction (table
   * cells, columns) is deferred.
   */
  text: string;
}

export type PdfTextExtractor = (
  pdfBytesBase64: string,
) => Promise<ReadonlyArray<PdfPageText>>;

/**
 * Default born-digital extractor backed by pdfjs-dist. Imported lazily
 * so the adapter doesn't pull pdfjs into the bundle when callers
 * provide their own extractor (e.g., a stub in tests).
 */
export const pdfjsTextExtractor: PdfTextExtractor = async (pdfBytesBase64) => {
  // Dynamic import keeps the heavy pdfjs runtime out of the load path
  // for callers that override `textExtractor`.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs requires a workerSrc string in 4.x even when the legacy build
  // contains the worker inline; point at the legacy worker path so the
  // runtime can load it lazily. createRequire lets us resolve a Node
  // module path from an ESM context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalWorkerOptions = (pdfjs as any).GlobalWorkerOptions;
  if (
    globalWorkerOptions &&
    typeof globalWorkerOptions.workerSrc !== "string"
  ) {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    try {
      globalWorkerOptions.workerSrc = req.resolve(
        "pdfjs-dist/legacy/build/pdf.worker.mjs",
      );
    } catch {
      // Fall back to a sentinel string; pdfjs will use its fake-worker
      // fallback path. Avoids throwing when the worker file isn't
      // resolvable (e.g., custom bundling layouts).
      globalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
    }
  }

  const buf = Buffer.from(pdfBytesBase64, "base64");
  // pdfjs-dist 4.x strict-checks for a plain Uint8Array (rejects Buffer
  // by constructor identity even though Buffer extends Uint8Array).
  // Wrap to satisfy the check; the underlying bytes are shared.
  const pdfBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const loadingTask = pdfjs.getDocument({
    data: pdfBytes,
    // Avoid font warnings cluttering stderr during ingest.
    verbosity: 0,
    // Disable range requests + streaming (we have the whole buffer).
    disableRange: true,
    disableStream: true,
  });
  const doc = await loadingTask.promise;
  const pages: PdfPageText[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      // pdfjs returns text items with positional coords (transform,
      // width, height). For born-digital extraction we reconstruct line
      // breaks from item-to-item Y-coordinate jumps; this preserves the
      // CHAPTER / ARTICLE / SEC heading structure that the adapter's
      // normalize() walker relies on.
      const lines: string[] = [];
      let currentLine = "";
      let lastY: number | null = null;
      const Y_JUMP_THRESHOLD = 2; // PDF user-space units
      for (const item of textContent.items) {
        // TextItem has `str` (string) plus `transform` (6-element matrix
        // where transform[5] is the Y baseline) when not a marker item.
        const maybeStr = (item as { str?: unknown }).str;
        const maybeTransform = (item as { transform?: unknown }).transform;
        if (typeof maybeStr !== "string") continue;
        const str = maybeStr;
        const y = Array.isArray(maybeTransform) && typeof maybeTransform[5] === "number"
          ? maybeTransform[5]
          : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > Y_JUMP_THRESHOLD) {
          if (currentLine.length > 0) lines.push(currentLine);
          currentLine = str;
        } else {
          // Append with a space if both sides are non-empty alphanumerics
          // and there's no trailing/leading space already.
          if (
            currentLine.length > 0 &&
            !/\s$/.test(currentLine) &&
            !/^\s/.test(str)
          ) {
            currentLine += " " + str;
          } else {
            currentLine += str;
          }
        }
        if (y !== null) lastY = y;
      }
      if (currentLine.length > 0) lines.push(currentLine);

      pages.push({
        pageNumber: pageNum,
        text: lines.map((line) => line.trim()).join("\n").trim(),
      });

      // pdfjs caches per-page resources; cleanup keeps memory bounded
      // when extracting a 265-page document like Bastrop B3.
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }

  return pages;
};
