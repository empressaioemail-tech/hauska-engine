#!/usr/bin/env tsx
/**
 * ingest-edition-bundle — K2 unblocker CLI.
 *
 * Reads an acquisition-agent edition bundle JSON and ingests historical
 * editions + adoption ordinances into in-memory storage or a snapshot.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  parseEditionBundle,
  ingestEditionBundle,
} from "@hauska-engine/corpus/edition-history";
import { InMemoryStorage, type CorpusSnapshot } from "@hauska-engine/storage";

export async function runIngestEditionBundle(args: {
  bundlePath: string;
  snapshotIn?: string;
  snapshotOut?: string;
}): Promise<void> {
  const raw = JSON.parse(readFileSync(args.bundlePath, "utf8"));
  const bundle = parseEditionBundle(raw);

  const storage = new InMemoryStorage();
  if (args.snapshotIn) {
    const snap = JSON.parse(readFileSync(args.snapshotIn, "utf8")) as CorpusSnapshot;
    await storage.importSnapshot(snap);
  }

  const result = await ingestEditionBundle(storage, bundle);
  console.log(
    JSON.stringify(
      {
        bundle: args.bundlePath,
        jurisdictionTenant: bundle.jurisdictionTenant,
        ...result,
      },
      null,
      2,
    ),
  );

  if (args.snapshotOut) {
    const out = storage.exportSnapshot([
      `ingest-edition-bundle:${bundle.provenance ?? args.bundlePath}`,
    ]);
    writeFileSync(args.snapshotOut, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ snapshotOut: args.snapshotOut }, null, 2));
  }
}
