/**
 * Engine-side workspace atom instances for Brokerage V1.
 *
 * Shapes mirror `@hauska/atom-contract/workspace` payloads plus the
 * engine `BaseAtomInstance` provenance envelope (content hash, source
 * adapter, jurisdiction tenant). The contract `did` is canonical;
 * `entityId` is the DID local segment for registry lookup.
 */

import { z } from "zod";

import type { AccessPolicy } from "@hauska-engine/atom-contract-pin";
import type {
  BriefRunCitationRef,
  PropertyAddressIdentity,
  UserRef,
  WorkspaceAttachmentKind,
  WorkspaceShareConsentFlags,
} from "@hauska/atom-contract/workspace";

import type { BaseAtomInstance } from "./instances.js";

const ACCESS_POLICY_SCHEMA = z.enum([
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
]);

export type {
  BriefRunCitationRef,
  PropertyAddressIdentity,
  UserRef,
  WorkspaceAttachmentKind,
  WorkspaceShareConsentFlags,
};

/** Brokerage workspace atoms use a synthetic jurisdiction tenant for indexing. */
export const WORKSPACE_JURISDICTION_TENANT = "brokerage-workspace-v1";

export const WORKSPACE_SOURCE_ADAPTER = "brokerage-workspace-v1";

export interface WorkspaceAtomInstanceBase extends BaseAtomInstance {
  /** Canonical contract DID — may differ from `buildAtomDid(entityType, entityId)`. */
  did: string;
  createdAt: string;
  updatedAt: string;
  accessPolicy: AccessPolicy;
}

export interface PropertyWorkspaceAtomInstance extends WorkspaceAtomInstanceBase {
  entityType: "property-workspace";
  address: PropertyAddressIdentity;
  listingUrls: ReadonlyArray<string>;
  owner: UserRef;
  collaborators: ReadonlyArray<UserRef>;
}

export interface BriefRunAtomInstance extends WorkspaceAtomInstanceBase {
  entityType: "brief-run";
  workspaceDid: string;
  runInputs: Record<string, unknown>;
  citationRefs: ReadonlyArray<BriefRunCitationRef>;
  confidence: number;
  generatedAt: string;
}

export interface WorkspaceAttachmentAtomInstance extends WorkspaceAtomInstanceBase {
  entityType: "workspace-attachment";
  workspaceDid: string;
  kind: WorkspaceAttachmentKind;
  uri?: string;
  body?: string;
  uploader: UserRef;
}

export interface WorkspaceShareEdgeAtomInstance extends WorkspaceAtomInstanceBase {
  entityType: "workspace-share-edge";
  fromUserDid: string;
  toUserDid: string;
  workspaceDid: string;
  sharedAt: string;
  consentFlags: WorkspaceShareConsentFlags;
}

export type WorkspaceAtomInstance =
  | PropertyWorkspaceAtomInstance
  | BriefRunAtomInstance
  | WorkspaceAttachmentAtomInstance
  | WorkspaceShareEdgeAtomInstance;

export type WorkspaceAtomEntityType = WorkspaceAtomInstance["entityType"];

export const WORKSPACE_ATOM_ENTITY_TYPES: ReadonlyArray<WorkspaceAtomEntityType> = [
  "property-workspace",
  "brief-run",
  "workspace-attachment",
  "workspace-share-edge",
];

const WORKSPACE_BASE_SHAPE = {
  entityId: z.string().min(1),
  did: z.string().min(1),
  jurisdictionTenant: z.string().min(1),
  fetchedAt: z.string().min(1),
  sourceAdapter: z.string().min(1),
  sourceUrl: z.string(),
  contentHash: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  accessPolicy: ACCESS_POLICY_SCHEMA,
} as const;

const USER_REF_SCHEMA = z.object({
  did: z.string().min(1),
  displayName: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
});

const PROPERTY_ADDRESS_SCHEMA = z.object({
  line1: z.string().min(1),
  line2: z.string().min(1).optional(),
  city: z.string().min(1),
  stateOrProvince: z.string().min(1),
  postalCode: z.string().min(1),
  countryCode: z.string().length(2),
});

export const PROPERTY_WORKSPACE_INSTANCE_SCHEMA = z.object({
  ...WORKSPACE_BASE_SHAPE,
  entityType: z.literal("property-workspace"),
  address: PROPERTY_ADDRESS_SCHEMA,
  listingUrls: z.array(z.string().url()).min(1),
  owner: USER_REF_SCHEMA,
  collaborators: z.array(USER_REF_SCHEMA),
});

export const BRIEF_RUN_CITATION_REF_SCHEMA = z.object({
  citationDid: z.string().min(1),
  sourceType: z.enum(["attachment", "atom", "external-link"]),
});

export const BRIEF_RUN_INSTANCE_SCHEMA = z.object({
  ...WORKSPACE_BASE_SHAPE,
  entityType: z.literal("brief-run"),
  workspaceDid: z.string().min(1),
  runInputs: z.record(z.string(), z.unknown()),
  citationRefs: z.array(BRIEF_RUN_CITATION_REF_SCHEMA),
  confidence: z.number().min(0).max(1),
  generatedAt: z.string().min(1),
});

export const WORKSPACE_ATTACHMENT_INSTANCE_SCHEMA = z.object({
  ...WORKSPACE_BASE_SHAPE,
  entityType: z.literal("workspace-attachment"),
  workspaceDid: z.string().min(1),
  kind: z.enum(["link", "image", "pdf", "note"]),
  uri: z.string().url().optional(),
  body: z.string().min(1).optional(),
  uploader: USER_REF_SCHEMA,
});

export const WORKSPACE_SHARE_EDGE_INSTANCE_SCHEMA = z.object({
  ...WORKSPACE_BASE_SHAPE,
  entityType: z.literal("workspace-share-edge"),
  fromUserDid: z.string().min(1),
  toUserDid: z.string().min(1),
  workspaceDid: z.string().min(1),
  sharedAt: z.string().min(1),
  consentFlags: z.object({
    ownerGranted: z.boolean(),
    recipientAccepted: z.boolean(),
    canReshare: z.boolean(),
  }),
});
