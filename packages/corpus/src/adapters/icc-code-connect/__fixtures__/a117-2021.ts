/**
 * ICC Code Connect fixture slice — 2021 ICC A117.1 (Accessible and
 * Usable Buildings and Facilities).
 *
 * Credential-pending: wired alongside the staged 2021 IRC so ingest
 * runs the moment OAuth credentials land. Hand-built from the assumed
 * Code Connect response models; replace with captured payloads when
 * the operator returns from the ICC meeting.
 */

import type {
  CodeConnectTitle,
  IccCodeDocument,
} from "../code-connect-client.js";

export const A117_2021_TITLE_ID = "A11712021";

export const A117_2021_TITLE: CodeConnectTitle = {
  titleId: A117_2021_TITLE_ID,
  codeAbbrev: "A117.1",
  name: "Accessible and Usable Buildings and Facilities",
  year: 2021,
  versionStatus: "current",
};

export const A117_2021_EDITION_LABEL = "2021 Accessible and Usable Buildings and Facilities";

export const A117_2021_DOCUMENT: IccCodeDocument = {
  title: A117_2021_TITLE,
  chapters: [
    {
      chapter: {
        chapterId: "A11712021-CH01",
        titleId: A117_2021_TITLE_ID,
        chapterNumber: "1",
        heading: "Application and Administration",
        sections: [
          {
            sectionId: "A11712021-101",
            sectionNumber: "101",
            heading: "Purpose",
          },
        ],
      },
      sections: [
        {
          sectionId: "A11712021-101",
          titleId: A117_2021_TITLE_ID,
          chapterId: "A11712021-CH01",
          sectionNumber: "101",
          heading: "Purpose",
          viewerUrl:
            "https://codes.iccsafe.org/content/A117.12021/chapter-1#A11712021_Ch01_Sec101",
          content: [
            {
              kind: "prose",
              text: "The provisions of this standard shall apply to sites, facilities, buildings and elements required to be accessible.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "A11712021-CH04",
        titleId: A117_2021_TITLE_ID,
        chapterNumber: "4",
        heading: "Accessible Routes",
        sections: [
          {
            sectionId: "A11712021-403",
            sectionNumber: "403",
            heading: "Accessible Routes",
          },
        ],
      },
      sections: [
        {
          sectionId: "A11712021-403",
          titleId: A117_2021_TITLE_ID,
          chapterId: "A11712021-CH04",
          sectionNumber: "403",
          heading: "Accessible Routes",
          content: [
            {
              kind: "prose",
              text: "Accessible routes shall connect site arrival points, accessible building entrances and all accessible spaces and elements within a building or facility. See Section 404 for doors and gates.",
            },
          ],
        },
      ],
    },
    {
      chapter: {
        chapterId: "A11712021-CH06",
        titleId: A117_2021_TITLE_ID,
        chapterNumber: "6",
        heading: "Plumbing Elements and Facilities",
        sections: [
          {
            sectionId: "A11712021-604",
            sectionNumber: "604",
            heading: "Water Closets and Toilet Compartments",
          },
          {
            sectionId: "A11712021-609",
            sectionNumber: "609",
            heading: "Grab Bars",
          },
        ],
      },
      sections: [
        {
          sectionId: "A11712021-604",
          titleId: A117_2021_TITLE_ID,
          chapterId: "A11712021-CH06",
          sectionNumber: "604",
          heading: "Water Closets and Toilet Compartments",
          content: [
            {
              kind: "prose",
              text: "Water closets and toilet compartments shall comply with Section 604. Grab bars shall comply with Section 609.",
            },
          ],
        },
        {
          sectionId: "A11712021-609",
          titleId: A117_2021_TITLE_ID,
          chapterId: "A11712021-CH06",
          sectionNumber: "609",
          heading: "Grab Bars",
          content: [
            {
              kind: "prose",
              text: "Grab bars in toilet facilities shall be installed in a horizontal position 33 inches minimum and 36 inches maximum above the finish floor measured to the top of the gripping surface.",
            },
          ],
        },
      ],
    },
  ],
};
