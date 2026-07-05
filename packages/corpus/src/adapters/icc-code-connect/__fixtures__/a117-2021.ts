/**
 * ICC Code Connect fixture slice — 2021 ICC A117.1 (Accessible and
 * Usable Buildings and Facilities).
 *
 * Built from the real Code Connect response models (verified live 2026-07-05).
 * Hand-built from the real response models; replace with captured payloads
 * when real data is available.
 * IMPORTANT: Fixture content must be synthetic placeholder text, NEVER
 * real ICC code text (licensing/derivative boundary).
 */

import type {
  CodeConnectBook,
  IccCodeDocument,
} from "../code-connect-client.js";

export const A117_2021_BOOK_ID = "A11712021P1";

export const A117_2021_BOOK: CodeConnectBook = {
  shortCode: A117_2021_BOOK_ID,
  uri: {
    category: "A",
    year: "2021",
    titleCode: "A117.1",
    printing: "P1",
  },
  printing: "First Printing: May 2020",
  title: "2021 Accessible and Usable Buildings and Facilities",
  accessStartDate: "2020-01-01",
  accessEndDate: "2027-12-31",
};

export const A117_2021_EDITION_LABEL = "2021 Accessible and Usable Buildings and Facilities";

export const A117_2021_DOCUMENT: IccCodeDocument = {
  book: A117_2021_BOOK,
  chapters: [
    {
      bookId: A117_2021_BOOK_ID,
      chapters: [
        {
          ordinal: "1",
          ordinalClean: "1",
          title: "Application and Administration",
          id: "A11712021_Ch01",
          dtype: "chapter",
        },
        {
          ordinal: "4",
          ordinalClean: "4",
          title: "Accessible Routes",
          id: "A11712021_Ch04",
          dtype: "chapter",
        },
        {
          ordinal: "6",
          ordinalClean: "6",
          title: "Plumbing Elements and Facilities",
          id: "A11712021_Ch06",
          dtype: "chapter",
        },
      ],
      sections: {
        "A11712021_Ch01_Sec101": {
          type: "codeSection",
          label: "SECTION",
          title: "Purpose",
          xmlId: "A11712021_Ch01_Sec101",
          content: "<p>Fixture text for section 101 Purpose.</p>",
          ordinal: "101",
          ordinalClean: "101",
          children: [],
        },
        "A11712021_Ch04_Sec403": {
          type: "codeSection",
          label: "SECTION",
          title: "Accessible Routes",
          xmlId: "A11712021_Ch04_Sec403",
          content: "<p>Fixture text for section 403. See Section 404 for doors.</p>",
          ordinal: "403",
          ordinalClean: "403",
          children: [],
        },
        "A11712021_Ch06_Sec604": {
          type: "codeSection",
          label: "SECTION",
          title: "Water Closets and Toilet Compartments",
          xmlId: "A11712021_Ch06_Sec604",
          content: "<p>Fixture text for section 604. Grab bars shall comply with Section 609.</p>",
          ordinal: "604",
          ordinalClean: "604",
          children: [],
        },
        "A11712021_Ch06_Sec609": {
          type: "codeSection",
          label: "SECTION",
          title: "Grab Bars",
          xmlId: "A11712021_Ch06_Sec609",
          content: "<p>Fixture text for section 609 grab bars.</p>",
          ordinal: "609",
          ordinalClean: "609",
          children: [],
        },
      },
    },
  ],
};
