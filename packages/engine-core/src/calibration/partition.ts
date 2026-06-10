import {
  PUBLIC_CALIBRATION_TENANT,
  type CalibrationPartitionKind,
} from "./dbShim.js";

export type OverlayAccessPolicy =
  | "public-free"
  | "tenant-private"
  | "tenant-shared"
  | "platform-internal";

export function partitionForSignal(args: {
  accessPolicy: string;
  jurisdictionTenant: string;
  sharedWithTenants?: string[] | null;
}): { partitionKind: CalibrationPartitionKind; overlayTenant: string } {
  const policy = args.accessPolicy as OverlayAccessPolicy;
  if (policy === "tenant-private") {
    return {
      partitionKind: "tenant-private",
      overlayTenant: args.jurisdictionTenant,
    };
  }
  if (policy === "tenant-shared") {
    const shared = (args.sharedWithTenants ?? []).slice().sort().join(",");
    return {
      partitionKind: "tenant-shared",
      overlayTenant: `__shared__:${shared}`,
    };
  }
  return {
    partitionKind: "public",
    overlayTenant: PUBLIC_CALIBRATION_TENANT,
  };
}

/** Whether a tenant-private signal may contribute to the public pool. */
export function isPublicPoolEligible(accessPolicy: string): boolean {
  return accessPolicy === "public-free" || accessPolicy === "platform-internal";
}

export function tenantMayReadOverlay(
  overlayTenant: string,
  readerTenant: string,
): boolean {
  if (overlayTenant === PUBLIC_CALIBRATION_TENANT) return true;
  if (overlayTenant === readerTenant) return true;
  if (overlayTenant.startsWith("__shared__:")) {
    const list = overlayTenant.slice("__shared__:".length).split(",");
    return list.includes(readerTenant);
  }
  return false;
}
