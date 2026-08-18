// bff-flow.ts
//
// The BFF half of the serving path: what
// `GET /api/spine/property-atoms/:parcelNodeId/facets` puts on the wire.
//
// Reproduces the decision tree of `handlePropertyAtomsFacets` in
// `hauska-map@d3510a6:apps/property-explorer/api/_lib/pe-property-atoms.ts`.
// That file is not vendored because it imports `@vercel/node` request/response
// types that do not resolve here; the two PURE helpers it contributes are
// copied verbatim below with their origin lines named.
//
// PRODUCTION MODE IS VERIFIED, NOT ASSUMED. `PROPERTY_ATOM_PATH=1` was
// confirmed against the deployed surface on 2026-08-18 by reading the
// `X-PE-Read-Path` response header, which returned `atom-chain-warm` for
// 48021:36521 and 48021:34137. The cortex-only branch is reproduced anyway so
// a rollback can be swept without a code change.
//
// THE TRANSPORT BRANCHES ARE OUT OF SCOPE AND SAY SO. The live handler has
// three failure branches that only a network can produce: HTTP 401 from
// retrieval (`isRetrievalAuthFailure`), a transient upstream failure
// (`isTransientAtomChainReason`), and a JSON parse failure. An offline sweep
// cannot reach any of them, so it never emits `unresolved` from this file. It
// emits `unresolved` only from the DB read itself. A sweep that reported zero
// `unresolved` because it could not fail is not evidence that the live path
// does not fail, and this comment is here so nobody reads it as such.

import {
  adaptAtomChainToBakedFacets,
  atomChainIsUsable,
  mergeBakedBaseFacts,
  type PeBakedFacetsResponse,
  type PropertyAtomChain,
} from "./vendor/atom-chain-to-facets.js";

/**
 * VERBATIM from `pe-property-atoms.ts#stripCortexEnvelopeProductTruth`.
 * Applied on the cortex-only path (flag off) and on the definitive-empty
 * atom-chain path.
 */
export function stripCortexEnvelopeProductTruth(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const root = body as Record<string, unknown>;
  const facets =
    root.facets && typeof root.facets === "object"
      ? {
          ...(root.facets as Record<string, unknown>),
          envelope: {
            status: "declined",
            declineReason: "atom_path_pending",
            approximate: true,
            provisional: true,
            disclosure:
              "Envelope product path is the property atom chain. Cortex multiply path retired (anti-zombie).",
          },
          facetCoverage: {
            ...((root.facets as Record<string, unknown>).facetCoverage as
              | Record<string, unknown>
              | undefined),
            envelope: false,
          },
        }
      : root.facets;
  const tier2 =
    root.tier2 && typeof root.tier2 === "object"
      ? { ...(root.tier2 as Record<string, unknown>), envelope: null }
      : root.tier2;
  return { ...root, facets, tier2, cortexEnvelopeRetired: true };
}

/** VERBATIM from `pe-property-atoms.ts#honestAtomPendingResponse`. */
export function honestAtomPendingResponse(
  parcelNodeId: string,
): PeBakedFacetsResponse {
  const fips = parcelNodeId.split(":")[0];
  const apn = parcelNodeId.split(":")[1];
  return {
    parcelNodeId,
    adapterKey: "property-atom-chain",
    source: "atom-chain",
    snapshotAt: null,
    readPath: "atom-chain",
    facets: {
      parcelNodeId,
      countyFips: fips && /^\d{5}$/.test(fips) ? fips : undefined,
      baseFacts: apn
        ? { apn, landUse: null, acreage: null, situsAddress: null }
        : undefined,
      zoning: null,
      envelope: {
        status: "declined",
        declineReason: "atom_path_pending",
        approximate: true,
        provisional: true,
        disclosure:
          "No property atom chain for this parcel yet — honest decline (not invented).",
      },
      facetCoverage: {
        baseFacts: !!apn,
        landUse: false,
        acreage: false,
        zoning: false,
        envelope: false,
      },
      provenance: {
        parcelSource: "property-atom-chain",
        parcelVintage: null,
        landUseSource: null,
        landUseGateBlocked: false,
      },
    },
  };
}

/** The cortex baked read, as the BFF sees it after `loadBakedNodeFacetSnapshot`. */
export interface CortexFacetsBody {
  parcelNodeId: string;
  adapterKey: string;
  source: "baked-snapshot";
  snapshotAt: string | null;
  facets: Record<string, unknown>;
  tier2: Record<string, unknown> | null;
}

export type ServedReadPath =
  | "atom-chain"
  | "atom-chain-warm"
  | "atom-pending"
  | "cortex";

export interface ServedResponse {
  readPath: ServedReadPath;
  /** The full wire body the browser receives. */
  body: Record<string, unknown>;
}

/**
 * Compose the served wire body for one parcel.
 *
 * The one finding worth naming at the seam: on the atom-chain branch the
 * handler returns `mergeBakedBaseFacts(adapted, cortexBody)`, and
 * `mergeBakedBaseFacts` builds its result from `{...atomResponse, ...}`. The
 * atom response has no `tier2` key and the merge never adds one, so the
 * cortex `tier2.flood` overlay — the only FEMA determination on this endpoint —
 * is DROPPED from the wire for every parcel whose atom chain is usable. The
 * sweep does not compensate for that. It measures it.
 */
export function composeServedResponse(input: {
  parcelNodeId: string;
  chain: PropertyAtomChain | null;
  cortex: CortexFacetsBody | null;
  propertyAtomPath: boolean;
}): ServedResponse {
  const { parcelNodeId, chain, cortex, propertyAtomPath } = input;

  if (!propertyAtomPath) {
    if (!cortex) {
      return {
        readPath: "cortex",
        body: { notFound: true, parcelNodeId },
      };
    }
    return {
      readPath: "cortex",
      body: stripCortexEnvelopeProductTruth(cortex) as Record<string, unknown>,
    };
  }

  if (atomChainIsUsable(chain)) {
    const adapted = adaptAtomChainToBakedFacets(chain);
    if (adapted) {
      const payload = cortex
        ? mergeBakedBaseFacts(adapted, cortex)
        : adapted;
      return {
        readPath:
          adapted.readPath === "atom-chain-warm" ? "atom-chain-warm" : "atom-chain",
        body: payload as unknown as Record<string, unknown>,
      };
    }
  }

  if (cortex) {
    const stripped = stripCortexEnvelopeProductTruth(cortex) as Record<
      string,
      unknown
    >;
    return {
      readPath: "atom-pending",
      body: { ...stripped, atomPathReason: chain ? "adapt-failed" : "atom-chain empty" },
    };
  }

  return {
    readPath: "atom-pending",
    body: {
      ...(honestAtomPendingResponse(parcelNodeId) as unknown as Record<
        string,
        unknown
      >),
      atomPathReason: "atom-chain empty",
    },
  };
}
