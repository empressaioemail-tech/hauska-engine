/**
 * Contract payload → engine workspace atom instance + citation links.
 */

import {
  validateBriefRun,
  validatePropertyWorkspace,
  validateWorkspaceAttachment,
  validateWorkspaceShareEdge,
} from "@hauska/atom-contract/workspace";
import {
  parseAtomDid,
  type AtomLink,
  WORKSPACE_JURISDICTION_TENANT,
  WORKSPACE_SOURCE_ADAPTER,
  type BriefRunAtomInstance,
  type PropertyWorkspaceAtomInstance,
  type WorkspaceAttachmentAtomInstance,
  type WorkspaceShareEdgeAtomInstance,
  type WorkspaceAtomInstance,
} from "@hauska-engine/atoms";
import { sha256Hex } from "@hauska-engine/storage";

export interface EmittedWorkspaceAtom {
  instance: WorkspaceAtomInstance;
  links: ReadonlyArray<AtomLink>;
}

function entityIdFromDid(did: string): string {
  return parseAtomDid(did).localId;
}

function canonicalBody(payload: object): string {
  return JSON.stringify(payload);
}

function baseEnvelope(
  payload: { did: string; createdAt: string; updatedAt: string; accessPolicy: WorkspaceAtomInstance["accessPolicy"] },
  entityType: WorkspaceAtomInstance["entityType"],
  sourceUrl: string,
): Pick<
  WorkspaceAtomInstance,
  | "entityId"
  | "did"
  | "jurisdictionTenant"
  | "fetchedAt"
  | "sourceAdapter"
  | "sourceUrl"
  | "contentHash"
  | "createdAt"
  | "updatedAt"
  | "accessPolicy"
> {
  const entityId = entityIdFromDid(payload.did);
  const contentHash = sha256Hex(canonicalBody({ entityType, ...payload }));
  return {
    entityId,
    did: payload.did,
    jurisdictionTenant: WORKSPACE_JURISDICTION_TENANT,
    fetchedAt: payload.updatedAt,
    sourceAdapter: WORKSPACE_SOURCE_ADAPTER,
    sourceUrl,
    contentHash,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    accessPolicy: payload.accessPolicy,
  };
}

function link(
  from: { entityType: string; entityId: string },
  to: { entityType: string; entityId: string },
  linkType: AtomLink["linkType"],
  context?: string,
): AtomLink {
  return {
    fromEntityType: from.entityType,
    fromEntityId: from.entityId,
    toEntityType: to.entityType,
    toEntityId: to.entityId,
    linkType,
    context,
  };
}

function targetFromCitationDid(citationDid: string): {
  entityType: string;
  entityId: string;
} {
  const parsed = parseAtomDid(citationDid);
  return { entityType: parsed.entityType, entityId: parsed.localId };
}

/** Contract workspace DIDs use the `workspace` segment; engine entityType is `property-workspace`. */
function workspaceTargetFromDid(workspaceDid: string): {
  entityType: string;
  entityId: string;
} {
  const parsed = parseAtomDid(workspaceDid);
  if (parsed.entityType === "workspace") {
    return { entityType: "property-workspace", entityId: parsed.localId };
  }
  return { entityType: parsed.entityType, entityId: parsed.localId };
}

export function emitPropertyWorkspace(
  input: unknown,
): EmittedWorkspaceAtom {
  const payload = validatePropertyWorkspace(input);
  const instance: PropertyWorkspaceAtomInstance = {
    entityType: "property-workspace",
    ...baseEnvelope(payload, "property-workspace", payload.listingUrls[0] ?? payload.did),
    address: payload.address,
    listingUrls: payload.listingUrls,
    owner: payload.owner,
    collaborators: payload.collaborators,
  };
  return { instance, links: [] };
}

export function emitBriefRun(input: unknown): EmittedWorkspaceAtom {
  const payload = validateBriefRun(input);
  const instance: BriefRunAtomInstance = {
    entityType: "brief-run",
    ...baseEnvelope(payload, "brief-run", payload.workspaceDid),
    workspaceDid: payload.workspaceDid,
    runInputs: payload.runInputs,
    citationRefs: payload.citationRefs,
    confidence: payload.confidence,
    generatedAt: payload.generatedAt,
  };
  const workspaceTarget = workspaceTargetFromDid(payload.workspaceDid);
  const links: AtomLink[] = [
    link(
      { entityType: instance.entityType, entityId: instance.entityId },
      workspaceTarget,
      "applies-to",
      "brief-run workspace scope",
    ),
  ];
  for (const ref of payload.citationRefs) {
    const target = targetFromCitationDid(ref.citationDid);
    links.push(
      link(
        { entityType: instance.entityType, entityId: instance.entityId },
        target,
        "cites",
        ref.sourceType,
      ),
    );
  }
  return { instance, links };
}

export function emitWorkspaceAttachment(input: unknown): EmittedWorkspaceAtom {
  const payload = validateWorkspaceAttachment(input);
  const instance: WorkspaceAttachmentAtomInstance = {
    entityType: "workspace-attachment",
    ...baseEnvelope(
      payload,
      "workspace-attachment",
      payload.uri ?? payload.workspaceDid,
    ),
    workspaceDid: payload.workspaceDid,
    kind: payload.kind,
    ...(payload.uri !== undefined ? { uri: payload.uri } : {}),
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    uploader: payload.uploader,
  };
  const workspaceTarget = workspaceTargetFromDid(payload.workspaceDid);
  return {
    instance,
    links: [
      link(
        workspaceTarget,
        { entityType: instance.entityType, entityId: instance.entityId },
        "contains",
        `attachment:${payload.kind}`,
      ),
    ],
  };
}

export function emitWorkspaceShareEdge(input: unknown): EmittedWorkspaceAtom {
  const payload = validateWorkspaceShareEdge(input);
  const instance: WorkspaceShareEdgeAtomInstance = {
    entityType: "workspace-share-edge",
    ...baseEnvelope(payload, "workspace-share-edge", payload.workspaceDid),
    fromUserDid: payload.fromUserDid,
    toUserDid: payload.toUserDid,
    workspaceDid: payload.workspaceDid,
    sharedAt: payload.sharedAt,
    consentFlags: payload.consentFlags,
  };
  const workspaceTarget = workspaceTargetFromDid(payload.workspaceDid);
  return {
    instance,
    links: [
      link(
        { entityType: instance.entityType, entityId: instance.entityId },
        workspaceTarget,
        "applies-to",
        "workspace share edge",
      ),
    ],
  };
}

/** Dispatch on contract `entityType` for ingest pipelines. */
export function emitWorkspaceAtom(input: {
  entityType: WorkspaceAtomInstance["entityType"];
  [key: string]: unknown;
}): EmittedWorkspaceAtom {
  switch (input.entityType) {
    case "property-workspace":
      return emitPropertyWorkspace(input);
    case "brief-run":
      return emitBriefRun(input);
    case "workspace-attachment":
      return emitWorkspaceAttachment(input);
    case "workspace-share-edge":
      return emitWorkspaceShareEdge(input);
    default: {
      const _exhaustive: never = input.entityType;
      throw new Error(`emitWorkspaceAtom: unknown entityType ${_exhaustive}`);
    }
  }
}
