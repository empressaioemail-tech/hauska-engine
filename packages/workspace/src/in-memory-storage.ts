/**
 * In-memory WorkspaceStoragePort for tests and retrieval-api dev mode.
 */

import type { AtomLink } from "@hauska-engine/atoms";
import type {
  WorkspaceAtomEntityType,
  WorkspaceAtomInstance,
} from "@hauska-engine/atoms";

import type {
  RecentWorkspaceSummary,
  WorkspacePackage,
  WorkspaceStoragePort,
} from "./port.js";

export class InMemoryWorkspaceStorage implements WorkspaceStoragePort {
  private readonly byDid = new Map<string, WorkspaceAtomInstance>();
  private readonly links: AtomLink[] = [];

  async writeWorkspaceAtom(
    instance: WorkspaceAtomInstance,
  ): Promise<{ atomDid: string }> {
    this.byDid.set(instance.did, instance);
    return { atomDid: instance.did };
  }

  async writeWorkspaceAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void> {
    for (const edge of links) {
      const exists = this.links.some(
        (l) =>
          l.fromEntityType === edge.fromEntityType &&
          l.fromEntityId === edge.fromEntityId &&
          l.toEntityType === edge.toEntityType &&
          l.toEntityId === edge.toEntityId &&
          l.linkType === edge.linkType,
      );
      if (!exists) this.links.push(edge);
    }
  }

  async getWorkspaceAtom<T extends WorkspaceAtomEntityType>(
    entityType: T,
    entityId: string,
  ): Promise<Extract<WorkspaceAtomInstance, { entityType: T }> | null> {
    for (const inst of this.byDid.values()) {
      if (inst.entityType === entityType && inst.entityId === entityId) {
        return inst as Extract<WorkspaceAtomInstance, { entityType: T }>;
      }
    }
    return null;
  }

  async getWorkspaceAtomByDid(
    atomDid: string,
  ): Promise<WorkspaceAtomInstance | null> {
    return this.byDid.get(atomDid) ?? null;
  }

  async listRecentWorkspacesByUser(
    userDid: string,
    limit = 25,
  ): Promise<ReadonlyArray<RecentWorkspaceSummary>> {
    const cap = Math.max(1, Math.min(limit, 100));
    const rows: RecentWorkspaceSummary[] = [];
    for (const inst of this.byDid.values()) {
      if (inst.entityType !== "property-workspace") continue;
      const isOwner = inst.owner.did === userDid;
      const isCollaborator = inst.collaborators.some((c) => c.did === userDid);
      if (!isOwner && !isCollaborator) continue;
      rows.push({
        workspaceDid: inst.did,
        entityId: inst.entityId,
        updatedAt: inst.updatedAt,
        addressLine: inst.address.line1,
        ownerDid: inst.owner.did,
      });
    }
    rows.sort((a, b) => {
      const cmp = b.updatedAt.localeCompare(a.updatedAt);
      if (cmp !== 0) return cmp;
      return a.workspaceDid.localeCompare(b.workspaceDid);
    });
    return rows.slice(0, cap);
  }

  async getWorkspacePackage(workspaceDid: string): Promise<WorkspacePackage | null> {
    const workspace = await this.getWorkspaceAtomByDid(workspaceDid);
    if (!workspace || workspace.entityType !== "property-workspace") {
      return null;
    }
    const briefRuns: WorkspacePackage["briefRuns"][number][] = [];
    const attachments: WorkspacePackage["attachments"][number][] = [];
    const shareEdges: WorkspacePackage["shareEdges"][number][] = [];
    for (const inst of this.byDid.values()) {
      if (inst.entityType === "brief-run" && inst.workspaceDid === workspaceDid) {
        briefRuns.push(inst);
      }
      if (
        inst.entityType === "workspace-attachment" &&
        inst.workspaceDid === workspaceDid
      ) {
        attachments.push(inst);
      }
      if (
        inst.entityType === "workspace-share-edge" &&
        inst.workspaceDid === workspaceDid
      ) {
        shareEdges.push(inst);
      }
    }
    briefRuns.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    attachments.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    shareEdges.sort((a, b) => {
      const cmp = b.sharedAt.localeCompare(a.sharedAt);
      if (cmp !== 0) return cmp;
      return a.did.localeCompare(b.did);
    });
    return { workspace, briefRuns, attachments, shareEdges };
  }

  async listShareEdges(filter?: {
    workspaceDid?: string;
    userDid?: string;
  }): Promise<
    ReadonlyArray<Extract<WorkspaceAtomInstance, { entityType: "workspace-share-edge" }>>
  > {
    const edges: Extract<
      WorkspaceAtomInstance,
      { entityType: "workspace-share-edge" }
    >[] = [];
    for (const inst of this.byDid.values()) {
      if (inst.entityType !== "workspace-share-edge") continue;
      if (filter?.workspaceDid && inst.workspaceDid !== filter.workspaceDid) {
        continue;
      }
      if (
        filter?.userDid &&
        inst.fromUserDid !== filter.userDid &&
        inst.toUserDid !== filter.userDid
      ) {
        continue;
      }
      edges.push(inst);
    }
    edges.sort((a, b) => {
      const cmp = b.sharedAt.localeCompare(a.sharedAt);
      if (cmp !== 0) return cmp;
      return a.did.localeCompare(b.did);
    });
    return edges;
  }
}

/** Write emitted instance + links in one call. */
export async function ingestEmittedWorkspaceAtom(
  storage: WorkspaceStoragePort,
  emitted: { instance: WorkspaceAtomInstance; links: ReadonlyArray<AtomLink> },
): Promise<{ atomDid: string }> {
  const result = await storage.writeWorkspaceAtom(emitted.instance);
  if (emitted.links.length > 0) {
    await storage.writeWorkspaceAtomLinks(emitted.links);
  }
  return result;
}
