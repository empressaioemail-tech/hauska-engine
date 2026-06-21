import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import { parseConsequenceInputsFromProse } from "./parse.js";

/** Attach parsed consequence classification inputs to a section atom. */
export function enrichSectionConsequenceInputs(
  section: CodeSectionAtomInstance,
): CodeSectionAtomInstance {
  const inputs = parseConsequenceInputsFromProse(section.bodyText);
  if (!inputs) return section;
  return { ...section, consequenceInputs: inputs };
}

/** Batch enrich sections (e.g. snapshot backfill). */
export function enrichSectionsConsequenceInputs<
  T extends CodeSectionAtomInstance,
>(sections: ReadonlyArray<T>): T[] {
  return sections.map((s) => enrichSectionConsequenceInputs(s) as T);
}
