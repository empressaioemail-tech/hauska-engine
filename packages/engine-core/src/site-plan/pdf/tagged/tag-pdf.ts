/**
 * Turns a finished pdf-lib document into a TAGGED PDF, without touching the
 * renderer that produced it (Revised Section 508 criterion 504.2.2).
 *
 * ADDITIVE BY CONSTRUCTION (operator ruling 2026-08-20). The site-plan
 * generator is working software: it is not modified, not replaced and not
 * repointed. This module takes its OUTPUT BYTES and returns new bytes. Nothing
 * calls it by default; `emitPdfSitePlan` is unchanged and unaware of it.
 *
 * WHAT IT WRITES
 *   - /MarkInfo << /Marked true >> on the catalog
 *   - /Lang and a document title (with /ViewerPreferences /DisplayDocTitle)
 *   - /StructTreeRoot over a /Document element, one /Sect per page, one /P per
 *     text run, ordered by measured glyph position rather than draw order
 *   - a parent tree keyed by each page's /StructParents
 *   - marked content in every page stream: /P .. BDC around text, /Artifact
 *     BMC around vector runs
 *
 * WHAT IT DOES NOT WRITE, and why not
 *   - Heading levels. Nothing in a finished content stream says which run is a
 *     heading; inferring it from font size would be a guess written into a
 *     binding structure. Every text run is /P, which is true of all of them.
 *     Real heading structure requires the renderer to declare it, which is an
 *     in-place change to render.ts that the additive constraint forbids.
 *   - /Alt on figures. There is no author-supplied description at this layer
 *     and inventing one is worse than omitting it.
 *   Both are recorded in the result as declared limitations, never as silence.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";

import {
  ContentStreamRefusal,
  parseContentStream,
  rewriteContentStream,
} from "./content-stream.js";
import { countReadingOrderInversions, orderForReading } from "./reading-order.js";

export interface TagPdfOptions {
  /** Document title. Required: an untitled PDF fails 504.2.2 on its own. */
  title: string;
  /** BCP-47 natural language of the content, e.g. "en-US". */
  language: string;
}

export interface TagPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Structure elements written, containers included. */
  structElemCount: number;
  /** Text runs that became structure elements. */
  taggedRuns: number;
  /** Text blocks folded into a preceding run by the glyph-run merge. */
  mergedBlocks: number;
  /** Vector runs left unmarked because their q/Q did not balance. */
  unmarkedRawSegments: number;
  /**
   * Adjacent pairs in the written tree that read backwards. MEASURED after the
   * order is computed, with the same predicate the external acceptance
   * instrument applies to the finished file. Zero is the only passing value.
   */
  readingOrderInversions: number;
  /**
   * Limitations of this layer, in the output rather than in a comment, so a
   * consumer reading the result learns them without reading the source.
   */
  declaredLimitations: string[];
}

const DECLARED_LIMITATIONS = [
  "no heading levels: a finished content stream carries no heading semantics, and inferring them from font size would write a guess into the structure tree",
  "no /Alt on figures: no author-supplied alternative text exists at this layer",
  "structure is flat (Document > Sect per page > P per run): lists, tables and figures are not distinguished",
];

/**
 * Reads a page's content, whether it is one stream or an array of them.
 * Refuses rather than guessing when a content entry is not a raw stream.
 */
function readPageContent(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  if (contents === undefined) return "";
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const entry = contents.lookup(i);
      if (!(entry instanceof PDFStream)) {
        throw new ContentStreamRefusal("page /Contents array holds a non-stream entry");
      }
      streams.push(entry);
    }
  } else {
    streams.push(contents);
  }
  const parts: string[] = [];
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) {
      throw new ContentStreamRefusal("page content is not a raw stream");
    }
    parts.push(Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1"));
  }
  void doc;
  return parts.join("\n");
}

/**
 * Rewrites `bytes` into a tagged PDF. Throws `ContentStreamRefusal` if any
 * page's content stream is not the shape this module understands: a document
 * it cannot fully tag is never returned partially tagged.
 */
export async function tagPdfBytes(
  bytes: Uint8Array,
  options: TagPdfOptions,
): Promise<TagPdfResult> {
  if (!options.title.trim()) throw new Error("tagPdfBytes: title must be non-empty");
  if (!options.language.trim()) throw new Error("tagPdfBytes: language must be non-empty");

  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const structTreeRootRef = ctx.nextRef();
  const documentRef = ctx.nextRef();

  const documentKids: PDFRef[] = [];
  const parentTreeNums: Array<number | PDFArray> = [];
  let structParentsKey = 0;
  let structElemCount = 1; // the /Document element
  let taggedRuns = 0;
  let mergedBlocks = 0;
  let unmarkedRawSegments = 0;
  let inversions = 0;

  for (const page of doc.getPages()) {
    const original = readPageContent(doc, page);
    const segments = parseContentStream(original);
    const rewrite = rewriteContentStream(segments);
    mergedBlocks += rewrite.mergedBlocks;
    unmarkedRawSegments += rewrite.unmarkedRawSegments;

    const streamRef = ctx.nextRef();
    ctx.assign(streamRef, ctx.flateStream(rewrite.stream));
    page.node.set(PDFName.of("Contents"), streamRef);

    if (rewrite.marks.length === 0) {
      // A page with no text has nothing to place in the tree. It still gets no
      // /StructParents, because a key with no parent-tree entry is a dangling
      // reference, not an empty one.
      continue;
    }

    const ordered = orderForReading(rewrite.marks);
    inversions += countReadingOrderInversions(ordered);

    const sectRef = ctx.nextRef();
    const kidRefs: PDFRef[] = [];
    const byMcid: PDFRef[] = new Array(rewrite.marks.length);

    for (const mark of ordered) {
      const elemRef = ctx.nextRef();
      ctx.assign(
        elemRef,
        ctx.obj({
          Type: "StructElem",
          S: "P",
          P: sectRef,
          Pg: page.ref,
          K: mark.mcid,
        }) as PDFDict,
      );
      kidRefs.push(elemRef);
      byMcid[mark.mcid] = elemRef;
      structElemCount += 1;
      taggedRuns += 1;
    }

    for (let i = 0; i < byMcid.length; i += 1) {
      if (!byMcid[i]) {
        // Fail closed: a hole here means a marked-content id in the stream has
        // no structure element, which is exactly the dangling state this
        // module exists to avoid producing.
        throw new ContentStreamRefusal(`MCID ${i} has no structure element`);
      }
    }

    ctx.assign(
      sectRef,
      ctx.obj({
        Type: "StructElem",
        S: "Sect",
        P: documentRef,
        Pg: page.ref,
        K: kidRefs,
      }) as PDFDict,
    );
    structElemCount += 1;
    documentKids.push(sectRef);

    page.node.set(PDFName.of("StructParents"), PDFNumber.of(structParentsKey));
    parentTreeNums.push(structParentsKey, ctx.obj(byMcid) as PDFArray);
    structParentsKey += 1;
  }

  ctx.assign(
    documentRef,
    ctx.obj({ Type: "StructElem", S: "Document", P: structTreeRootRef, K: documentKids }) as PDFDict,
  );
  ctx.assign(
    structTreeRootRef,
    ctx.obj({
      Type: "StructTreeRoot",
      K: [documentRef],
      ParentTree: ctx.obj({ Nums: parentTreeNums }),
      ParentTreeNextKey: structParentsKey,
    }) as PDFDict,
  );

  doc.catalog.set(PDFName.of("StructTreeRoot"), structTreeRootRef);
  doc.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }) as PDFDict);
  doc.setLanguage(options.language);
  doc.setTitle(options.title, { showInWindowTitleBar: true });

  return {
    bytes: await doc.save({ useObjectStreams: false }),
    pageCount: doc.getPageCount(),
    structElemCount,
    taggedRuns,
    mergedBlocks,
    unmarkedRawSegments,
    readingOrderInversions: inversions,
    declaredLimitations: [...DECLARED_LIMITATIONS],
  };
}
