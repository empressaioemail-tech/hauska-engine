import { describe, expect, it } from "vitest";

import {
  MunicodeHtmlAdapter,
  RespectfulFetch,
  type CodeReference,
} from "../../adapters/index.js";
import { atomize } from "../../atomization/index.js";
import { buildCodeTree } from "../../extraction/index.js";
import { captureDriftSnapshot, diffSnapshots } from "../index.js";

class StubFetch extends RespectfulFetch {
  constructor(private readonly body: string) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetchText(): Promise<string> {
    return this.body;
  }
}

const FIXTURE_V1 = `<!doctype html><html><body>
  <h1>Chapter 1</h1>
  <h3>§ 1.01 Scope</h3><p>Original scope text.</p>
</body></html>`;

const FIXTURE_V2 = `<!doctype html><html><body>
  <h1>Chapter 1</h1>
  <h3>§ 1.01 Scope</h3><p>Updated scope text 2026.</p>
  <h3>§ 1.02 Added</h3><p>Newly added section.</p>
</body></html>`;

const reference: CodeReference = {
  sourceId: "test/test",
  jurisdictionTenant: "test-tx",
  editionLabel: "Test Code 2024",
  sourceUrl: "https://example/test",
};

async function snapshot(body: string) {
  const adapter = new MunicodeHtmlAdapter({ http: new StubFetch(body) });
  const raw = await adapter.fetch(reference);
  const tree = buildCodeTree(await adapter.normalize(raw));
  return captureDriftSnapshot(atomize(tree));
}

describe("drift detection", () => {
  it("reports no changes when re-ingested unchanged", async () => {
    const a = await snapshot(FIXTURE_V1);
    const b = await snapshot(FIXTURE_V1);
    const report = diffSnapshots(a, b);
    expect(report.hasChanges).toBe(false);
  });

  it("reports content drift + added section across versions", async () => {
    const a = await snapshot(FIXTURE_V1);
    const b = await snapshot(FIXTURE_V2);
    const report = diffSnapshots(a, b);
    expect(report.hasChanges).toBe(true);
    expect(report.changedSections.length + report.addedSections.length).toBeGreaterThan(0);
  });
});
