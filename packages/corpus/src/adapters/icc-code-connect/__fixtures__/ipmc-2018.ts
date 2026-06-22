/**
 * ICC Code Connect fixture slice — 2018 International Property
 * Maintenance Code (IPMC).
 *
 * Hand-built from the assumed Code Connect response models (see
 * `code-connect-client.ts`). NOT a captured real payload — reconcile
 * against live Code Connect payloads when OAuth credentials land.
 *
 * Exercises discover → fetch → normalize → model-code extractor → atoms:
 * Definitions chapter (structurally-tagged terms), General Requirements
 * chapter (prose + cross-reference), Plumbing chapter (prose +
 * cross-reference to another section).
 */

import type {
  CodeConnectTitle,
  IccCodeDocument,
} from "../code-connect-client.js";

export const IPMC_2018_TITLE_ID = "IPMC2018";

export const IPMC_2018_TITLE: CodeConnectTitle = {
  titleId: IPMC_2018_TITLE_ID,
  codeAbbrev: "IPMC",
  name: "International Property Maintenance Code",
  year: 2018,
  versionStatus: "historical",
};

export const IPMC_2018_EDITION_LABEL =
  "2018 International Property Maintenance Code";

export const IPMC_2018_DOCUMENT: IccCodeDocument = {
  title: IPMC_2018_TITLE,
  chapters: [
    {
      chapter: {
        chapterId: "IPMC2018-CH02",
        titleId: IPMC_2018_TITLE_ID,
        chapterNumber: "2",
        heading: "Definitions",
        sections: [
          {
            sectionId: "IPMC2018-201",
            sectionNumber: "201",
            heading: "General",
          },
          {
            sectionId: "IPMC2018-202",
            sectionNumber: "202",
            heading: "Definitions",
          },
        ],
      },
      sections: [
        {
          sectionId: "IPMC2018-201",
          titleId: IPMC_2018_TITLE_ID,
          chapterId: "IPMC2018-CH02",
          sectionNumber: "201",
          heading: "General",
          content: [
            {
              kind: "prose",
              text: "Unless otherwise expressly stated, the following words and terms shall, for the purposes of this code, have the meanings shown in this chapter. Terms not defined in Section 202 shall have the meanings stated in the International Building Code.",
            },
          ],
        },
        {
          sectionId: "IPMC2018-202",
          titleId: IPMC_2018_TITLE_ID,
          chapterId: "IPMC2018-CH02",
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
              term: "DWELLING UNIT",
              definition:
                "A single unit providing complete, independent living facilities for one or more persons, including permanent provisions for living, sleeping, eating, cooking and sanitation.",
            },
            {
              term: "EXTERIOR PROPERTY",
              definition:
                "The open space on the premises and on adjoining property under the control of owners or operators of such premises.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "IPMC2018-CH03",
        titleId: IPMC_2018_TITLE_ID,
        chapterNumber: "3",
        heading: "General Requirements",
        sections: [
          {
            sectionId: "IPMC2018-301",
            sectionNumber: "301",
            heading: "General",
          },
        ],
      },
      sections: [
        {
          sectionId: "IPMC2018-301",
          titleId: IPMC_2018_TITLE_ID,
          chapterId: "IPMC2018-CH03",
          sectionNumber: "301",
          heading: "General",
          viewerUrl:
            "https://codes.iccsafe.org/content/IPMC2018/chapter-3-general-requirements#IPMC2018_Ch03_Sec301",
          content: [
            {
              kind: "prose",
              text: "The exterior of the structure and the condition of accessory structures shall be maintained in good repair. Exterior property shall be maintained in accordance with Section 302. See Section 202 for defined terms.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "IPMC2018-CH05",
        titleId: IPMC_2018_TITLE_ID,
        chapterNumber: "5",
        heading: "Plumbing Facilities and Fixture Requirements",
        sections: [
          {
            sectionId: "IPMC2018-501",
            sectionNumber: "501",
            heading: "Required Facilities",
          },
        ],
      },
      sections: [
        {
          sectionId: "IPMC2018-501",
          titleId: IPMC_2018_TITLE_ID,
          chapterId: "IPMC2018-CH05",
          sectionNumber: "501",
          heading: "Required Facilities",
          content: [
            {
              kind: "prose",
              text: "Every dwelling unit shall contain its own bathtub or shower, lavatory, water closet and kitchen sink. Plumbing fixtures shall be maintained in accordance with Section 504. Dwelling units shall comply with the definition in Section 202.",
            },
          ],
        },
      ],
    },
  ],
};
