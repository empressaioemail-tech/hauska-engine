import { describe, expect, it } from "vitest";

import type { AtomLink } from "@hauska-engine/atoms";

import { InMemoryCalibrationRepository } from "../inMemoryPorts.js";
import {
  computeSectionDependentsClosure,
  invalidateStaleCalibrationForSectionChange,
} from "../sectionInvalidation.js";

describe("computeSectionDependentsClosure", () => {
  const links: AtomLink[] = [
    {
      fromEntityType: "code-section",
      fromEntityId: "j/a/5-04",
      toEntityType: "code-section",
      toEntityId: "j/a/1-01",
      linkType: "subject-to",
    },
    {
      fromEntityType: "code-section",
      fromEntityId: "j/a/9-01",
      toEntityType: "code-section",
      toEntityId: "j/a/5-04",
      linkType: "cites",
    },
  ];

  it("includes inbound dependents of seed sections", () => {
    const closure = computeSectionDependentsClosure(["j/a/1-01"], links);
    expect(closure.sort()).toEqual(["j/a/1-01", "j/a/5-04", "j/a/9-01"]);
  });
});

describe("invalidateStaleCalibrationForSectionChange", () => {
  it("invalidates overlay rows for closure sections not whole edition only", async () => {
    const repo = new InMemoryCalibrationRepository();
    await repo.upsertOverlayRow({
      atomId: "seed-uuid",
      jurisdictionTenant: "__public__",
      partitionKind: "public",
      accessPolicy: "public-free",
      sharedWithTenants: null,
      assertedConfidence: "0.8",
      calibratedConfidence: "0.95",
      codeRef: "1.01",
      edition: "B3 2025",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: "1-xx",
      signalCount: 3,
    });
    await repo.upsertOverlayRow({
      atomId: "dep-uuid",
      jurisdictionTenant: "__public__",
      partitionKind: "public",
      accessPolicy: "public-free",
      sharedWithTenants: null,
      assertedConfidence: "0.8",
      calibratedConfidence: "0.9",
      codeRef: "5.04",
      edition: "B3 2025",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: "5-xx",
      signalCount: 2,
    });
    await repo.upsertOverlayRow({
      atomId: "other-edition",
      jurisdictionTenant: "__public__",
      partitionKind: "public",
      accessPolicy: "public-free",
      sharedWithTenants: null,
      assertedConfidence: "0.8",
      calibratedConfidence: "0.9",
      codeRef: "5.04",
      edition: "B3 2021",
      sourceSetVersion: 1,
      calibrationStale: false,
      calibrationGrain: "atom",
      atomClass: "5-xx",
      signalCount: 2,
    });

    const links: AtomLink[] = [
      {
        fromEntityType: "code-section",
        fromEntityId: "j/a/5-04",
        toEntityType: "code-section",
        toEntityId: "j/a/1-01",
        linkType: "subject-to",
      },
    ];
    const sectionNumberByEntityId = new Map([
      ["j/a/1-01", "1.01"],
      ["j/a/5-04", "5.04"],
    ]);

    const result = await invalidateStaleCalibrationForSectionChange(repo, {
      edition: "B3 2025",
      changedSectionEntityIds: ["j/a/1-01"],
      sectionNumberByEntityId,
      links,
      sourceSetVersion: 2,
    });

    expect(result.closureSectionEntityIds.sort()).toEqual([
      "j/a/1-01",
      "j/a/5-04",
    ]);
    expect(result.invalidatedOverlayAtomIds.sort()).toEqual([
      "dep-uuid",
      "seed-uuid",
    ]);

    const other = await repo.findOverlayRow("other-edition", "__public__");
    expect(other?.calibrationStale).toBe(false);
  });
});
