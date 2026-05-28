/**
 * Workspace atom storage port — separate from the code-corpus StoragePort.
 */

import type { AtomLink } from "@hauska-engine/atoms";
import type { WorkspaceAtomEntityType, WorkspaceAtomInstance } from "@hauska-engine/atoms";

export interface WorkspacePackage {
  workspace: Extract<WorkspaceAtomInstance, { entityType: "property-workspace" }>;
  briefRuns: ReadonlyArray<Extract<WorkspaceAtomInstance, { entityType: "brief-run" }>>;
  attachments: ReadonlyArray<
    Extract<WorkspaceAtomInstance, { entityType: "workspace-attachment" }>
  >;
  shareEdges: ReadonlyArray<
    Extract<WorkspaceAtomInstance, { entityType: "workspace-share-edge" }>
  >;
}

export interface RecentWorkspaceSummary {
  workspaceDid: string;
  entityId: string;
  updatedAt: string;
  addressLine: string;
  ownerDid: string;
}

export interface WorkspaceStoragePort {
  writeWorkspaceAtom(
    instance: WorkspaceAtomInstance,
  ): Promise<{ atomDid: string }>;

  writeWorkspaceAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void>;

  getWorkspaceAtom<T extends WorkspaceAtomEntityType>(
    entityType: T,
    entityId: string,
  ): Promise<Extract<WorkspaceAtomInstance, { entityType: T }> | null>;

  getWorkspaceAtomByDid(atomDid: string): Promise<WorkspaceAtomInstance | null>;

  /** Most recently updated workspaces where the user is owner or collaborator. */
  listRecentWorkspacesByUser(
    userDid: string,
    limit?: number,
  ): Promise<ReadonlyArray<RecentWorkspaceSummary>>;

  /** Full linked package for a workspace DID. */
  getWorkspacePackage(workspaceDid: string): Promise<WorkspacePackage | null>;

  /**
   * Share graph edges filtered by workspace and/or participant user DID.
   * When both filters are set, edges must match both.
   */
  listShareEdges(filter?: {
    workspaceDid?: string;
    userDid?: string;
  }): Promise<
    ReadonlyArray<Extract<WorkspaceAtomInstance, { entityType: "workspace-share-edge" }>>
  >;
}
