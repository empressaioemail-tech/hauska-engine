import type { CodeEditionAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

export interface EditionAtDateResult {
  edition: CodeEditionAtomInstance | null;
  jurisdictionTenant: string;
  asOf: string;
}

/**
 * Resolve the code edition in effect for a jurisdiction at a historical
 * date. K2 retrodiction harness calls this before predicting a case.
 */
export async function resolveEditionAtDate(
  storage: StoragePort,
  args: {
    jurisdictionTenant: string;
    asOf: string;
  },
): Promise<EditionAtDateResult> {
  const asOfMs = Date.parse(args.asOf);
  const editions: CodeEditionAtomInstance[] = [];

  const corpus = await storage.getAtom(
    "jurisdiction-corpus",
    args.jurisdictionTenant,
  );
  if (!corpus) {
    return { edition: null, jurisdictionTenant: args.jurisdictionTenant, asOf: args.asOf };
  }

  for (const editionId of corpus.adoptedEditionIds) {
    const edition = await storage.getAtom("code-edition", editionId);
    if (edition) editions.push(edition);
  }

  editions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  let match: CodeEditionAtomInstance | null = null;
  for (const edition of editions) {
    const fromMs = Date.parse(edition.effectiveFrom);
    const toMs = edition.effectiveTo ? Date.parse(edition.effectiveTo) : Number.POSITIVE_INFINITY;
    if (asOfMs >= fromMs && asOfMs < toMs) {
      match = edition;
    }
  }

  return {
    edition: match,
    jurisdictionTenant: args.jurisdictionTenant,
    asOf: args.asOf,
  };
}
