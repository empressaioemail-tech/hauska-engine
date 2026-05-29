/**
 * Query helpers for brokerage workspace retrieval surfaces.
 */

import type { WorkspaceStoragePort } from "./port.js";

export type {
  RecentWorkspaceSummary,
  WorkspacePackage,
} from "./port.js";

export function listRecentWorkspacesByUser(
  storage: WorkspaceStoragePort,
  userDid: string,
  limit?: number,
) {
  return storage.listRecentWorkspacesByUser(userDid, limit);
}

export function getWorkspacePackage(storage: WorkspaceStoragePort, workspaceDid: string) {
  return storage.getWorkspacePackage(workspaceDid);
}

export function listShareEdgesByWorkspace(
  storage: WorkspaceStoragePort,
  workspaceDid: string,
) {
  return storage.listShareEdges({ workspaceDid });
}

export function listShareEdgesByUser(storage: WorkspaceStoragePort, userDid: string) {
  return storage.listShareEdges({ userDid });
}

export function listShareEdges(
  storage: WorkspaceStoragePort,
  filter?: { workspaceDid?: string; userDid?: string },
) {
  return storage.listShareEdges(filter);
}
