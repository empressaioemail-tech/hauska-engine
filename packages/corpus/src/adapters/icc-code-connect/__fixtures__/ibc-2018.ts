/**
 * ICC Code Connect fixture slice — 2018 International Building Code (IBC).
 *
 * Hand-built from the assumed Code Connect response models (see
 * `code-connect-client.ts`). NOT a captured real payload — reconcile
 * against live Code Connect payloads when OAuth credentials land.
 *
 * Exercises discover → fetch → normalize → model-code extractor → atoms:
 * Definitions chapter (structurally-tagged terms), Use and Occupancy
 * chapter (prose + cross-reference), Structural Design chapter (prose,
 * table, figure, inline cross-references).
 */

import type {
  CodeConnectTitle,
  IccCodeDocument,
} from "../code-connect-client.js";

export const IBC_2018_TITLE_ID = "IBC2018";

export const IBC_2018_TITLE: CodeConnectTitle = {
  titleId: IBC_2018_TITLE_ID,
  codeAbbrev: "IBC",
  name: "International Building Code",
  year: 2018,
  versionStatus: "historical",
};

export const IBC_2018_EDITION_LABEL = "2018 International Building Code";

export const IBC_2018_DOCUMENT: IccCodeDocument = {
  title: IBC_2018_TITLE,
  chapters: [
    {
      chapter: {
        chapterId: "IBC2018-CH02",
        titleId: IBC_2018_TITLE_ID,
        chapterNumber: "2",
        heading: "Definitions",
        sections: [
          {
            sectionId: "IBC2018-201",
            sectionNumber: "201",
            heading: "General",
          },
          {
            sectionId: "IBC2018-202",
            sectionNumber: "202",
            heading: "Definitions",
          },
        ],
      },
      sections: [
        {
          sectionId: "IBC2018-201",
          titleId: IBC_2018_TITLE_ID,
          chapterId: "IBC2018-CH02",
          sectionNumber: "201",
          heading: "General",
          content: [
            {
              kind: "prose",
              text: "Unless otherwise expressly stated, the following words and terms shall, for the purposes of this code, have the meanings shown in this chapter. Terms not defined in Section 202 shall have the meanings stated in the International Fire Code.",
            },
          ],
        },
        {
          sectionId: "IBC2018-202",
          titleId: IBC_2018_TITLE_ID,
          chapterId: "IBC2018-CH02",
          sectionNumber: "202",
          heading: "Definitions",
          content: [
            {
              kind: "prose",
              text: "The following terms are defined for the purposes of this code.",
            },
          ],
          definedTerms: [
            {
              term: "BUILDING",
              definition:
                "Any structure used or intended for supporting or sheltering any use or occupancy.",
            },
            {
              term: "OCCUPANCY",
              definition:
                "The purpose for which a building or portion thereof is used or intended to be used.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "IBC2018-CH03",
        titleId: IBC_2018_TITLE_ID,
        chapterNumber: "3",
        heading: "Use and Occupancy Classification",
        sections: [
          {
            sectionId: "IBC2018-304",
            sectionNumber: "304",
            heading: "Business Group B",
          },
        ],
      },
      sections: [
        {
          sectionId: "IBC2018-304",
          titleId: IBC_2018_TITLE_ID,
          chapterId: "IBC2018-CH03",
          sectionNumber: "304",
          heading: "Business Group B",
          viewerUrl:
            "https://codes.iccsafe.org/content/IBC2018/chapter-3-use-and-occupancy-classification#IBC2018_Ch03_Sec304",
          content: [
            {
              kind: "prose",
              text: "Business Group B occupancy includes, among others, the use of a building or structure, or a portion thereof, for office, professional or service-type transactions. Occupancy classification shall be as defined in Section 202. See Chapter 5 for height and area limitations.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "IBC2018-CH16",
        titleId: IBC_2018_TITLE_ID,
        chapterNumber: "16",
        heading: "Structural Design",
        sections: [
          {
            sectionId: "IBC2018-1604",
            sectionNumber: "1604",
            heading: "General Design Requirements",
          },
        ],
      },
      sections: [
        {
          sectionId: "IBC2018-1604",
          titleId: IBC_2018_TITLE_ID,
          chapterId: "IBC2018-CH16",
          sectionNumber: "1604",
          heading: "General Design Requirements",
          content: [
            {
              kind: "prose",
              text: "Buildings and other structures, and parts thereof, shall be designed to support all loads, including dead loads, live loads, roof loads, flood loads, snow loads, wind loads and seismic loads as prescribed by this code. See Table 1604.3 for load combinations. Notwithstanding Section 304, structural design shall comply with Chapter 2 definitions.",
            },
            {
              kind: "table",
              caption: "TABLE 1604.3 LOAD COMBINATIONS",
              headers: ["Combination", "Formula"],
              rows: [
                ["1.4D", "1.4D"],
                ["1.2D + 1.6L", "1.2D + 1.6L"],
              ],
            },
            {
              kind: "figure",
              caption: "FIGURE 1604.1 LOAD PATH DIAGRAM",
              imageUrl:
                "https://codes.iccsafe.org/assets/IBC2018/figure-1604-1.png",
            },
          ],
        },
      ],
    },
  ],
};
