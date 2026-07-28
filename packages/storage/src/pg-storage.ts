/**
 * Postgres-backed StoragePort for code-corpus atoms (Phase 1a).
 *
 * Persists atom instances to the `atoms` / `atom_links` / `jurisdiction_status`
 * tables defined in schema.ts + migration 005. The injected `postgres.Sql`
 * handle owns connection lifecycle — this class never opens its own connection.
 */

import {
  buildAtomDid,
  parseAtomDid,
  type AtomLink,
  type BoundaryEdgeAtomInstance,
  type CodeAtomInstance,
  type CodeAtomEntityType,
  type JurisdictionalOverlayAmendmentInstance,
  isBoundaryEdgeAtomInstance,
  isPropertyAtomInstance,
  isRoadNodeAtomInstance,
  type PropertyAtomInstance,
  type RoadNodeAtomInstance,
  type StoredAtomInstance,
} from "@hauska-engine/atoms";
import postgres from "postgres";

import { InProcessIpfsPin } from "./in-process-cache.js";
import type {
  AtomQuery,
  AtomSearchResult,
  GraphNodeListQuery,
  GraphNodeListResult,
  GraphNodeListRow,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "./port.js";
import {
  matchesAtomQuery,
  rankSearchResults,
  scoreAtomSearch,
} from "./search-scoring.js";

interface AtomBodyRow {
  body: unknown;
}

interface AtomDidRow {
  atom_did: string;
}

interface AtomLinkRow {
  from_atom_did: string;
  to_atom_did: string;
  link_type: string;
  context: string | null;
}

interface JurisdictionStatusRow {
  jurisdiction_tenant: string;
  jurisdiction_name: string;
  current_edition_did: string | null;
  quality_bar: string;
  top3_score: number | null;
  section_num_score: number | null;
  cross_ref_score: number | null;
  atom_count: number;
  last_refreshed_at: Date | string | null;
  drift_status: string;
  access_policy: string;
}

function parseStoredAtom(body: unknown): StoredAtomInstance | null {
  if (typeof body !== "object" || body === null) return null;
  if (isPropertyAtomInstance(body)) return body;
  if (isRoadNodeAtomInstance(body)) return body;
  if (isBoundaryEdgeAtomInstance(body)) return body;
  const candidate = body as Partial<CodeAtomInstance>;
  if (!candidate.entityType || !candidate.entityId) return null;
  return body as CodeAtomInstance;
}

function resolveAccessPolicy(
  instance: CodeAtomInstance | PropertyAtomInstance | RoadNodeAtomInstance,
): string {
  const maybePolicy = (instance as { accessPolicy?: string }).accessPolicy;
  return maybePolicy ?? "public-free";
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Property atom entity_types that anchor a parcel node via body.parcelNodeId.
 * Mirrors listPropertyAtomsByParcelNodeId — parcels exist implicitly as
 * DISTINCT body->>'parcelNodeId' over these families.
 */
const PARCEL_ANCHOR_ENTITY_TYPES = [
  "zoning-fact",
  "setback-rule",
  "buildable-envelope",
  "parcel-terrain-model",
] as const;

/**
 * Count-scan bound for listGraphNodes. When a filtered county roster has
 * more distinct nodes than this, `total` is reported as the cap with
 * `totalCapped: true` — a documented floor, never a silent lie. Keeps the
 * COUNT(DISTINCT jsonb expr) scan bounded at Bastrop scale (62k parcels).
 */
export const NODE_LIST_COUNT_CAP = 10_000;

/** Escape LIKE/ILIKE metacharacters so user `q` is a literal substring. */
function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface NodeListAggRow {
  node_id: string;
  display_name: string | null;
  atom_families: string[];
}

export class PgStorage implements StoragePort {
  private readonly ipfs = new InProcessIpfsPin();

  constructor(private readonly sql: postgres.Sql) {}

  async writeAtom(
    instance: CodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    const atomDid = buildAtomDid(instance.entityType, instance.entityId).raw;
    const pin = await this.ipfs.pin(instance.contentHash, JSON.stringify(instance));
    const sectionNumber =
      instance.entityType === "code-section" ? instance.sectionNumber : null;
    const subsectionPath =
      instance.entityType === "code-section" ? instance.subsectionPath : null;

    await this.sql`
      INSERT INTO atoms (
        atom_did,
        cid,
        content_hash,
        entity_type,
        entity_id,
        jurisdiction_tenant,
        section_number,
        subsection_path,
        source_adapter,
        source_url,
        fetched_at,
        body,
        access_policy
      ) VALUES (
        ${atomDid},
        ${pin.cid},
        ${instance.contentHash},
        ${instance.entityType},
        ${instance.entityId},
        ${instance.jurisdictionTenant},
        ${sectionNumber},
        ${subsectionPath},
        ${instance.sourceAdapter},
        ${instance.sourceUrl},
        ${instance.fetchedAt},
        ${this.sql.json(instance as unknown as Parameters<typeof this.sql.json>[0])},
        ${resolveAccessPolicy(instance)}
      )
      ON CONFLICT (atom_did) DO UPDATE SET
        cid = EXCLUDED.cid,
        content_hash = EXCLUDED.content_hash,
        entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
        section_number = EXCLUDED.section_number,
        subsection_path = EXCLUDED.subsection_path,
        source_adapter = EXCLUDED.source_adapter,
        source_url = EXCLUDED.source_url,
        fetched_at = EXCLUDED.fetched_at,
        body = EXCLUDED.body,
        access_policy = EXCLUDED.access_policy,
        updated_at = now()
    `;

    return { atomDid, cid: pin.cid };
  }

  async writePropertyAtom(
    instance: PropertyAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    const atomDid =
      typeof instance.atomDid === "string" &&
      instance.atomDid.startsWith("did:hauska:")
        ? instance.atomDid
        : buildAtomDid(instance.entityType, instance.entityId).raw;
    const pin = await this.ipfs.pin(instance.contentHash, JSON.stringify(instance));

    await this.sql`
      INSERT INTO atoms (
        atom_did,
        cid,
        content_hash,
        entity_type,
        entity_id,
        jurisdiction_tenant,
        section_number,
        subsection_path,
        source_adapter,
        source_url,
        fetched_at,
        body,
        access_policy
      ) VALUES (
        ${atomDid},
        ${pin.cid},
        ${instance.contentHash},
        ${instance.entityType},
        ${instance.entityId},
        ${instance.jurisdictionTenant},
        ${null},
        ${null},
        ${instance.sourceAdapter},
        ${instance.sourceUrl},
        ${instance.fetchedAt},
        ${this.sql.json(instance as unknown as Parameters<typeof this.sql.json>[0])},
        ${resolveAccessPolicy(instance)}
      )
      ON CONFLICT (atom_did) DO UPDATE SET
        cid = EXCLUDED.cid,
        content_hash = EXCLUDED.content_hash,
        entity_type = EXCLUDED.entity_type,
        entity_id = EXCLUDED.entity_id,
        jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
        section_number = EXCLUDED.section_number,
        subsection_path = EXCLUDED.subsection_path,
        source_adapter = EXCLUDED.source_adapter,
        source_url = EXCLUDED.source_url,
        fetched_at = EXCLUDED.fetched_at,
        body = EXCLUDED.body,
        access_policy = EXCLUDED.access_policy,
        updated_at = now()
    `;

    return { atomDid, cid: pin.cid };
  }

  async writePropertyAtomsBatch(
    instances: ReadonlyArray<PropertyAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    if (instances.length === 0) return [];
    const prepared: Array<{
      atom_did: string;
      cid: string;
      content_hash: string;
      entity_type: string;
      entity_id: string;
      jurisdiction_tenant: string;
      source_adapter: string;
      source_url: string;
      fetched_at: string;
      body: PropertyAtomInstance;
      access_policy: string;
    }> = [];
    const out: Array<{ atomDid: string; cid: string }> = [];

    for (const instance of instances) {
      const atomDid =
        typeof instance.atomDid === "string" &&
        instance.atomDid.startsWith("did:hauska:")
          ? instance.atomDid
          : buildAtomDid(instance.entityType, instance.entityId).raw;
      const pin = await this.ipfs.pin(
        instance.contentHash,
        JSON.stringify(instance),
      );
      prepared.push({
        atom_did: atomDid,
        cid: pin.cid,
        content_hash: instance.contentHash,
        entity_type: instance.entityType,
        entity_id: instance.entityId,
        jurisdiction_tenant: instance.jurisdictionTenant,
        source_adapter: instance.sourceAdapter,
        source_url: instance.sourceUrl,
        fetched_at: instance.fetchedAt,
        body: instance,
        access_policy: resolveAccessPolicy(instance),
      });
      out.push({ atomDid, cid: pin.cid });
    }

    // Concurrent upserts within the batch (breadth throughput).
    const CONCURRENCY = 32;
    for (let i = 0; i < prepared.length; i += CONCURRENCY) {
      const slice = prepared.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(
          (row) => this.sql`
            INSERT INTO atoms (
              atom_did,
              cid,
              content_hash,
              entity_type,
              entity_id,
              jurisdiction_tenant,
              section_number,
              subsection_path,
              source_adapter,
              source_url,
              fetched_at,
              body,
              access_policy
            ) VALUES (
              ${row.atom_did},
              ${row.cid},
              ${row.content_hash},
              ${row.entity_type},
              ${row.entity_id},
              ${row.jurisdiction_tenant},
              ${null},
              ${null},
              ${row.source_adapter},
              ${row.source_url},
              ${row.fetched_at},
              ${this.sql.json(row.body as unknown as Parameters<typeof this.sql.json>[0])},
              ${row.access_policy}
            )
            ON CONFLICT (atom_did) DO UPDATE SET
              cid = EXCLUDED.cid,
              content_hash = EXCLUDED.content_hash,
              entity_type = EXCLUDED.entity_type,
              entity_id = EXCLUDED.entity_id,
              jurisdiction_tenant = EXCLUDED.jurisdiction_tenant,
              source_adapter = EXCLUDED.source_adapter,
              source_url = EXCLUDED.source_url,
              fetched_at = EXCLUDED.fetched_at,
              body = EXCLUDED.body,
              access_policy = EXCLUDED.access_policy,
              updated_at = now()
          `,
        ),
      );
    }
    return out;
  }

  async listPropertyAtomsByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<PropertyAtomInstance>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type IN (
          'zoning-fact',
          'setback-rule',
          'buildable-envelope',
          -- Site-plan / terrain export persists artifacts on this entity.
          -- Omitting it made refresh succeed while GET/download always 404'd.
          'parcel-terrain-model'
        )
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND COALESCE(body->>'status', 'active') = 'active'
      ORDER BY entity_type ASC, updated_at DESC
    `;
    // One active atom per entityType; prefer canonical entityId (= parcelNodeId).
    const byType = new Map<string, PropertyAtomInstance>();
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (!inst || !isPropertyAtomInstance(inst)) continue;
      const prior = byType.get(inst.entityType);
      if (!prior) {
        byType.set(inst.entityType, inst);
        continue;
      }
      if (inst.entityId === parcelNodeId && prior.entityId !== parcelNodeId) {
        byType.set(inst.entityType, inst);
      }
    }
    return [...byType.values()];
  }

  async writeRoadAtom(
    instance: RoadNodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    return (await this.writeRoadAtomsBatch([instance]))[0]!;
  }

  async writeRoadAtomsBatch(
    instances: ReadonlyArray<RoadNodeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    return this.writePropertyAtomsBatch(
      instances as unknown as ReadonlyArray<PropertyAtomInstance>,
    );
  }

  async listRoadAtomsByRoadNodeId(
    roadNodeId: string,
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type = 'road-node'
        AND body->>'roadNodeId' = ${roadNodeId}
        AND COALESCE(body->>'status', 'active') = 'active'
      ORDER BY updated_at DESC
    `;
    const out: RoadNodeAtomInstance[] = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (inst && isRoadNodeAtomInstance(inst)) out.push(inst);
    }
    return out;
  }

  async listRoadAtomsNearBbox(
    countyFips: string,
    bbox: {
      westLng: number;
      southLat: number;
      eastLng: number;
      northLat: number;
    },
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<RoadNodeAtomInstance>> {
    // jsonb centerline intersection — no PostGIS required on substrate Neon.
    // Prefer longer centerlines so the map fills with real streets, not stubs.
    const limit =
      typeof opts?.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(Math.floor(opts.limit), 2000))
        : 500;
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type = 'road-node'
        AND body->>'countyFips' = ${countyFips}
        AND COALESCE(body->>'status', 'active') = 'active'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(body->'centerline'->'coordinates') AS pt
          WHERE (pt->>0)::float8 BETWEEN ${bbox.westLng} AND ${bbox.eastLng}
            AND (pt->>1)::float8 BETWEEN ${bbox.southLat} AND ${bbox.northLat}
        )
      ORDER BY jsonb_array_length(COALESCE(body->'centerline'->'coordinates', '[]'::jsonb)) DESC,
               updated_at DESC
      LIMIT ${limit}
    `;
    const out: RoadNodeAtomInstance[] = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (inst && isRoadNodeAtomInstance(inst)) out.push(inst);
    }
    return out;
  }

  async writeBoundaryEdgeAtom(
    instance: BoundaryEdgeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    return (await this.writeBoundaryEdgeAtomsBatch([instance]))[0]!;
  }

  async writeBoundaryEdgeAtomsBatch(
    instances: ReadonlyArray<BoundaryEdgeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    return this.writePropertyAtomsBatch(
      instances as unknown as ReadonlyArray<PropertyAtomInstance>,
    );
  }

  async listBoundaryEdgesByParcelNodeId(
    parcelNodeId: string,
  ): Promise<ReadonlyArray<BoundaryEdgeAtomInstance>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type = 'property-boundary-edge'
        AND body->>'parcelNodeId' = ${parcelNodeId}
        AND COALESCE(body->>'status', 'active') = 'active'
      ORDER BY (body->>'edgeIndex')::int ASC, updated_at DESC
    `;
    const out: BoundaryEdgeAtomInstance[] = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (inst && isBoundaryEdgeAtomInstance(inst)) out.push(inst);
    }
    return out;
  }

  /**
   * County → node roster LIST (CC browse). Parcels exist implicitly as
   * DISTINCT body->>'parcelNodeId' over the property atom families; roads as
   * DISTINCT body->>'roadNodeId' over 'road-node'. County filter for parcels
   * is a `{fips}:` prefix LIKE on parcelNodeId (property atom bodies carry NO
   * countyFips field — verified against @empressaio/atom-contract/property).
   * Served by the migration-008 partial expression indexes
   * (text_pattern_ops → prefix LIKE + equality both indexable).
   */
  async listGraphNodes(query: GraphNodeListQuery): Promise<GraphNodeListResult> {
    const { countyFips, nodeType, limit, offset } = query;
    const q = query.q?.trim() ?? "";
    const qPattern = q.length > 0 ? `%${escapeLikePattern(q)}%` : null;
    const parcelPrefix = `${countyFips}:%`;
    const parcelTypes = [...PARCEL_ANCHOR_ENTITY_TYPES];

    let rows: NodeListAggRow[];
    let countRows: Array<{ total: number }>;

    if (nodeType === "road") {
      const qFrag = qPattern
        ? this.sql`AND (body->>'roadNodeId' ILIKE ${qPattern} OR body->>'displayName' ILIKE ${qPattern})`
        : this.sql``;
      rows = await this.sql<NodeListAggRow[]>`
        SELECT body->>'roadNodeId' AS node_id,
               MAX(body->>'displayName') AS display_name,
               array_agg(DISTINCT entity_type) AS atom_families
        FROM atoms
        WHERE entity_type = 'road-node'
          AND body->>'countyFips' = ${countyFips}
          AND COALESCE(body->>'status', 'active') = 'active'
          ${qFrag}
        GROUP BY body->>'roadNodeId'
        ORDER BY MAX(body->>'displayName') ASC NULLS LAST,
                 body->>'roadNodeId' ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRows = await this.sql<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total FROM (
          SELECT DISTINCT body->>'roadNodeId'
          FROM atoms
          WHERE entity_type = 'road-node'
            AND body->>'countyFips' = ${countyFips}
            AND COALESCE(body->>'status', 'active') = 'active'
            ${qFrag}
          LIMIT ${NODE_LIST_COUNT_CAP + 1}
        ) capped
      `;
    } else {
      // parcel: q matches nodeId (and therefore propId — propId is the
      // substring after "{fips}:"). No address/APN fields exist in bodies.
      const qFrag = qPattern
        ? this.sql`AND body->>'parcelNodeId' ILIKE ${qPattern}`
        : this.sql``;
      rows = await this.sql<NodeListAggRow[]>`
        SELECT body->>'parcelNodeId' AS node_id,
               NULL AS display_name,
               array_agg(DISTINCT entity_type) AS atom_families
        FROM atoms
        WHERE entity_type IN ${this.sql(parcelTypes)}
          AND body->>'parcelNodeId' LIKE ${parcelPrefix}
          AND COALESCE(body->>'status', 'active') = 'active'
          ${qFrag}
        GROUP BY body->>'parcelNodeId'
        ORDER BY body->>'parcelNodeId' ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      countRows = await this.sql<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total FROM (
          SELECT DISTINCT body->>'parcelNodeId'
          FROM atoms
          WHERE entity_type IN ${this.sql(parcelTypes)}
            AND body->>'parcelNodeId' LIKE ${parcelPrefix}
            AND COALESCE(body->>'status', 'active') = 'active'
            ${qFrag}
          LIMIT ${NODE_LIST_COUNT_CAP + 1}
        ) capped
      `;
    }

    const rawTotal = countRows[0]?.total ?? 0;
    const totalCapped = rawTotal > NODE_LIST_COUNT_CAP;
    const total = totalCapped ? NODE_LIST_COUNT_CAP : rawTotal;

    let countyHasNodes = total > 0;
    if (!countyHasNodes) {
      // Distinguish "q matched nothing" from "county has no nodes at all".
      const probe =
        nodeType === "road"
          ? await this.sql<Array<{ one: number }>>`
              SELECT 1 AS one FROM atoms
              WHERE entity_type = 'road-node'
                AND body->>'countyFips' = ${countyFips}
                AND COALESCE(body->>'status', 'active') = 'active'
              LIMIT 1
            `
          : await this.sql<Array<{ one: number }>>`
              SELECT 1 AS one FROM atoms
              WHERE entity_type IN ${this.sql(parcelTypes)}
                AND body->>'parcelNodeId' LIKE ${parcelPrefix}
                AND COALESCE(body->>'status', 'active') = 'active'
              LIMIT 1
            `;
      countyHasNodes = probe.length > 0;
    }

    const nodes: GraphNodeListRow[] = rows.map((row) => {
      if (nodeType === "road") {
        const displayName = row.display_name ?? null;
        return {
          nodeId: row.node_id,
          nodeType,
          displayName,
          identifiers: displayName ? { roadName: displayName } : {},
          atomFamilies: row.atom_families ?? [],
        };
      }
      const propId = row.node_id.split(":")[1];
      return {
        nodeId: row.node_id,
        nodeType,
        displayName: null,
        identifiers: propId ? { propId } : {},
        atomFamilies: row.atom_families ?? [],
      };
    });

    return { nodes, total, totalCapped, countyHasNodes };
  }

  async writeAtoms(
    instances: ReadonlyArray<CodeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    const out: Array<{ atomDid: string; cid: string }> = [];
    for (const inst of instances) {
      out.push(await this.writeAtom(inst));
    }
    return out;
  }

  async writeAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void> {
    for (const link of links) {
      const fromAtomDid = buildAtomDid(link.fromEntityType, link.fromEntityId).raw;
      const toAtomDid = buildAtomDid(link.toEntityType, link.toEntityId).raw;
      await this.sql`
        INSERT INTO atom_links (from_atom_did, to_atom_did, link_type, context)
        VALUES (
          ${fromAtomDid},
          ${toAtomDid},
          ${link.linkType},
          ${link.context ?? null}
        )
        ON CONFLICT (from_atom_did, to_atom_did, link_type) DO NOTHING
      `;
    }
  }

  async getAtom<T extends CodeAtomEntityType>(
    entityType: T,
    entityId: string,
  ): Promise<Extract<CodeAtomInstance, { entityType: T }> | null> {
    const atomDid = buildAtomDid(entityType, entityId).raw;
    return this.getAtomByDid(atomDid) as Promise<
      Extract<CodeAtomInstance, { entityType: T }> | null
    >;
  }

  async getAtomByDid(atomDid: string): Promise<StoredAtomInstance | null> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE atom_did = ${atomDid}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return parseStoredAtom(row.body);
  }

  async search(query: AtomQuery): Promise<ReadonlyArray<AtomSearchResult>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      ORDER BY updated_at DESC
    `;
    const results: AtomSearchResult[] = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (!inst) continue;
      if (!matchesAtomQuery(inst, query)) continue;
      const atomDid = buildAtomDid(inst.entityType, inst.entityId).raw;
      const scored = scoreAtomSearch(inst, atomDid, query);
      if (scored) results.push(scored);
    }
    return rankSearchResults(results, query.limit ?? 25);
  }

  async getSectionsBySectionNumber(
    jurisdictionTenant: string,
    sectionNumber: string,
  ): Promise<ReadonlyArray<Extract<CodeAtomInstance, { entityType: "code-section" }>>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type = 'code-section'
        AND jurisdiction_tenant = ${jurisdictionTenant}
        AND section_number = ${sectionNumber}
    `;
    const out: Array<Extract<CodeAtomInstance, { entityType: "code-section" }>> = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (inst?.entityType === "code-section") out.push(inst);
    }
    return out;
  }

  async getJurisdictionalOverlays(
    jurisdictionTenant: string,
    baseSectionId: string,
  ): Promise<ReadonlyArray<JurisdictionalOverlayAmendmentInstance>> {
    const rows = await this.sql<AtomBodyRow[]>`
      SELECT body
      FROM atoms
      WHERE entity_type = 'code-amendment'
        AND jurisdiction_tenant = ${jurisdictionTenant}
    `;
    const out: JurisdictionalOverlayAmendmentInstance[] = [];
    for (const row of rows) {
      const inst = parseStoredAtom(row.body);
      if (inst?.entityType !== "code-amendment") continue;
      if (inst.amendmentScope !== "jurisdictional-overlay") continue;
      if (!inst.affectedSectionIds.includes(baseSectionId)) continue;
      out.push(inst);
    }
    out.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    return out;
  }

  async traverse(
    fromAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<ReadonlyArray<AtomLink & { toAtom: StoredAtomInstance | null }>> {
    const rows = linkType
      ? await this.sql<AtomLinkRow[]>`
          SELECT from_atom_did, to_atom_did, link_type, context
          FROM atom_links
          WHERE from_atom_did = ${fromAtomDid}
            AND link_type = ${linkType}
        `
      : await this.sql<AtomLinkRow[]>`
          SELECT from_atom_did, to_atom_did, link_type, context
          FROM atom_links
          WHERE from_atom_did = ${fromAtomDid}
        `;
    const out: Array<AtomLink & { toAtom: StoredAtomInstance | null }> = [];
    for (const row of rows) {
      const fromParsed = parseAtomDid(row.from_atom_did);
      const toAtom = await this.getAtomByDid(row.to_atom_did);
      out.push({
        fromEntityType: fromParsed.entityType,
        fromEntityId: fromParsed.localId,
        toEntityType: toAtom
          ? toAtom.entityType
          : parseAtomDid(row.to_atom_did).entityType,
        toEntityId: toAtom
          ? toAtom.entityId
          : parseAtomDid(row.to_atom_did).localId,
        linkType: row.link_type as AtomLink["linkType"],
        context: row.context ?? undefined,
        toAtom,
      });
    }
    return out;
  }

  async traverseInbound(
    toAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<
    ReadonlyArray<AtomLink & { fromAtom: StoredAtomInstance | null }>
  > {
    const rows = linkType
      ? await this.sql<AtomLinkRow[]>`
          SELECT from_atom_did, to_atom_did, link_type, context
          FROM atom_links
          WHERE to_atom_did = ${toAtomDid}
            AND link_type = ${linkType}
        `
      : await this.sql<AtomLinkRow[]>`
          SELECT from_atom_did, to_atom_did, link_type, context
          FROM atom_links
          WHERE to_atom_did = ${toAtomDid}
        `;
    const out: Array<AtomLink & { fromAtom: StoredAtomInstance | null }> = [];
    for (const row of rows) {
      const fromAtom = await this.getAtomByDid(row.from_atom_did);
      const toParsed = parseAtomDid(row.to_atom_did);
      out.push({
        fromEntityType: fromAtom
          ? fromAtom.entityType
          : parseAtomDid(row.from_atom_did).entityType,
        fromEntityId: fromAtom
          ? fromAtom.entityId
          : parseAtomDid(row.from_atom_did).localId,
        toEntityType: toParsed.entityType,
        toEntityId: toParsed.localId,
        linkType: row.link_type as AtomLink["linkType"],
        context: row.context ?? undefined,
        fromAtom,
      });
    }
    return out;
  }

  async listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
    accessPolicies?: ReadonlyArray<
      import("@hauska-engine/atoms").AccessPolicy
    >;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    const rows = await this.sql<JurisdictionStatusRow[]>`
      SELECT
        jurisdiction_tenant,
        jurisdiction_name,
        current_edition_did,
        quality_bar,
        top3_score,
        section_num_score,
        cross_ref_score,
        atom_count,
        last_refreshed_at,
        drift_status,
        access_policy
      FROM jurisdiction_status
      ORDER BY jurisdiction_tenant ASC
    `;
    let snapshots = rows.map(rowToSnapshot);
    if (filter?.qualityBarOnly) {
      snapshots = snapshots.filter((s) => s.qualityBar.startsWith("passing"));
    }
    if (filter?.accessPolicies && filter.accessPolicies.length > 0) {
      const allowed = new Set(filter.accessPolicies);
      snapshots = snapshots.filter((s) =>
        allowed.has(s.accessPolicy ?? "public-free"),
      );
    }
    return snapshots;
  }

  async upsertJurisdictionStatus(
    snapshot: JurisdictionStatusSnapshot,
  ): Promise<void> {
    await this.sql`
      INSERT INTO jurisdiction_status (
        jurisdiction_tenant,
        jurisdiction_name,
        current_edition_did,
        quality_bar,
        top3_score,
        section_num_score,
        cross_ref_score,
        atom_count,
        last_refreshed_at,
        drift_status,
        access_policy
      ) VALUES (
        ${snapshot.jurisdictionTenant},
        ${snapshot.jurisdictionName},
        ${snapshot.currentEditionDid},
        ${snapshot.qualityBar},
        ${snapshot.top3Score},
        ${snapshot.sectionNumScore},
        ${snapshot.crossRefScore},
        ${snapshot.atomCount},
        ${snapshot.lastRefreshedAt},
        ${snapshot.driftStatus},
        ${snapshot.accessPolicy ?? "public-free"}
      )
      ON CONFLICT (jurisdiction_tenant) DO UPDATE SET
        jurisdiction_name = EXCLUDED.jurisdiction_name,
        current_edition_did = EXCLUDED.current_edition_did,
        quality_bar = EXCLUDED.quality_bar,
        top3_score = EXCLUDED.top3_score,
        section_num_score = EXCLUDED.section_num_score,
        cross_ref_score = EXCLUDED.cross_ref_score,
        atom_count = EXCLUDED.atom_count,
        last_refreshed_at = EXCLUDED.last_refreshed_at,
        drift_status = EXCLUDED.drift_status,
        access_policy = EXCLUDED.access_policy
    `;
  }

  async countAtoms(): Promise<number> {
    const rows = await this.sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM atoms
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Return all atom DIDs currently stored in Postgres. */
  async listAtomDids(): Promise<ReadonlyArray<string>> {
    const rows = await this.sql<AtomDidRow[]>`
      SELECT atom_did FROM atoms ORDER BY atom_did ASC
    `;
    return rows.map((row) => row.atom_did);
  }
}

function rowToSnapshot(row: JurisdictionStatusRow): JurisdictionStatusSnapshot {
  return {
    jurisdictionTenant: row.jurisdiction_tenant,
    jurisdictionName: row.jurisdiction_name,
    currentEditionDid: row.current_edition_did,
    qualityBar: row.quality_bar as JurisdictionStatusSnapshot["qualityBar"],
    top3Score: row.top3_score,
    sectionNumScore: row.section_num_score,
    crossRefScore: row.cross_ref_score,
    atomCount: row.atom_count,
    lastRefreshedAt: toIsoString(row.last_refreshed_at),
    driftStatus: row.drift_status as JurisdictionStatusSnapshot["driftStatus"],
    accessPolicy: row.access_policy as JurisdictionStatusSnapshot["accessPolicy"],
  };
}

export interface CreatePgStorageOptions {
  databaseUrl: string;
  /** Override max pool size (default 5). */
  maxConnections?: number;
}

export interface PgStorageHandle {
  storage: PgStorage;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/** Open a shared Postgres handle and wrap it in `PgStorage`. */
export function createPgStorage(options: CreatePgStorageOptions): PgStorageHandle {
  const ssl =
    options.databaseUrl.includes("sslmode=require") ||
    options.databaseUrl.includes("neon.tech")
      ? ("require" as const)
      : false;
  const sql = postgres(options.databaseUrl, {
    ssl,
    max: options.maxConnections ?? 5,
  });
  return {
    storage: new PgStorage(sql),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export function resolveSubstrateDatabaseUrl(
  explicit?: string,
): string | undefined {
  return explicit ?? process.env.SUBSTRATE_DATABASE_URL ?? process.env.DATABASE_URL;
}
