/**
 * Model-code ingest path — fixture dry-run tests.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStorage } from "@hauska-engine/storage";

import { ICC_CODE_CONNECT_FIXTURES } from "../../adapters/icc-code-connect/__fixtures__/irc-2021.js";
import {
  ICC_CODE_CONNECT_SOURCE_ADAPTER,
  ICC_MODEL_CODE_ACCESS_POLICY,
  ICC_MODEL_CODE_TENANT,
  isIccModelCodeAtom,
} from "../demo-instance.js";
import { runModelCodeIngest } from "../ingest.js";

describe("runModelCodeIngest — fixture dry-run", () => {
  it("ingests 2018 IBC + 2018 IPMC end to end on mock fixtures", async () => {
    const storage = new InMemoryStorage();
    const { report } = await runModelCodeIngest({
      storage,
      fixtures: ICC_CODE_CONNECT_FIXTURES,
    });

    expect(report.adapterMode).toBe("mock");
    expect(report.jurisdictionTenant).toBe(ICC_MODEL_CODE_TENANT);
    expect(report.accessPolicy).toBe(ICC_MODEL_CODE_ACCESS_POLICY);
    expect(report.sourceAdapter).toBe(ICC_CODE_CONNECT_SOURCE_ADAPTER);
    expect(report.editionsIngested).toBe(2);
    expect(report.sectionsIngested).toBe(8);
    expect(report.definitionsIngested).toBe(4);
    expect(report.atomCount).toBeGreaterThan(report.sectionsIngested);

    const statuses = await storage.listJurisdictionStatus({
      accessPolicies: ["platform-internal"],
    });
    expect(statuses.some((s) => s.jurisdictionTenant === ICC_MODEL_CODE_TENANT)).toBe(
      true,
    );

    const ibcSection = await storage.getAtom(
      "code-section",
      "icc-model-code/2018-international-building-code/1604",
    );
    expect(ibcSection).not.toBeNull();
    if (ibcSection?.entityType === "code-section") {
      expect(ibcSection.verbatimTextDeepLink).toBeTruthy();
      expect(ibcSection.accessPolicy).toBe("platform-internal");
      expect(
        isIccModelCodeAtom({
          jurisdictionTenant: ibcSection.jurisdictionTenant,
          sourceAdapter: ibcSection.sourceAdapter,
          entityId: ibcSection.entityId,
        }),
      ).toBe(true);
      expect(ibcSection.bodyText).not.toContain("load combinations");
    }
  });
});
