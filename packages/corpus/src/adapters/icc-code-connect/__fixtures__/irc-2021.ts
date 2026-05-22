/**
 * ICC Code Connect fixture — a representative slice of the 2021 IRC.
 *
 * Hand-built from the assumed Code Connect response models (see
 * `code-connect-client.ts`). NOT a captured real payload — Code Connect
 * is credential-gated. When the operator returns with example payloads
 * from the ICC meeting, replace this with a captured fixture and
 * reconcile any shape drift.
 *
 * The slice is small but exercises every block kind the adapter emits:
 * a Definitions chapter with structurally-tagged terms, a Building
 * Planning chapter with prose, a table, a figure, and inline
 * cross-references in the model-code "Section R301.2" / "Table ..."
 * citation style.
 */

import type { CodeConnectFixtures } from "../code-connect-client.js";

export const IRC_2021_TITLE_ID = "IRC2021";

export const ICC_CODE_CONNECT_FIXTURES: CodeConnectFixtures = {
  titles: [
    {
      titleId: "IRC2021",
      codeAbbrev: "IRC",
      name: "International Residential Code",
      year: 2021,
      versionStatus: "current",
    },
    {
      titleId: "IRC2018",
      codeAbbrev: "IRC",
      name: "International Residential Code",
      year: 2018,
      versionStatus: "historical",
    },
    {
      titleId: "IBC2021",
      codeAbbrev: "IBC",
      name: "International Building Code",
      year: 2021,
      versionStatus: "current",
    },
    {
      titleId: "IECC2021",
      codeAbbrev: "IECC",
      name: "International Energy Conservation Code",
      year: 2021,
      versionStatus: "current",
    },
  ],

  documents: {
    IRC2021: {
      title: {
        titleId: "IRC2021",
        codeAbbrev: "IRC",
        name: "International Residential Code",
        year: 2021,
        versionStatus: "current",
      },
      chapters: [
        {
          chapter: {
            chapterId: "IRC2021-CH02",
            titleId: "IRC2021",
            chapterNumber: "2",
            heading: "Definitions",
            sections: [
              {
                sectionId: "IRC2021-R201",
                sectionNumber: "R201",
                heading: "General",
              },
              {
                sectionId: "IRC2021-R202",
                sectionNumber: "R202",
                heading: "Definitions",
              },
            ],
          },
          sections: [
            {
              sectionId: "IRC2021-R201",
              titleId: "IRC2021",
              chapterId: "IRC2021-CH02",
              sectionNumber: "R201",
              heading: "General",
              content: [
                {
                  kind: "prose",
                  text: "Unless otherwise expressly stated, the following words and terms shall, for the purposes of this code, have the meanings shown in this chapter. Terms not defined in Section R202 shall have the meanings stated in the International Building Code.",
                },
              ],
            },
            {
              sectionId: "IRC2021-R202",
              titleId: "IRC2021",
              chapterId: "IRC2021-CH02",
              sectionNumber: "R202",
              heading: "Definitions",
              content: [
                {
                  kind: "prose",
                  text: "The following terms are defined for the purposes of this code.",
                },
              ],
              definedTerms: [
                {
                  term: "HABITABLE SPACE",
                  definition:
                    "A space in a building for living, sleeping, eating or cooking. Bathrooms, toilet rooms, closets, halls, storage or utility spaces and similar areas are not considered habitable spaces.",
                },
                {
                  term: "TOWNHOUSE",
                  definition:
                    "A single-family dwelling unit constructed in a group of three or more attached units in which each unit extends from foundation to roof and with open space on not less than two sides.",
                },
              ],
            },
          ],
        },
        {
          chapter: {
            chapterId: "IRC2021-CH03",
            titleId: "IRC2021",
            chapterNumber: "3",
            heading: "Building Planning",
            sections: [
              {
                sectionId: "IRC2021-R301",
                sectionNumber: "R301",
                heading: "Design Criteria",
              },
              {
                sectionId: "IRC2021-R302",
                sectionNumber: "R302",
                heading: "Fire-Resistant Construction",
              },
            ],
          },
          sections: [
            {
              sectionId: "IRC2021-R301",
              titleId: "IRC2021",
              chapterId: "IRC2021-CH03",
              sectionNumber: "R301",
              heading: "Design Criteria",
              viewerUrl:
                "https://codes.iccsafe.org/content/IRC2021/chapter-3-building-planning#IRC2021_Ch03_SecR301",
              content: [
                {
                  kind: "prose",
                  text: "Buildings and structures, and parts thereof, shall be constructed to safely support all loads, including dead loads, live loads, roof loads, flood loads, snow loads, wind loads and seismic loads as prescribed by this code. The construction of buildings and structures in accordance with the provisions of this code shall result in a system that provides a complete load path. See Table R301.2(1) for the climatic and geographic design criteria.",
                },
                {
                  kind: "table",
                  caption:
                    "TABLE R301.2(1) CLIMATIC AND GEOGRAPHIC DESIGN CRITERIA",
                  headers: [
                    "Ground Snow Load",
                    "Wind Speed (mph)",
                    "Seismic Design Category",
                  ],
                  rows: [
                    ["5", "115", "A"],
                    ["20", "130", "C"],
                  ],
                },
              ],
            },
            {
              sectionId: "IRC2021-R302",
              titleId: "IRC2021",
              chapterId: "IRC2021-CH03",
              sectionNumber: "R302",
              heading: "Fire-Resistant Construction",
              content: [
                {
                  kind: "prose",
                  text: "Exterior walls of dwelling units shall be constructed in accordance with Table R302.1(1). Townhouses shall comply with Section R302.2. Notwithstanding Section R301, fire-resistance ratings shall be determined as defined in Chapter 2.",
                },
                {
                  kind: "figure",
                  caption: "FIGURE R302.1 EXTERIOR WALL FIRE SEPARATION",
                  imageUrl:
                    "https://codes.iccsafe.org/assets/IRC2021/figure-R302-1.png",
                },
              ],
            },
          ],
        },
      ],
    },
  },

  search: {
    "townhouse fire separation": [
      {
        sectionId: "IRC2021-R302",
        titleId: "IRC2021",
        sectionNumber: "R302",
        heading: "Fire-Resistant Construction",
        snippet:
          "Townhouses shall comply with Section R302.2. Notwithstanding Section R301...",
      },
    ],
  },

  versions: {
    IRC: [
      {
        titleId: "IRC2021",
        codeAbbrev: "IRC",
        year: 2021,
        versionStatus: "current",
      },
      {
        titleId: "IRC2018",
        codeAbbrev: "IRC",
        year: 2018,
        versionStatus: "historical",
      },
    ],
  },
};
