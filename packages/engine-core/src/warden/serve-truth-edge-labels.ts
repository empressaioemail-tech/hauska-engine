/**
 * Warden check 6 — serveTruthEdgeLabels (files-never-fixes: READ ONLY).
 *
 * Compares cert-path fresh labelEdgesFromRoads roles at each edgeIndex vs
 * export-served roles after prepareBoundaryEdgesForExport. Catches the
 * cert-vs-serve gap when promote did not persist warm-time boundary edges.
 */
import type { BoundaryEdgeAtomInstance, SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import { labelEdgesFromRoads } from "../depth-warm/edgeLabeling.js";
import type { Ring } from "../depth-warm/geometry.js";
import type { WarmRoadSource } from "../depth-warm/types.js";
import { prepareBoundaryEdgesForExport } from "../site-plan/prepare-boundary-edges-for-export.js";
import type { WardenFindingEvent } from "./types.js";

export interface ServeTruthEdgeLabelsParcelInput {
  readonly parcelNodeId: string;
  readonly parcelRing: Ring | null;
  readonly situsAddress?: string | null;
  readonly storedEdges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  readonly setbackRule: (SetbackRuleAtomInstance & { sourceCodeAtomRef?: { atomDid?: string } }) | null;
  readonly envelopeBody: Record<string, unknown> | null;
  readonly roads: ReadonlyArray<WarmRoadSource>;
}

export interface ServeTruthEdgeLabelsOptions {
  readonly sweepId: string;
  readonly fips: string;
  readonly rowId: string;
  readonly now: () => Date;
  readonly parcels: ReadonlyArray<ServeTruthEdgeLabelsParcelInput>;
}

function isPromotedEnvelope(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  if (body.depthWarmPromotion === "depth-warm-promoted-v1") return true;
  if (body.sourceAdapter === "depth-warm-verify-promote") return true;
  if (body.warmVerifyDecline) return false;
  const outcome = body.outcome as { kind?: string } | undefined;
  return outcome?.kind === "buildable";
}

function roleMismatches(
  certEdges: ReadonlyArray<{ index: number; label: string }>,
  servedByIndex: Map<number, string>,
): Array<{ edgeIndex: number; certRole: string; servedRole: string | null }> {
  const out: Array<{ edgeIndex: number; certRole: string; servedRole: string | null }> = [];
  for (const e of certEdges) {
    const served = servedByIndex.get(e.index) ?? null;
    if (served !== e.label) {
      out.push({ edgeIndex: e.index, certRole: e.label, servedRole: served });
    }
  }
  return out;
}

/** Exported for unit tests — cert vs served edgeIndex role diff. */
export function certVsServedEdgeMismatches(
  certEdges: ReadonlyArray<{ index: number; label: string }>,
  servedEdges: ReadonlyArray<{ edgeIndex: number; role: string }>,
): ReturnType<typeof roleMismatches> {
  const servedByIndex = new Map(servedEdges.map((e) => [e.edgeIndex, e.role]));
  return roleMismatches(certEdges, servedByIndex);
}

export async function classifyServeTruthEdgeLabels(
  options: ServeTruthEdgeLabelsOptions,
): Promise<WardenFindingEvent[]> {
  const findings: WardenFindingEvent[] = [];
  const ts = options.now().toISOString();
  const artifactRef = `warden-sweep:${options.sweepId}:serveTruthEdgeLabels`;

  for (const parcel of options.parcels) {
    if (!isPromotedEnvelope(parcel.envelopeBody)) continue;
    if (!parcel.parcelRing || parcel.storedEdges.length === 0) continue;

    const cert = labelEdgesFromRoads({
      parcelRing: parcel.parcelRing,
      roads: parcel.roads,
      situsAddress: parcel.situsAddress ?? null,
    });
    if (!cert.ok) continue;

    const served = await prepareBoundaryEdgesForExport({
      parcelNodeId: parcel.parcelNodeId,
      storedEdges: parcel.storedEdges,
      ringWgs84: parcel.parcelRing,
      roads: parcel.roads,
      situsAddress: parcel.situsAddress ?? null,
      setback: parcel.setbackRule,
    });
    if (!served.edges?.length) continue;

    const servedByIndex = new Map(served.edges.map((e) => [e.edgeIndex, e.role]));
    const mismatches = roleMismatches(cert.edgeLabels, servedByIndex);
    if (mismatches.length === 0) continue;

    const certFront = cert.edgeLabels.find((e) => e.label === "front")?.index ?? null;
    const servedFront =
      [...servedByIndex.entries()].find(([, role]) => role === "front")?.[0] ?? null;

    findings.push({
      ts,
      sweepId: options.sweepId,
      rowId: options.rowId,
      fips: options.fips,
      parcelNodeId: parcel.parcelNodeId,
      checkId: "serveTruthEdgeLabels",
      defectClass: "CERT-VS-SERVE-EDGE-MISMATCH",
      severity: "flag",
      artifactRef,
      evidence: {
        mismatches,
        certFrontEdgeIndex: certFront,
        servedFrontEdgeIndex: servedFront,
        relabeledFromRoads: served.relabeledFromRoads,
        recomputedForRingWinding: served.recomputedForRingWinding,
      },
    });
  }

  return findings;
}
