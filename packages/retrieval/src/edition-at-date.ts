import { resolveEditionAtDate as resolveEditionAtDateFromCorpus } from "@hauska-engine/corpus/edition-history";
import type { StoragePort } from "@hauska-engine/storage";

export type { EditionAtDateResult } from "@hauska-engine/corpus/edition-history";

export async function resolveEditionAtDate(
  storage: StoragePort,
  args: { jurisdictionTenant: string; asOf: string },
) {
  return resolveEditionAtDateFromCorpus(storage, args);
}
