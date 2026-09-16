import {
  classifySetbackRuleAtom,
  fetchUsgs3depDem,
  selectAdaptiveResolutionMeters,
  DEFAULT_TERRAIN_RESOLUTION_METERS,
  type BboxWgs84,
} from "@hauska-engine/adapters";
import { femaNfhlAdapter } from "@hauska-engine/adapters/federal/fema-nfhl";
import { envelopeHuman } from "@empressaio/atom-contract/display";
import type {
  BoundaryEdgeAtomInstance,
  BuildableEnvelopeAtomInstance,
  ParcelTerrainModelAtomInstance,
  RoadNodeAtomInstance,
  SetbackRuleAtomInstance,
  ZoningFactAtomInstance,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import { TERRAIN_VERTICAL_DATUM } from "../parcel-terrain/elevation.js";
import { resolveContourSource } from "../parcel-terrain/contour-source.js";
import { buildTerrainMeshGeometry } from "../parcel-terrain/mesh.js";
import { DEFAULT_SKIRT_DEPTH_FEET, type BuildTerrainSolidMassOptions } from "../parcel-terrain/solid-mass.js";
import type { ParcelGeometryResolver, TerrainArtifactStore } from "../parcel-terrain/author.js";
import { parseDemBytes, type ParsedDem } from "../site-topography/index.js";
import { roadAtomToWarmSource } from "../road-intake/road-to-warm-source.js";
import type { WarmRoadSource } from "../depth-warm/types.js";
import { emitDxfSitePlan, emitIfcSitePlan } from "./emitters.js";
import type { AerialImageFetcher } from "./pdf/aerial.js";
import { emitPdfSitePlan } from "./pdf/render.js";
import { resolveAttachingRoadNodes } from "./resolve-attaching-roads.js";
import { resolveTerrainWindowBbox } from "./terrain-window.js";
import { prepareBoundaryEdgesForExport } from "./prepare-boundary-edges-for-export.js";
import { resolveSitusAddressForExport } from "./resolve-situs-for-export.js";
import { resolveExportSetback } from "./resolve-export-setback.js";
import type { ParcelRecordResponse, RecordReaderClient } from "./parcel-record-reader-client.js";
import {
  composeSitePlanModel,
  type EnvelopeOutcomeInput,
  type FloodZoneSummaryInput,
  type SitePlanDescriptorInput,
  type StreetAnchorInput,
  type ZoningSummaryInput,
} from "./site-model.js";
import { footprintsInputFromAtoms, type SitePlanFootprintsInput } from "./footprint-layer.js";
import {
  notSpecifiedAxesFromSetbackTable,
  resolveNotSpecifiedAxes,
} from "./setback-display.js";
import type { BoundaryEdgeGeometryInput } from "./ring-geometry.js";

/**
 * Map persisted property-boundary-edge atoms → the export's primitive-consuming
 * geometry input. Setback truth is the STORED per-edge resolved setback; an
 * absence (`no-setback-row` / `unmapped-adjacency`) maps to zero inset +
 * `setbackAbsent` (provisional label) — mirrors depth-warm's
 * `setbackFeetFromBoundaryAtom` exactly, never fabricates.
 */
export function boundaryEdgesToGeometryInput(
  atoms: ReadonlyArray<BoundaryEdgeAtomInstance>,
): BoundaryEdgeGeometryInput[] {
  return [...atoms]
    .sort((a, b) => a.edgeIndex - b.edgeIndex)
    .map((atom) => ({
      edgeIndex: atom.edgeIndex,
      role: atom.role,
      insetFeet: "kind" in atom.setback ? 0 : atom.setback.feet,
      setbackAbsent: "kind" in atom.setback,
      inwardNormal: atom.interior.inwardNormal,
    }));
}

/**
 * Best-effort live FEMA NFHL read for the PDF summary block. Any failure
 * (no network egress, upstream error, timeout) degrades to an honest
 * unavailable verdict rather than blocking the export or fabricating a
 * zone — mirrors the street-anchor honest-absence pattern above it.
 */
async function defaultFetchFloodZone(input: { latitude: number; longitude: number }): Promise<FloodZoneSummaryInput> {
  try {
    const result = await femaNfhlAdapter.run({
      parcel: { latitude: input.latitude, longitude: input.longitude },
      jurisdiction: { stateKey: null, localKey: null },
      signal: AbortSignal.timeout(8_000),
    });
    const payload = result.payload as { floodZone?: string | null; inSpecialFloodHazardArea?: boolean };
    return {
      zone: payload.floodZone ?? null,
      inSpecialFloodHazardArea: Boolean(payload.inSpecialFloodHazardArea),
      sourceCitation: result.provider,
      asOfIso: result.snapshotDate,
    };
  } catch (error) {
    // §11 split: the SHEET carries one plain sentence; the machine detail
    // (upstream error text) rides `detail` into the provenance SOURCE column
    // only — never into the summary row.
    return {
      honestUnavailable: true,
      reason: "FEMA flood lookup did not return for this parcel.",
      detail: `FEMA NFHL lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Looks up the parcel's zoning-fact atom for the summary block's zoning
 * district field. Honest-absence (never fabricated) when no atom exists or
 * the atom itself carries the fact-level honest-absence verdict.
 */
async function resolveZoningSummary(parcelNodeId: string, storage: StoragePort): Promise<ZoningSummaryInput> {
  const zoningFact = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
    (candidate): candidate is ZoningFactAtomInstance => candidate.entityType === "zoning-fact",
  );
  if (!zoningFact) {
    return { honestAbsence: true, reason: "No zoning-fact atom on file for this parcel." };
  }
  if (zoningFact.district) {
    return { district: zoningFact.district };
  }
  // P-167 wave 5 (OPS-23 R-4). This used to read `absence?.kind` — the RAW
  // machine code (e.g. "no-zoning-stamp") — straight onto the PDF's summary
  // sheet verbatim. The atom already carries a human sentence for this same
  // absence in `absence?.reason` (emit-zoning-fact.ts sets both together);
  // prefer it. Where a `reason` is missing (older atoms, or a kind this
  // package's vocabulary has not been told about), fall back to the shared
  // vocabulary's own humanization of the kind before ever falling to the
  // bare code, so this sheet never regresses to printing a machine token.
  return {
    honestAbsence: true,
    reason:
      zoningFact.absence?.reason ??
      envelopeHuman(zoningFact.absence?.kind) ??
      zoningFact.absence?.kind ??
      "zoning-fact atom carries no district (honest absence).",
  };
}

/**
 * Wraps the (default or caller-supplied) flood-zone lookup so ANY failure —
 * upstream, network, or a broken test stub — degrades to honest-unavailable
 * rather than rejecting the whole export. A missing flood read is never a
 * reason to withhold parcel/setback/terrain data the caller already has.
 */
async function resolveFloodZoneSummary(
  centroid: { latitude: number; longitude: number },
  fetchFloodZone: ((input: { latitude: number; longitude: number }) => Promise<FloodZoneSummaryInput>) | undefined,
): Promise<FloodZoneSummaryInput> {
  try {
    return await (fetchFloodZone ?? defaultFetchFloodZone)(centroid);
  } catch (error) {
    return {
      honestUnavailable: true,
      reason: `Flood-zone lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Best-effort lookup of the parcel's own buildable-envelope atom outcome
 * (a separate reasoning pipeline from this composer's own front-edge-basis
 * heuristic — see `property-reasoning/emit-buildable-envelope.ts`). Absent
 * atom is not an error: the site-plan buildable-area figure and its honesty
 * note stand on the composer's own ring-geometry basis regardless.
 */
async function resolveEnvelopeOutcome(
  parcelNodeId: string,
  storage: StoragePort,
): Promise<EnvelopeOutcomeInput | undefined> {
  const envelope = (await storage.listPropertyAtomsByParcelNodeId(parcelNodeId)).find(
    (candidate): candidate is BuildableEnvelopeAtomInstance => candidate.entityType === "buildable-envelope",
  );
  if (!envelope?.outcome) return envelope?.outcome;
  // P-159 (CP1): the atom instance carries its own `atomDid`, but `.outcome` alone
  // (the shape re-declared as `EnvelopeOutcomeInput` in site-model.ts) does not — so
  // returning it bare would leave the composer unable to tell "this outcome came
  // from a real persisted atom" from "this outcome was synthesized". Thread the
  // atom's own DID through on the one branch that can print a figure (Ruling B).
  return envelope.outcome.kind === "buildable"
    ? { ...envelope.outcome, atomDid: envelope.atomDid }
    : envelope.outcome;
}

/**
 * P-248 — the parcel's mapped footprints as the composer's input.
 *
 * Reads the SAME parcel atoms every other resolver here reads (the storage port
 * has no per-entity footprint read keyed by parcel; `listBuildingFootprintsNearBbox`
 * is a map layer that would drag a neighbouring parcel's building into this
 * sheet's drawing, so it is deliberately not used). Filtering and the three
 * honest layer states live in `footprint-layer.ts`, so the composer, the sheet
 * legends and this resolver cannot disagree about what "no footprint" means.
 *
 * Never throws: a store that fails here means the layer was not checked, which
 * the sheet states in words — it must not take a whole export down, and it must
 * not be drawn as a parcel with no building on it.
 */
async function resolveFootprintLayer(
  parcelNodeId: string,
  storage: StoragePort,
): Promise<SitePlanFootprintsInput> {
  try {
    const atoms = await storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    return footprintsInputFromAtoms(atoms);
  } catch {
    return { kind: "unchecked", reason: "not checked · the footprint source could not be read for this parcel" };
  }
}

function centroidOfRing(ringWgs84: Array<[number, number]>): { latitude: number; longitude: number } {
  const n = ringWgs84.length;
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ringWgs84) {
    sumLng += lng;
    sumLat += lat;
  }
  return { longitude: sumLng / n, latitude: sumLat / n };
}

export interface AuthorParcelSitePlanExportOptions {
  parcelNodeId: string;
  bboxOverride?: BboxWgs84;
  /** Test/operator override for the parcel boundary ring; production path
   * requires the resolver to supply one (fail closed otherwise). */
  ringOverride?: Array<[number, number]>;
  resolver: ParcelGeometryResolver;
  /**
   * The parcel's setback-rule atom. OPTIONAL: when absent, the export still
   * succeeds — the setback layer is drawn honest-absent (no F/S/R fabricated;
   * the offset ring equals the property line) and the sheet says "setbacks
   * not specified / not verified". A rule that IS present is drawn as before.
   * This never fabricates a setback — absent is honestly labeled absent.
   */
  setback?: SetbackRuleAtomInstance;
  /**
   * P-219 — the one reader (`recordReaderFromEnv`). OPTIONAL and never a
   * failure path: when absent or failing, `resolveExportSetback` falls to the
   * ruled corpus row the rails were themselves composed from. Pass it so the
   * sheet reads the SAME parcel_record rails `setbackRulesFact` renders.
   * `RETRIEVAL_API_URL` / `RETRIEVAL_API_KEY` are mounted on hauska-engine-api
   * (verified live 2026-09-15 by `gcloud run services describe`), so in
   * production this is the path that actually runs.
   */
  recordReader?: RecordReaderClient;
  /**
   * Jurisdiction key for the ruled setback table lookup (e.g.
   * "bastrop-development-code"). Optional: the resolver also tries the
   * Bastrop city routing key, matching `notSpecifiedAxesFromSetbackTable`.
   */
  setbackJurisdictionKey?: string | null;
  storage: StoragePort;
  artifactStore: TerrainArtifactStore;
  resolutionMeters?: number;
  contourIntervalMeters?: number;
  /**
   * Test seam for the parcel's boundary primitive. Production path loads the
   * parcel's property-boundary-edge atoms from storage; when the store has
   * none, the export falls back to `frontEdgeIndex` (resolved anchor) or the
   * honest unresolved-front-edge treatment — never a per-edge guess.
   */
  boundaryEdgesOverride?: ReadonlyArray<BoundaryEdgeAtomInstance>;
  frontEdgeIndex?: number;
  streetAnchors?: StreetAnchorInput[];
  /**
   * When true (default), load attaching road-nodes from storage when
   * streetAnchors are omitted. Set false in tests that assert honest-absence
   * without seeding road-nodes.
   */
  resolveStreetFromRoadNodes?: boolean;
  skirtDepthFeet?: number;
  fetchDem?: typeof fetchUsgs3depDem;
  parseDem?: (bytes: Uint8Array) => Promise<ParsedDem>;
  /** PDF summary-block-only descriptors (Wave 2). Caller-supplied only. */
  descriptor?: SitePlanDescriptorInput;
  /** Explicit zoning override (test seam); production path looks up the
   * parcel's zoning-fact atom from storage when omitted. */
  zoningOverride?: ZoningSummaryInput;
  /** Explicit flood-zone override (test seam); production path calls the
   * FEMA NFHL adapter when omitted, degrading to honest-unavailable on
   * any failure. */
  floodZoneOverride?: FloodZoneSummaryInput;
  fetchFloodZone?: (input: { latitude: number; longitude: number }) => Promise<FloodZoneSummaryInput>;
  /** Explicit buildable-envelope outcome override (test seam); production
   * path looks up the parcel's buildable-envelope atom from storage when
   * omitted (absence is not an error — see `resolveEnvelopeOutcome`). */
  envelopeOutcomeOverride?: EnvelopeOutcomeInput;
  /** P-248 test seam for the mapped footprint layer. Production path reads the
   * parcel's `building-footprint` atoms via `resolveFootprintLayer`; without
   * this seam a test (or the local verification harness) would need a store to
   * exercise the sheet's footprint drawing at all. */
  footprintsOverride?: SitePlanFootprintsInput;
  /** Test seam for the PDF sheet-3 aerial imagery fetch; production path
   * uses the bounded Esri World Imagery fetcher. Tests MUST stub this so
   * they never hit the network — any failure degrades to the honest
   * "imagery unavailable" page, never a failed export. */
  fetchAerialImage?: AerialImageFetcher;
}

export interface AuthorParcelSitePlanExportResult {
  atom: ParcelTerrainModelAtomInstance;
  setbackDegenerate: boolean;
  setbackDegenerateReason?: string;
  /** True when no setback-rule atom existed — layer drawn honest-absent. */
  setbackHonestAbsence: boolean;
  setbackHonestAbsenceReason?: string;
  streetHonestAbsence: boolean;
  zoningHonestAbsence: boolean;
  floodZoneHonestUnavailable: boolean;
  pdfPageCount: number;
}

/**
 * The model-composition phase of the site-plan export, extracted (2026-07-29,
 * dossier sprint) so the property-dossier export can compose the SAME
 * `SitePlanModel` — same resolver, DEM, atoms, streets, honest-absence
 * treatment — without paying for the DXF/IFC emissions it does not ship.
 * `authorParcelSitePlanExport` consumes this verbatim; there is exactly one
 * composition path (WDLL 5/6: one geometry truth, never a second source).
 */
export interface ComposeSitePlanModelForParcelResult {
  model: ReturnType<typeof composeSitePlanModel>;
  mesh: ReturnType<typeof buildTerrainMeshGeometry>;
  dem: ParsedDem;
  demFetch: Awaited<ReturnType<typeof fetchUsgs3depDem>>;
  resolvedSourceRef: string;
  contourSource: Awaited<ReturnType<typeof resolveContourSource>>;
  setbackHonestAbsence: boolean;
  zoning: ZoningSummaryInput;
  floodZone: FloodZoneSummaryInput;
  resolutionMetersRequested: number;
  resolutionMetersAdapted: number;
  contourIntervalMeters: number;
  /**
   * True when the parcel sat below the adapter's per-axis DEM pixel floor and
   * terrain was fetched over a widened window. Surfaced so the caller can
   * declare it rather than let it pass silently.
   */
  terrainWindowExpanded: boolean;
  /** Why the window was widened. Present only when expanded. */
  terrainWindowReason?: string;
  /**
   * The REAL WGS84 boundary ring this composition resolved (from the live
   * parcel-geometry resolver, or ringOverride for a test) and the centroid
   * derived from it. `composeSitePlanModel` consumes these to build `model`
   * but does not carry the raw ring back out on it (`model` keeps only
   * `ringLocal` + `bboxWgs84`) -- callers that need the WGS84 ring/centroid
   * for something other than the site-plan drawing itself (P-120 R-04's
   * floodplain/soil/electric-provider fact reads) read them from here rather
   * than re-resolving or requiring a second, caller-supplied override.
   */
  ringWgs84: ReadonlyArray<[number, number]>;
  centroid: { latitude: number; longitude: number };
}

export async function composeSitePlanModelForParcel(
  options: Omit<AuthorParcelSitePlanExportOptions, "artifactStore">,
): Promise<ComposeSitePlanModelForParcelResult> {
  const resolved = options.bboxOverride
    ? { bbox: options.bboxOverride, sourceRef: "request:bbox-override", ring: options.ringOverride }
    : await options.resolver.resolve(options.parcelNodeId);
  if (!resolved) {
    throw new Error(
      `Parcel geometry unavailable for ${options.parcelNodeId}; configure a spine resolver or supply bboxOverride+ringOverride for a test.`,
    );
  }
  const ringWgs84 = options.ringOverride ?? resolved.ring;
  if (!ringWgs84 || ringWgs84.length < 3) {
    throw new Error(
      `Parcel ${options.parcelNodeId} resolver returned no boundary ring; site-plan PROPERTY_LINE ` +
        "refuses to approximate a ring from the bbox rectangle. Wire a ring-capable resolver or supply ringOverride for a test.",
    );
  }

  const resolutionMetersRequested = options.resolutionMeters ?? DEFAULT_TERRAIN_RESOLUTION_METERS;
  // A parcel narrower than the adapter's per-axis pixel floor cannot be
  // fetched at its own bbox. Widen the DEM window rather than let the
  // adapter's (correct) fetch refusal kill the whole sheet — and with it the
  // Feasibility report, which requires a site plan. No-op for any parcel
  // already above the floor. See `terrain-window.ts` for the full rationale.
  const terrainWindow = resolveTerrainWindowBbox(resolved.bbox, resolutionMetersRequested);
  // One bbox for the DEM, the mesh, the contours and the local-ENU frame:
  // these four must agree, so the window is used for all of them or none.
  const terrainBbox = terrainWindow.bbox;
  const { resolutionMetersAdapted } = selectAdaptiveResolutionMeters(terrainBbox, resolutionMetersRequested);
  const contourIntervalMeters = options.contourIntervalMeters ?? 1;
  const fetchDem = options.fetchDem ?? fetchUsgs3depDem;
  const demFetch = await fetchDem(terrainBbox, {
    resolutionMeters: resolutionMetersAdapted,
    resolveActualResolution: true,
  });
  const dem = await (options.parseDem ?? parseDemBytes)(demFetch.bytes);
  const mesh = buildTerrainMeshGeometry(dem, terrainBbox);

  // Authoritative 1-ft contour tier where covered (Bastrop), else honest
  // 3DEP-derived fallback. Mesh Z (above) is untouched — 3DEP only.
  const contourSource = await resolveContourSource({
    dem,
    bbox: terrainBbox,
    contourIntervalMeters,
  });

  const zoning: ZoningSummaryInput =
    options.zoningOverride ?? (await resolveZoningSummary(options.parcelNodeId, options.storage));
  const centroid = centroidOfRing(ringWgs84);
  const floodZone: FloodZoneSummaryInput = options.floodZoneOverride ?? (await resolveFloodZoneSummary(centroid, options.fetchFloodZone));
  const envelopeOutcomeRaw: EnvelopeOutcomeInput | undefined =
    options.envelopeOutcomeOverride ?? (await resolveEnvelopeOutcome(options.parcelNodeId, options.storage));
  // P-248 — the mapped footprint layer, read once beside the envelope outcome.
  const footprints: SitePlanFootprintsInput =
    options.footprintsOverride ?? (await resolveFootprintLayer(options.parcelNodeId, options.storage));

  // Honest-absent path: NO setback-rule atom for this parcel. The export
  // still succeeds — the setback layer is drawn honest-absent (no F/S/R
  // fabricated) rather than refusing the whole sheet. `notSpecified` /
  // districtCode enrichment only applies when a rule actually exists.
  // F-11: a present placeholder or road-class rule is not a value and is
  // not absent-verified — treat as unusable for scalars, keep the atom.
  const setbackRuleVerdict = options.setback
    ? classifySetbackRuleAtom(options.setback)
    : null;
  /**
   * Whether the persisted ATOM alone is usable. P-219 keeps this as the
   * atom-level verdict (F-11: a placeholder or road-class rule is present but
   * is not a value) and no longer lets it decide the whole layer: a parcel
   * with no atom, or with an unusable one, can still have a ruled table, and
   * `resolveExportSetback` below is what decides honest absence now.
   */
  const setbackAtomUnusable =
    !options.setback || setbackRuleVerdict?.disposition !== "value";
  const setbackAtom = (
    setbackRuleVerdict?.disposition === "value" ? options.setback : undefined
  ) as
    | (SetbackRuleAtomInstance & {
        districtCode?: string;
        fieldProvenance?: unknown;
      })
    | undefined;

  // not_specified ≠ missing: enrich silent axes from fieldProvenance and/or
  // the B3 table so the sheet can label them honestly without refusing export.
  // Contract types may lag the runtime `notSpecified` flag written by emit-setback-rule.
  const districtCode =
    setbackAtom?.districtCode ??
    ("district" in zoning ? zoning.district : undefined);

  // P-219 — ONE setback authority for this export, resolved once, used by both
  // the per-edge geometry and the line the sheet prints. See
  // `resolve-export-setback.ts` for the precedence and for why the persisted
  // atom is no longer the first thing asked. `zoningOverride`/absence cases
  // fall through to this resolver's own honest-absence arm, so the export
  // still succeeds and still fabricates nothing.
  //
  // The record is read ONCE here and handed to every consumer below (the
  // setback authority and the R30 situs), so one export is one reader call
  // and the two can never read different snapshots of the same parcel.
  // A reader that is absent or fails yields null and every consumer degrades
  // on its own terms; a report never fails for want of it.
  let parcelRecord: ParcelRecordResponse | null = null;
  if (options.recordReader) {
    try {
      const read = await options.recordReader.fetchRecord(options.parcelNodeId);
      parcelRecord = read.ok ? read.record : null;
    } catch {
      parcelRecord = null;
    }
  }

  const exportSetback = await resolveExportSetback({
    parcelNodeId: options.parcelNodeId,
    districtCode: districtCode ?? null,
    jurisdictionKey: options.setbackJurisdictionKey ?? null,
    atom: setbackAtomUnusable ? null : (setbackAtom ?? null),
    record: parcelRecord,
  });

  /**
   * P-219 / D2 — mark the buildable-envelope atom stale when this export
   * followed setbacks the persisted setback-rule atom does not carry. The
   * envelope atom was derived from that atom, so its area figure describes an
   * envelope this sheet is no longer drawing; printing it beside the drawing
   * is the contradiction that put "19,052 sq ft of buildable area, 64% of the
   * 29,989 sq ft lot" in the largest type on a cover whose own site plan was
   * drawn to different setbacks. The POLYGON still draws (Ruling B, reversed
   * for the polygon only); only the figure is refused, and the sentence says
   * why rather than leaving a blank.
   */
  const envelopeOutcome: EnvelopeOutcomeInput | undefined =
    envelopeOutcomeRaw?.kind === "buildable" && exportSetback.supersededAtom
      ? {
          ...envelopeOutcomeRaw,
          supersededReason:
            "Buildable area withheld: the buildable-envelope atom on file was derived from setback values this study no longer follows " +
            `(${exportSetback.supersededAtom.axes.join(", ")}). Pending a re-baked envelope.`,
        }
      : envelopeOutcomeRaw;

  const tableAxes = exportSetback.honestAbsence
    ? undefined
    : notSpecifiedAxesFromSetbackTable(undefined, districtCode);
  const fieldProvenance = setbackAtom?.fieldProvenance as
    | {
        front?: { notSpecified?: boolean };
        side?: { notSpecified?: boolean };
        rear?: { notSpecified?: boolean };
      }
    | undefined;
  const notSpecified = exportSetback.honestAbsence
    ? undefined
    : (exportSetback.notSpecified ??
      resolveNotSpecifiedAxes({
        fieldProvenance,
        tableAxes,
      }));

  // Architecture directive (2026-07-28): the export CONSUMES the stored
  // boundary primitive when the parcel has one — same per-edge truth
  // depth-warm consumes. Loading failure or absence is NOT an error: the
  // composer applies the honest fallback (front-edge anchor or unresolved).
  let boundaryEdgeAtoms: ReadonlyArray<BoundaryEdgeAtomInstance> =
    options.boundaryEdgesOverride ?? [];
  if (!options.boundaryEdgesOverride) {
    try {
      boundaryEdgeAtoms = await options.storage.listBoundaryEdgesByParcelNodeId(
        options.parcelNodeId,
      );
    } catch {
      boundaryEdgeAtoms = [];
    }
  }

  // Track B1: STREET from attaching road-nodes (centerline + ROW edges).
  // Caller-supplied streetAnchors win; otherwise resolve from ledger. This
  // load also feeds the boundary-edge refresh below (R28 recompute / R30
  // relabel need the SAME attaching roads the export uses for STREET, not a
  // second lookup) whenever there is a stored primitive to refresh.
  let streetAnchors = options.streetAnchors;
  let attachingRoadAtoms: ReadonlyArray<RoadNodeAtomInstance> = [];
  const needStreetAnchors = (!streetAnchors || streetAnchors.length === 0);
  if (
    (needStreetAnchors || boundaryEdgeAtoms.length > 0) &&
    options.resolveStreetFromRoadNodes !== false
  ) {
    const resolvedRoads = await resolveAttachingRoadNodes({
      parcelNodeId: options.parcelNodeId,
      ringWgs84,
      storage: options.storage,
    });
    attachingRoadAtoms = resolvedRoads.roads;
    if (needStreetAnchors) {
      streetAnchors = resolvedRoads.streetAnchors;
    }
  }

  // 2026-08-05 edge-role defect fix: mirror the cert-grade path's R28
  // (ring-winding recompute) + R30 (fresh-road relabel) freshness gates, plus
  // a stale per-edge setback-VALUE refresh, before mapping stored edges by
  // edgeIndex. See `prepare-boundary-edges-for-export.ts` for the full
  // rationale (2026-07-29 descriptor-fixture regression: stale 15/0/0 served
  // instead of the card's F25/S5/R25).
  let refreshedBoundaryEdgeAtoms: ReadonlyArray<BoundaryEdgeAtomInstance> = boundaryEdgeAtoms;
  if (boundaryEdgeAtoms.length > 0) {
    const warmRoads = attachingRoadAtoms
      .map((r) => roadAtomToWarmSource(r))
      .filter((r): r is WarmRoadSource => r !== null);
    const situsAddress = await resolveSitusAddressForExport({
      parcelNodeId: options.parcelNodeId,
      descriptorAddress: options.descriptor?.address,
    });
    const prepared = await prepareBoundaryEdgesForExport({
      parcelNodeId: options.parcelNodeId,
      storedEdges: boundaryEdgeAtoms,
      ringWgs84,
      roads: warmRoads,
      situsAddress,
      setback: exportSetback.honestAbsence
        ? null
        : {
            front: exportSetback.front,
            side: exportSetback.side,
            rear: exportSetback.rear,
            cornerFt: exportSetback.cornerFt,
            provenance: exportSetback.provenanceKind,
            sourceCodeAtomDid: exportSetback.sourceCodeAtomDid,
            districtCode: exportSetback.districtCode,
          },
      notSpecified,
    });
    refreshedBoundaryEdgeAtoms = prepared.edges ?? [];
  }
  const boundaryEdges =
    refreshedBoundaryEdgeAtoms.length > 0
      ? boundaryEdgesToGeometryInput(refreshedBoundaryEdgeAtoms)
      : undefined;

  const model = composeSitePlanModel({
    parcelNodeId: options.parcelNodeId,
    // Same window the DEM/mesh/contours used: this bbox is the local-ENU
    // frame anchor, so a mismatch here would misregister the whole drawing.
    bbox: terrainBbox,
    ringWgs84,
    dem,
    contourIntervalMeters,
    // P-219 — the sheet's line and the per-edge geometry above now read the
    // SAME resolved authority, so the two can no longer disagree (they did:
    // the edges were correct in the ledger and the sheet printed the atom).
    setback: exportSetback.honestAbsence
      ? {
          // Nothing resolvable: zero inset on every axis (offset ring ==
          // property line, nothing fabricated), flagged honest-absent for the
          // legend.
          front: 0,
          side: 0,
          rear: 0,
          cornerFt: null,
          sourceCodeAtomRef: {
            atomDid: "no-setback-rule-atom",
            role: "honest-absence",
            entityType: "setback-rule",
          },
          honestAbsence: true,
          honestAbsenceReason:
            exportSetback.honestAbsenceReason ??
            (setbackRuleVerdict && setbackRuleVerdict.disposition !== "value"
              ? setbackRuleVerdict.basis
              : undefined),
        }
      : {
          front: exportSetback.front,
          side: exportSetback.side,
          rear: exportSetback.rear,
          cornerFt: exportSetback.cornerFt,
          sourceCodeAtomRef: {
            atomDid: exportSetback.sourceCodeAtomDid,
            role: "rule",
            entityType: "code-section",
          },
          notSpecified,
          // P-154 wave 6 (R-1) — what the sheet's setback line cites, and the
          // conflict row when two dated sources disagree. These now travel
          // with the resolved authority rather than off the persisted atom, so
          // a sheet cannot print one source's numbers under another source's
          // citation.
          sourceLabel: exportSetback.sourceLabel,
          sourceCitation: exportSetback.sourceCitation,
          sourceDate: exportSetback.sourceDate,
          dateBasis: exportSetback.dateBasis,
          conflict: exportSetback.conflict ?? null,
        },
    boundaryEdges,
    frontEdgeIndex: options.frontEdgeIndex,
    streetAnchors,
    geometrySourceRef: resolved.sourceRef,
    demSourceCitation: TERRAIN_VERTICAL_DATUM.source,
    contourOverride: contourSource.polylines,
    contourSourceCitation:
      contourSource.provenance.tier === "authoritative-1ft"
        ? `${contourSource.provenance.source} (${contourSource.provenance.vintage}, ${contourSource.provenance.intervalLabel})`
        : TERRAIN_VERTICAL_DATUM.source,
    descriptor: options.descriptor,
    zoning,
    floodZone,
    envelopeOutcome,
    footprints,
  });

  return {
    model,
    mesh,
    dem,
    demFetch,
    resolvedSourceRef: resolved.sourceRef,
    contourSource,
    setbackHonestAbsence: exportSetback.honestAbsence,
    zoning,
    floodZone,
    resolutionMetersRequested,
    resolutionMetersAdapted,
    contourIntervalMeters,
    terrainWindowExpanded: terrainWindow.expanded,
    ...(terrainWindow.reason ? { terrainWindowReason: terrainWindow.reason } : {}),
    ringWgs84,
    centroid,
  };
}

/**
 * Authors dxf-site-plan / ifc-site-plan artifacts and merges them additively
 * into the parcel's `parcel-terrain-model` atom (creating one if absent).
 * This intentionally does not touch the existing glb/ifc/dxf-3dface/
 * dxf-contour artifacts — Wave 1 extends the terrain-export path, it does
 * not replace it.
 */
export async function authorParcelSitePlanExport(
  options: AuthorParcelSitePlanExportOptions,
): Promise<AuthorParcelSitePlanExportResult> {
  const composed = await composeSitePlanModelForParcel(options);
  const {
    model,
    mesh,
    dem,
    demFetch,
    contourSource,
    setbackHonestAbsence,
    zoning,
    floodZone,
    resolutionMetersRequested,
    resolutionMetersAdapted,
    contourIntervalMeters,
  } = composed;

  const solidMassOptions: BuildTerrainSolidMassOptions = {
    skirtDepthFeet: options.skirtDepthFeet ?? DEFAULT_SKIRT_DEPTH_FEET,
  };

  const dxf = await emitDxfSitePlan(model, mesh);
  const ifc = await emitIfcSitePlan(model, mesh, "USGS 3DEP", solidMassOptions);
  if (ifc.status !== "ok" || !ifc.ifcText) {
    throw new Error(`IFC site-plan emission failed: ${ifc.message ?? "unknown worker error"}`);
  }
  if (!ifc.spatialValidation?.ok) {
    throw new Error(
      `IFC site-plan spatial model incomplete: ${
        (ifc.spatialValidation as { errors?: string[] } | undefined)?.errors?.join("; ") ?? "validation missing"
      }`,
    );
  }

  const existing = (await options.storage.listPropertyAtomsByParcelNodeId(options.parcelNodeId)).find(
    (candidate): candidate is ParcelTerrainModelAtomInstance => candidate.entityType === "parcel-terrain-model",
  );
  const fetchedAt = new Date().toISOString();
  const atom: ParcelTerrainModelAtomInstance = existing ?? {
    entityType: "parcel-terrain-model",
    atomDid: `pterrain_siteplan_${options.parcelNodeId.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.parse(fetchedAt)}`,
    entityId: options.parcelNodeId,
    parcelNodeId: options.parcelNodeId,
    jurisdictionTenant: "property-spine",
    fetchedAt,
    extractedAt: fetchedAt,
    sourceAdapter: "usgs:3dep-dem",
    sourceUrl: demFetch.endpoint,
    sourceCitation: "USGS 3DEP",
    accessPolicy: "public-paid",
    atomTier: "data",
    status: "active",
    contentHash: "",
    reasoningChain: {
      reasoningKind: "derived",
      derivationMethod: "parcel-terrain-mesh-ifc-v1",
      inputAtomRefs: [{ atomDid: composed.resolvedSourceRef, role: "reference-field", citationLabel: "usgs-3dep-dem" }],
    },
    artifacts: {},
    coverage: {
      coverageFraction: 1 - dem.nodataCount / (dem.width * dem.height),
      nodataCount: dem.nodataCount,
      totalCells: dem.width * dem.height,
      resolutionMetersRequested,
      resolutionMetersActual: demFetch.resolutionMetersActual,
      resolutionMetersAdapted,
      touchesNodata: dem.nodataCount > 0,
      // Declared, not silent: this parcel was below the DEM pixel floor and
      // its terrain came from a widened window.
      ...(composed.terrainWindowExpanded
        ? {
            terrainWindowExpanded: true,
            terrainWindowReason: composed.terrainWindowReason,
          }
        : {}),
      contourSource: {
        tier: contourSource.provenance.tier,
        source: contourSource.provenance.source,
        vintage: contourSource.provenance.vintage,
        intervalLabel: contourSource.provenance.intervalLabel,
        polylineCount: contourSource.provenance.polylineCount,
        ...(contourSource.provenance.fallbackReason
          ? { fallbackReason: contourSource.provenance.fallbackReason }
          : {}),
      },
    },
    confidence: {
      value: 0.6,
      kind: "asserted",
      provenance: `USGS 3DEP DEM field; Z=${TERRAIN_VERTICAL_DATUM.summary}; calibration pending`,
      n: 0,
      intervalWidth: 1,
    },
  };

  // When merging into an EXISTING terrain atom, refresh the contour-tier
  // provenance so the atom reflects the source actually drawn this run.
  atom.coverage.contourSource = {
    tier: contourSource.provenance.tier,
    source: contourSource.provenance.source,
    vintage: contourSource.provenance.vintage,
    intervalLabel: contourSource.provenance.intervalLabel,
    polylineCount: contourSource.provenance.polylineCount,
    ...(contourSource.provenance.fallbackReason
      ? { fallbackReason: contourSource.provenance.fallbackReason }
      : {}),
  };

  const dxfRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "dxf-site-plan",
    bytes: dxf.bytes,
    contentType: "application/dxf",
  });
  const ifcBytes = new TextEncoder().encode(ifc.ifcText);
  const ifcRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "ifc-site-plan",
    bytes: ifcBytes,
    contentType: "application/step",
  });

  const pdf = await emitPdfSitePlan(model, {
    aerial: { fetchImage: options.fetchAerialImage },
  });
  const pdfRef = await options.artifactStore.put({
    parcelNodeId: options.parcelNodeId,
    format: "pdf-site-plan",
    bytes: pdf.bytes,
    contentType: "application/pdf",
  });

  const zoningHonestAbsence = "honestAbsence" in zoning;
  const floodZoneHonestUnavailable = "honestUnavailable" in floodZone;

  atom.artifacts["dxf-site-plan"] = {
    format: "dxf-site-plan",
    ref: dxfRef,
    byteCount: dxf.bytes.byteLength,
    contourIntervalMeters,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
  };
  atom.artifacts["ifc-site-plan"] = {
    format: "ifc-site-plan",
    ref: ifcRef,
    byteCount: ifcBytes.byteLength,
    vertexCount: ifc.vertexCount,
    triangleCount: ifc.triangleCount,
    annotationCount: ifc.annotationCount,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
  };
  atom.artifacts["pdf-site-plan"] = {
    format: "pdf-site-plan",
    ref: pdfRef,
    byteCount: pdf.bytes.byteLength,
    pageCount: pdf.pageCount,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
    aerialImageryEmbedded: pdf.aerial.imageryEmbedded,
    ...(pdf.aerial.unavailableReason
      ? { aerialImageryUnavailableReason: pdf.aerial.unavailableReason }
      : {}),
  };

  await options.storage.writePropertyAtom(atom);

  return {
    atom,
    setbackDegenerate: model.setback.degenerate,
    setbackDegenerateReason: model.setback.degenerateReason,
    setbackHonestAbsence,
    setbackHonestAbsenceReason: model.setback.honestAbsenceReason,
    streetHonestAbsence: model.streets.honestAbsence,
    zoningHonestAbsence,
    floodZoneHonestUnavailable,
    pdfPageCount: pdf.pageCount,
  };
}
