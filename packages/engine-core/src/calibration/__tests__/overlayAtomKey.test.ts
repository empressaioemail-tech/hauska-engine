import { describe, expect, it } from "vitest";
import {
  canonicalOverlayAtomKey,
  canonicalOverlayKeyFromCodeToken,
  isReasoningOverlayAtomId,
  overlayAtomLookupKey,
} from "../overlayAtomKey.js";

const CORPUS_UUID = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const CORPUS_UUID_LOWER = CORPUS_UUID.toLowerCase();

describe("canonicalOverlayAtomKey", () => {
  it("lowercases corpus UUIDs and collapses DID form", () => {
    const did = `did:hauska:code-section:${CORPUS_UUID}`;
    expect(canonicalOverlayAtomKey(CORPUS_UUID)).toBe(CORPUS_UUID_LOWER);
    expect(canonicalOverlayAtomKey(did)).toBe(CORPUS_UUID_LOWER);
    expect(canonicalOverlayAtomKey(CORPUS_UUID_LOWER)).toBe(CORPUS_UUID_LOWER);
  });

  it("passes reasoning ids through unchanged", () => {
    const reasoningId = "reasoning:fbc-2023:fbc-m601-6";
    expect(canonicalOverlayAtomKey(reasoningId)).toBe(reasoningId);
    expect(canonicalOverlayAtomKey(reasoningId)).not.toBe(CORPUS_UUID_LOWER);
  });

  it("builds overlay lookup keys", () => {
    const fromUuid = overlayAtomLookupKey({
      jurisdictionTenant: "bastrop_tx",
      atomId: CORPUS_UUID,
    });
    const fromDid = overlayAtomLookupKey({
      jurisdictionTenant: "bastrop_tx",
      atomId: `did:hauska:code-section:${CORPUS_UUID}`,
    });
    expect(fromUuid).toBe(fromDid);
    expect(fromUuid).toContain(CORPUS_UUID_LOWER);
  });
});

describe("isReasoningOverlayAtomId", () => {
  it("detects reasoning and websearch prefixes", () => {
    expect(isReasoningOverlayAtomId("reasoning:fbc-2023:sec")).toBe(true);
    expect(isReasoningOverlayAtomId("websearch:up.codes:sec")).toBe(true);
    expect(isReasoningOverlayAtomId(CORPUS_UUID_LOWER)).toBe(false);
  });
});

describe("canonicalOverlayKeyFromCodeToken", () => {
  it("parses [[CODE:…]] tokens", () => {
    expect(
      canonicalOverlayKeyFromCodeToken(
        "[[CODE:reasoning:fbc-2023:fbc-m601-6]]",
      ),
    ).toBe("reasoning:fbc-2023:fbc-m601-6");
  });
});
