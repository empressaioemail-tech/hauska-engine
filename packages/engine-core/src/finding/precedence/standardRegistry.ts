/**
 * Standard-key detection from atomId / label patterns. Used when callers
 * hand {@link CodeSectionInput} rows without explicit authority metadata.
 */

import type { CodeSectionInput } from "../types";
import type { ApplicableRequirement, StandardAuthority } from "./types";

export interface StandardDescriptor {
  standardKey: string;
  standardLabel: string;
  authority: StandardAuthority;
}

const STANDARD_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  descriptor: StandardDescriptor;
}> = [
  {
    pattern: /\bada\b|2010-ada-standards|ada-2010/i,
    descriptor: {
      standardKey: "ada-2010",
      standardLabel: "2010 ADA Standards for Accessible Design",
      authority: "federal",
    },
  },
  {
    pattern: /\bfha\b|fair housing act design manual|fair-housing-act-design-manual/i,
    descriptor: {
      standardKey: "fha-design-manual",
      standardLabel: "Fair Housing Act Design Manual",
      authority: "federal",
    },
  },
  {
    pattern: /\ba117\.?1\b|a11712021|accessible and usable buildings/i,
    descriptor: {
      standardKey: "a117.1-2021",
      standardLabel: "ICC A117.1-2021 (credential-pending stub)",
      authority: "model-code",
    },
  },
  {
    pattern: /\bamendment\b|\blocal amend/i,
    descriptor: {
      standardKey: "local-amendment",
      standardLabel: "Local code amendment",
      authority: "local-amendment",
    },
  },
];

/** Detect standard metadata from atom id + label text. */
export function detectStandardDescriptor(
  atomId: string,
  label: string,
): StandardDescriptor | null {
  const haystack = `${atomId} ${label}`;
  for (const { pattern, descriptor } of STANDARD_PATTERNS) {
    if (pattern.test(haystack)) return descriptor;
  }
  if (/\bibc\b|\birc\b|\biecc\b|\bifc\b|\bnec\b|\bnfpa\b/i.test(haystack)) {
    return {
      standardKey: "model-code",
      standardLabel: label.trim() || "Model code",
      authority: "model-code",
    };
  }
  return null;
}

/** Map a code-section input to a partial applicable requirement shell. */
export function codeSectionToRequirementShell(
  section: CodeSectionInput,
  topic: string,
  dimension: string,
): Pick<
  ApplicableRequirement,
  "atomId" | "standardKey" | "standardLabel" | "authority" | "citationLabel" | "snippet"
> {
  const detected =
    detectStandardDescriptor(section.atomId, section.label) ??
    ({
      standardKey: "unknown",
      standardLabel: section.label,
      authority: "model-code" as const,
    } satisfies StandardDescriptor);

  return {
    atomId: section.atomId,
    standardKey: detected.standardKey,
    standardLabel: detected.standardLabel,
    authority: detected.authority,
    citationLabel: section.label,
    snippet: section.snippet,
  };
}
