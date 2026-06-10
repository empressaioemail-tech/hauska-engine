import { describe, expect, it } from "vitest";
import { PUBLIC_CALIBRATION_TENANT } from "../dbShim.js";
import {
  isPublicPoolEligible,
  partitionForSignal,
  tenantMayReadOverlay,
} from "../partition";

describe("partitionForSignal", () => {
  it("routes public-free to __public__ partition", () => {
    const p = partitionForSignal({
      accessPolicy: "public-free",
      jurisdictionTenant: "bastrop_tx",
    });
    expect(p.overlayTenant).toBe(PUBLIC_CALIBRATION_TENANT);
    expect(p.partitionKind).toBe("public");
  });

  it("isolates tenant-private adjudications per tenant", () => {
    const p = partitionForSignal({
      accessPolicy: "tenant-private",
      jurisdictionTenant: "bastrop_tx",
    });
    expect(p.overlayTenant).toBe("bastrop_tx");
    expect(p.partitionKind).toBe("tenant-private");
  });

  it("tenant-shared pools only within shared-with list key", () => {
    const shared = ["mox_living", "partner_a"];
    const p = partitionForSignal({
      accessPolicy: "tenant-shared",
      jurisdictionTenant: "mox_living",
      sharedWithTenants: shared,
    });
    expect(p.partitionKind).toBe("tenant-shared");
    expect(p.overlayTenant).toBe("__shared__:mox_living,partner_a");
    expect(p.overlayTenant).not.toBe(PUBLIC_CALIBRATION_TENANT);
  });
});

describe("tenantMayReadOverlay", () => {
  it("denies cross-tenant private overlay reads", () => {
    expect(tenantMayReadOverlay("bastrop_tx", "elgin_tx")).toBe(false);
  });

  it("allows shared-partition members", () => {
    expect(
      tenantMayReadOverlay("__shared__:mox_living,partner_a", "partner_a"),
    ).toBe(true);
  });
});

describe("isPublicPoolEligible", () => {
  it("excludes tenant-private from public pool", () => {
    expect(isPublicPoolEligible("tenant-private")).toBe(false);
    expect(isPublicPoolEligible("public-free")).toBe(true);
  });
});
