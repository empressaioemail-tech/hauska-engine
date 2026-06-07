import type { PdfPageText } from "@hauska-engine/corpus/adapters";

/** Representative FHA Design Manual page text for hermetic ingest tests. */
export const FHA_DESIGN_MANUAL_FIXTURE_PAGES: ReadonlyArray<PdfPageText> = [
  {
    pageNumber: 40,
    text: [
      "PART TWO: CHAPTER 1",
      "1.2",
      "Definitions from the Guidelines",
      "1.3",
      "ACCESSIBLE BUILDING ENTRANCE ON AN ACCESSIBLE ROUTE",
      "1.10",
      "Accessible Primary Use Entrance",
      "See Section 1.3 for the accessible route requirement.",
      "PART TWO: CHAPTER 3",
      "3.3",
      "USABLE DOORS",
      "See Section 1.10 for entrances.",
      "PART TWO: CHAPTER 6",
      "6.11",
      "Floor-Mounted Grab Bar",
      "PART TWO: CHAPTER 7",
      "7.33",
      "USABLE KITCHENS AND BATHROOMS PART B USABLE BATHROOMS",
    ].join("\n"),
  },
];
