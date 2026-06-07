import type { PdfPageText } from "@hauska-engine/corpus/adapters";

/** Representative ADA 2010 Standards page text for hermetic ingest tests. */
export const ADA_2010_FIXTURE_PAGES: ReadonlyArray<PdfPageText> = [
  {
    pageNumber: 41,
    text: [
      "ADA CHAPTER 1: APPLICATION AND ADMINISTRATION",
      "101.1 General. This document contains scoping and technical requirements for accessibility to sites ,",
      "203.1 General. Facilities subject to these requirements are not required to comply when not altered.",
      "404.2.3 Maneuvering Clearances. Minimum maneuvering clearances at manual doors shall comply.",
      "609.1 General. Grab bars shall be installed in toilet facilities.",
      "206.2.1 Site Arrival Points. At least one accessible route shall connect site arrival points.",
      "106.5 Defined Terms. For the purpose of this document, the terms defined here have the indicated meaning.",
      "See Section 609.1 for grab bar requirements.",
    ].join("\n"),
  },
];
