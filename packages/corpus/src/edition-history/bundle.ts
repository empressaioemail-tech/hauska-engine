/**
 * K2 unblocker — edition bundle contract for acquisition → engine ingest.
 *
 * Acquisition agent delivers bundles keyed by effective date; engine
 * ingests historical editions + adoption ordinances for edition-correct
 * retrodiction.
 */

import { z } from "zod";

export const EDITION_BUNDLE_FORMAT = "hauska-edition-bundle/1" as const;

export const MODEL_CODE_BASE_SCHEMA = z.enum([
  "IRC",
  "IBC",
  "IECC",
  "IPC",
  "IMC",
  "IFGC",
  "IFC",
  "IEBC",
  "IgCC",
  "other",
]);

export const ADOPTION_ORDINANCE_SCHEMA = z.object({
  ordinanceId: z.string().min(1),
  effectiveDate: z.string().datetime({ offset: true }),
  authority: z.string().min(1),
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  amendmentText: z.string().optional(),
  /** Section entityIds affected; resolved at ingest if omitted. */
  affectedSectionIds: z.array(z.string()).optional(),
  /** Model code adopted (e.g. IBC 2021). */
  modelCodeBase: MODEL_CODE_BASE_SCHEMA.optional(),
  modelCodeYear: z.number().int().optional(),
});

export const EDITION_BUNDLE_ENTRY_SCHEMA = z.object({
  edition: z.object({
    entityId: z.string().min(1),
    editionLabel: z.string().min(1),
    effectiveFrom: z.string().datetime({ offset: true }),
    effectiveTo: z.string().datetime({ offset: true }).nullable(),
    sourceAdapter: z.string().min(1),
    sourceUrl: z.string().url(),
    modelCodeBase: MODEL_CODE_BASE_SCHEMA.optional(),
    modelCodeYear: z.number().int().optional(),
  }),
  adoptionOrdinance: ADOPTION_ORDINANCE_SCHEMA.optional(),
  /** Optional section payloads when acquisition includes full text. */
  sectionCount: z.number().int().nonnegative().optional(),
});

export const EDITION_BUNDLE_SCHEMA = z.object({
  format: z.literal(EDITION_BUNDLE_FORMAT),
  generatedAt: z.string().datetime({ offset: true }),
  jurisdictionTenant: z.string().min(1),
  jurisdictionName: z.string().min(1),
  /** Acquisition provenance label (e.g. "K1-W2-A Bastrop edition bundle v0"). */
  provenance: z.string().optional(),
  entries: z.array(EDITION_BUNDLE_ENTRY_SCHEMA).min(1),
});

export type EditionBundle = z.infer<typeof EDITION_BUNDLE_SCHEMA>;
export type EditionBundleEntry = z.infer<typeof EDITION_BUNDLE_ENTRY_SCHEMA>;
export type AdoptionOrdinanceRecord = z.infer<typeof ADOPTION_ORDINANCE_SCHEMA>;

export function parseEditionBundle(raw: unknown): EditionBundle {
  return EDITION_BUNDLE_SCHEMA.parse(raw);
}
