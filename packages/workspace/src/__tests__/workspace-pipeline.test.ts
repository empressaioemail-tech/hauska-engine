/**
 * Brokerage V1 workspace atom pipeline — emission, storage, retrieval.
 */

import { describe, expect, it } from "vitest";

import {
  SAMPLE_BRIEF_RUN,
  SAMPLE_PROPERTY_WORKSPACE,
  SAMPLE_WORKSPACE_ATTACHMENT_LINK,
  SAMPLE_WORKSPACE_ATTACHMENT_NOTE,
  SAMPLE_WORKSPACE_SHARE_EDGE,
} from "@hauska/atom-contract/workspace";
import { bootstrapEngineAtomRegistry, type InstanceLookup } from "@hauska-engine/atoms";

import {
  emitBriefRun,
  emitPropertyWorkspace,
  emitWorkspaceAttachment,
  emitWorkspaceShareEdge,
} from "../emit.js";
import {
  InMemoryWorkspaceStorage,
  ingestEmittedWorkspaceAtom,
} from "../in-memory-storage.js";
import {
  getWorkspacePackage,
  listRecentWorkspacesByUser,
  listShareEdges,
  listShareEdgesByWorkspace,
} from "../queries.js";

async function ingestFixturePackage(storage: InMemoryWorkspaceStorage) {
  const fixtures = [
    emitPropertyWorkspace(SAMPLE_PROPERTY_WORKSPACE),
    emitWorkspaceAttachment(SAMPLE_WORKSPACE_ATTACHMENT_LINK),
    emitWorkspaceAttachment(SAMPLE_WORKSPACE_ATTACHMENT_NOTE),
    emitWorkspaceShareEdge(SAMPLE_WORKSPACE_SHARE_EDGE),
    emitBriefRun(SAMPLE_BRIEF_RUN),
  ];
  for (const emitted of fixtures) {
    await ingestEmittedWorkspaceAtom(storage, emitted);
  }
}

describe("workspace emission", () => {
  it("emits all four atom types with citation links on brief-run", () => {
    const brief = emitBriefRun(SAMPLE_BRIEF_RUN);
    expect(brief.instance.entityType).toBe("brief-run");
    expect(brief.instance.did).toBe(SAMPLE_BRIEF_RUN.did);
    expect(brief.links.some((l) => l.linkType === "cites")).toBe(true);
    expect(brief.links.some((l) => l.linkType === "applies-to")).toBe(true);
  });
});

describe("workspace storage + queries", () => {
  it("writes and retrieves all four atom types", async () => {
    const storage = new InMemoryWorkspaceStorage();
    await ingestFixturePackage(storage);

    const workspace = await storage.getWorkspaceAtomByDid(SAMPLE_PROPERTY_WORKSPACE.did);
    expect(workspace?.entityType).toBe("property-workspace");

    const brief = await storage.getWorkspaceAtomByDid(SAMPLE_BRIEF_RUN.did);
    expect(brief?.entityType).toBe("brief-run");

    const attachment = await storage.getWorkspaceAtomByDid(
      SAMPLE_WORKSPACE_ATTACHMENT_LINK.did,
    );
    expect(attachment?.entityType).toBe("workspace-attachment");

    const edge = await storage.getWorkspaceAtomByDid(SAMPLE_WORKSPACE_SHARE_EDGE.did);
    expect(edge?.entityType).toBe("workspace-share-edge");
  });

  it("lists recent workspaces by user in deterministic order (most recent first)", async () => {
    const storage = new InMemoryWorkspaceStorage();
    await ingestFixturePackage(storage);

    const older = emitPropertyWorkspace({
      ...SAMPLE_PROPERTY_WORKSPACE,
      did: "did:hauska:workspace:older-property",
      updatedAt: "2026-05-27T10:00:00Z",
      createdAt: "2026-05-27T10:00:00Z",
      address: { ...SAMPLE_PROPERTY_WORKSPACE.address, line1: "1 Old St" },
    });
    await ingestEmittedWorkspaceAtom(storage, older);

    const recent = await listRecentWorkspacesByUser(
      storage,
      SAMPLE_PROPERTY_WORKSPACE.owner.did,
    );
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0]!.workspaceDid).toBe(SAMPLE_PROPERTY_WORKSPACE.did);
    expect(recent[0]!.updatedAt >= recent[1]!.updatedAt).toBe(true);
  });

  it("returns a complete workspace package with linked records", async () => {
    const storage = new InMemoryWorkspaceStorage();
    await ingestFixturePackage(storage);

    const pkg = await getWorkspacePackage(storage, SAMPLE_PROPERTY_WORKSPACE.did);
    expect(pkg).not.toBeNull();
    expect(pkg!.workspace.did).toBe(SAMPLE_PROPERTY_WORKSPACE.did);
    expect(pkg!.briefRuns).toHaveLength(1);
    expect(pkg!.attachments).toHaveLength(2);
    expect(pkg!.shareEdges).toHaveLength(1);
    expect(pkg!.briefRuns[0]!.citationRefs).toHaveLength(1);
  });

  it("lists share edges by workspace and by user for admin graph consumers", async () => {
    const storage = new InMemoryWorkspaceStorage();
    await ingestFixturePackage(storage);

    const byWorkspace = await listShareEdgesByWorkspace(
      storage,
      SAMPLE_PROPERTY_WORKSPACE.did,
    );
    expect(byWorkspace).toHaveLength(1);
    expect(byWorkspace[0]!.fromUserDid).toBe(SAMPLE_WORKSPACE_SHARE_EDGE.fromUserDid);

    const byUser = await listShareEdges(storage, {
      userDid: SAMPLE_WORKSPACE_SHARE_EDGE.toUserDid,
    });
    expect(byUser).toHaveLength(1);
  });
});

describe("workspace registry contextSummary", () => {
  it("resolves property-workspace and brief-run with citation relatedAtoms", async () => {
    const storage = new InMemoryWorkspaceStorage();
    await ingestFixturePackage(storage);

    const workspaceInst = await storage.getWorkspaceAtom(
      "property-workspace",
      "123-main-st",
    );
    const briefInst = await storage.getWorkspaceAtom("brief-run", "123-main-st-run-1");
    expect(workspaceInst).not.toBeNull();
    expect(briefInst).not.toBeNull();

    const lookup: InstanceLookup = {
      async get(entityType, entityId) {
        return storage.getWorkspaceAtom(entityType as never, entityId) as never;
      },
    };
    const registry = bootstrapEngineAtomRegistry({ lookup });
    const wsReg = registry.resolve("property-workspace");
    const briefReg = registry.resolve("brief-run");
    expect(wsReg.ok).toBe(true);
    expect(briefReg.ok).toBe(true);
    if (!wsReg.ok || !briefReg.ok) return;

    const wsSummary = await wsReg.registration.contextSummary("123-main-st", {
      audience: "ai",
    });
    expect(wsSummary.prose).toContain("123 Main St");

    const briefSummary = await briefReg.registration.contextSummary("123-main-st-run-1", {
      audience: "ai",
    });
    expect(briefSummary.relatedAtoms.length).toBeGreaterThan(0);
  });
});
