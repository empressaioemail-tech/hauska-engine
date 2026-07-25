import { describe, expect, it } from "vitest";

import {
  evaluateSnapshotHeadroom,
  projectSnapshotHeapBytes,
  resolveMemoryLimitMib,
  SNAPSHOT_HEAP_INFLATION,
} from "../resource-headroom.js";

describe("resource-headroom (G2)", () => {
  it("projects heap with the configured inflation factor", () => {
    expect(projectSnapshotHeapBytes(10_000_000)).toBe(
      10_000_000 * SNAPSHOT_HEAP_INFLATION,
    );
  });

  it("fails closed when projected heap exceeds 70% of the memory limit", () => {
    // 73MB file * 8 = 584MB projected; 70% of 1024MiB ≈ 716MB → ok
    const ok = evaluateSnapshotHeadroom({
      fileSizeBytes: 73 * 1024 * 1024,
      memoryLimitMib: 1024,
    });
    expect(ok.ok).toBe(true);

    // Same file against a 512MiB limit → fail
    const fail = evaluateSnapshotHeadroom({
      fileSizeBytes: 73 * 1024 * 1024,
      memoryLimitMib: 512,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toMatch(/exceeds/);
  });

  it("resolves MEMORY_LIMIT_MIB from env", () => {
    expect(resolveMemoryLimitMib({ MEMORY_LIMIT_MIB: "2048" })).toBe(2048);
    expect(resolveMemoryLimitMib({})).toBe(1024);
  });
});
