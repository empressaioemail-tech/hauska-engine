/**
 * ICC Code Connect fixture — a representative slice of the 2021 IRC.
 *
 * Built from the real Code Connect response models (verified live 2026-07-05).
 * NOT a captured real payload — Code Connect is credential-gated.
 *
 * The slice is small but exercises every block kind the adapter emits:
 * a Definitions chapter with structurally-tagged terms, a Building
 * Planning chapter with prose, a table, a figure, and inline
 * cross-references in the model-code "Section R301.2" / "Table ..."
 * citation style.
 *
 * IMPORTANT: Fixture content must be synthetic placeholder text, NEVER
 * real ICC code text (licensing/derivative boundary).
 */

import type { CodeConnectFixtures, CodeConnectBook } from "../code-connect-client.js";

import {
  A117_2021_DOCUMENT,
  A117_2021_BOOK,
  A117_2021_BOOK_ID,
} from "./a117-2021.js";

export { A117_2021_DOCUMENT, A117_2021_BOOK, A117_2021_BOOK_ID } from "./a117-2021.js";

export const IRC_2021_BOOK_ID = "IRC2021P1";

const IRC_2021_BOOK: CodeConnectBook = {
  shortCode: "IRC2021P1",
  uri: {
    category: "I",
    year: "2021",
    titleCode: "IRC",
    printing: "P1",
  },
  printing: "First Printing: May 2020",
  title: "2021 International Residential Code",
  accessStartDate: "2020-01-01",
  accessEndDate: "2027-12-31",
};

export const ICC_CODE_CONNECT_FIXTURES: CodeConnectFixtures = {
  books: [
    IRC_2021_BOOK,
    {
      shortCode: "IRC2018P1",
      uri: {
        category: "I",
        year: "2018",
        titleCode: "IRC",
        printing: "P1",
      },
      printing: "First Printing: May 2017",
      title: "2018 International Residential Code",
      accessStartDate: "2017-01-01",
      accessEndDate: "2027-12-31",
    },
    {
      shortCode: "IBC2021P1",
      uri: {
        category: "I",
        year: "2021",
        titleCode: "IBC",
        printing: "P1",
      },
      printing: "First Printing: May 2020",
      title: "2021 International Building Code",
      accessStartDate: "2020-01-01",
      accessEndDate: "2027-12-31",
    },
    {
      shortCode: "IECC2021P1",
      uri: {
        category: "I",
        year: "2021",
        titleCode: "IECC",
        printing: "P1",
      },
      printing: "First Printing: May 2020",
      title: "2021 International Energy Conservation Code",
      accessStartDate: "2020-01-01",
      accessEndDate: "2027-12-31",
    },
    A117_2021_BOOK,
  ],

  documents: {
    [IRC_2021_BOOK_ID]: {
      book: IRC_2021_BOOK,
      chapters: [
        {
          bookId: IRC_2021_BOOK_ID,
          chapters: [
            {
              ordinal: "2",
              ordinalClean: "2",
              title: "Definitions",
              id: "IRC2021_Ch02",
              dtype: "chapter",
            },
          ],
          sections: {
            "IRC2021_Ch02_SecR201": {
              type: "codeSection",
              label: "SECTION",
              title: "General",
              xmlId: "IRC2021_Ch02_SecR201",
              content: "<p>Fixture text for R201 General. Terms are defined in Section R202.</p>",
              ordinal: "R201",
              ordinalClean: "R201",
              children: [],
            },
            "IRC2021_Ch02_SecR202": {
              type: "codeSection",
              label: "SECTION",
              title: "Definitions",
              xmlId: "IRC2021_Ch02_SecR202",
              content: "<p>Fixture text for R202 Definitions.</p>",
              ordinal: "R202",
              ordinalClean: "R202",
              children: [],
            },
          },
        },
        {
          bookId: IRC_2021_BOOK_ID,
          chapters: [
            {
              ordinal: "3",
              ordinalClean: "3",
              title: "Building Planning",
              id: "IRC2021_Ch03",
              dtype: "chapter",
            },
          ],
          sections: {
            "IRC2021_Ch03_SecR301": {
              type: "codeSection",
              label: "SECTION",
              title: "Design Criteria",
              xmlId: "IRC2021_Ch03_SecR301",
              content: "<p>Fixture text for R301. See Table R301.2(1) for design criteria.</p>",
              ordinal: "R301",
              ordinalClean: "R301",
              children: [],
            },
            "IRC2021_Ch03_SecR302": {
              type: "codeSection",
              label: "SECTION",
              title: "Fire-Resistant Construction",
              xmlId: "IRC2021_Ch03_SecR302",
              content: "<p>Fixture text for R302. See Table R302.1(1) for fire separation. Town houses shall comply with Section R302.2. Notwithstanding Section R301, fire ratings are required. Terms are defined in Chapter 2.</p>",
              ordinal: "R302",
              ordinalClean: "R302",
              children: [],
            },
          },
        },
      ],
    },
    [A117_2021_BOOK_ID]: A117_2021_DOCUMENT,
  },

  search: {
    "townhouse fire separation": [
      {
        xmlId: "IRC2021_Ch03_SecR302",
        ordinal: "R302",
        title: "Fire-Resistant Construction",
        content: "Fixture text for R302. Townhouses shall comply with Section R302.2...",
        type: "codeSection",
        label: "SECTION",
        figure: "",
      },
    ],
  },
};
