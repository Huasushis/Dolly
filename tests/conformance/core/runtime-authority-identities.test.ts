/**
 * Conformance drive for the runtime-authority identity module.
 *
 * The Runtime identity tuple that the authority database persists
 * (`security-operations.md` Section 13 and the frozen `runtime-authority`
 * storage contract) is `{ daemonInstallationId, instanceId }`. This module is
 * the only sanctioned producer of both halves:
 *
 * - `daemonInstallationId` / `controllerGenerationId` are strict RFC 9562
 *   lowercase UUIDv7 whose timestamp and random bits come from injected
 *   sources, so deterministic tests observe exact bit layout, version,
 *   variant, and strict rejection of every non-conforming string (uppercase,
 *   truncated, wrong version/variant, embedded garbage).
 * - the Runtime `instanceId` is a deterministic StableId projection of the
 *   state-manifest/registry UUIDv4 (`instance-` + 32 lowercase hex, hyphens
 *   removed). It is derived, never hashed and never an integer conversion, so
 *   two runs over the same UUIDv4 always produce the same StableId and the
 *   registry UUIDv4 stays the durable source of truth.
 */
import { describe, expect, it } from "vitest";
import {
  generateRuntimeUuidV7,
  isLowercaseUuidV7,
  isRuntimeInstanceStableId,
  projectRuntimeInstanceStableId,
  RuntimeAuthorityIdentityError,
} from "../../../src/core/runtime-authority-identities.js";

const FIXED_NOW_MS = Date.parse("2026-08-22T10:00:00.000Z");
const deterministicBytes = (fill: number): Uint8Array | Buffer =>
  Uint8Array.from({ length: 16 }, () => fill);
const fixedClock = (): number => FIXED_NOW_MS;
const fixedRandom = (size: number): Uint8Array | Buffer =>
  deterministicBytes(0xab).slice(0, size) as Uint8Array;

describe("runtime authority identities: RFC9562 lowercase UUIDv7", () => {
  it("mints a lowercase UUIDv7 with the correct version and variant bits", () => {
    const id = generateRuntimeUuidV7({ now: fixedClock, randomBytes: fixedRandom });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(id).toBe(id.toLowerCase());
    expect(isLowercaseUuidV7(id)).toBe(true);
  });

  it("lays the 48-bit unix-ms timestamp into the first six octets", () => {
    const id = generateRuntimeUuidV7({ now: fixedClock, randomBytes: fixedRandom });
    const hex = id.replaceAll("-", "");
    expect(hex.slice(0, 12)).toBe(FIXED_NOW_MS.toString(16).padStart(12, "0"));
  });

  it("replaces the version and variant nibbles over injected random bytes", () => {
    // Every random byte 0xff would otherwise produce version f and non-variant.
    const id = generateRuntimeUuidV7({
      now: fixedClock,
      randomBytes: (size) => deterministicBytes(0xff).slice(0, size) as Uint8Array,
    });
    expect(isLowercaseUuidV7(id)).toBe(true);
    const hex = id.replaceAll("-", "");
    expect(hex.slice(12, 13)).toBe("7");
    expect("89ab".includes(hex.slice(16, 17))).toBe(true);
  });

  it("rejects uppercase, wrong-version, wrong-variant, truncated and embedded strings", () => {
    const seed = generateRuntimeUuidV7({ now: fixedClock, randomBytes: fixedRandom });
    const upper = seed.toUpperCase();
    // char 14 is the version nibble; char 19 the variant nibble in `xxxxxxxx-xxxx-xXXX-XXxx-...`.
    const wrongVersion = `${seed.slice(0, 14)}1${seed.slice(15)}`;
    const wrongVariant = `${seed.slice(0, 19)}0${seed.slice(20)}`;
    const v4 = "11111111-1111-4111-8111-111111111111";
    const v1 = "d6a4e2ee-a9f0-11ef-9cd2-0242ac120002";
    expect(isLowercaseUuidV7(v4)).toBe(false);
    expect(isLowercaseUuidV7(v1)).toBe(false);
    expect(isLowercaseUuidV7(upper)).toBe(false);
    expect(isLowercaseUuidV7(wrongVersion)).toBe(false);
    expect(isLowercaseUuidV7(wrongVariant)).toBe(false);
    expect(isLowercaseUuidV7("")).toBe(false);
    expect(isLowercaseUuidV7(seed.slice(0, 20))).toBe(false);
    expect(isLowercaseUuidV7(`x-${seed}`)).toBe(false);
    expect(isLowercaseUuidV7(null as unknown as string)).toBe(false);
    expect(isLowercaseUuidV7({} as unknown as string)).toBe(false);
  });

  it("stamps the injected instant even when the clock moves backwards", () => {
    // A backward clock is caller-visible; the mint must not clamp or reorder.
    const t0 = FIXED_NOW_MS;
    const t1 = FIXED_NOW_MS - 5_000;
    const first = generateRuntimeUuidV7({ now: () => t0, randomBytes: fixedRandom });
    const second = generateRuntimeUuidV7({ now: () => t1, randomBytes: fixedRandom });
    const firstTime = first.replaceAll("-", "").slice(0, 12);
    const secondTime = second.replaceAll("-", "").slice(0, 12);
    expect(parseInt(secondTime, 16)).toBe(parseInt(firstTime, 16) - 5_000);
  });

  it("is deterministic under identical injected inputs and differs when they differ", () => {
    const first = generateRuntimeUuidV7({ now: fixedClock, randomBytes: fixedRandom });
    const same = generateRuntimeUuidV7({ now: fixedClock, randomBytes: fixedRandom });
    expect(isLowercaseUuidV7(first)).toBe(true);
    expect(same).toBe(first);
    const otherRandom = generateRuntimeUuidV7({
      now: fixedClock,
      randomBytes: (size) => deterministicBytes(0xcd).slice(0, size) as Uint8Array,
    });
    expect(otherRandom).not.toBe(first);
  });
});

describe("runtime authority identities: deterministic instance StableId", () => {
  const V4 = "2f5a1a1a-8f0e-4b2a-9a9a-1a2b3c4d5e6f";
  const STABLE = "2f5a1a1a-8f0e-4b2a-9a9a-1a2b3c4d5e6f".replaceAll("-", "");

  it("projects a lowercase UUIDv4 to instance-<32 lowercase hex> without hashing", () => {
    expect(projectRuntimeInstanceStableId(V4)).toBe(`instance-${STABLE}`);
    expect(isRuntimeInstanceStableId(`instance-${STABLE}`)).toBe(true);
    expect(isRuntimeInstanceStableId(STABLE)).toBe(false); // prefix is required
    expect(isRuntimeInstanceStableId(`instance-${STABLE.toUpperCase()}`)).toBe(false);
  });

  it("is deterministic and the projected hex half is hyphen-free across repeated calls", () => {
    expect(projectRuntimeInstanceStableId(V4)).toBe(projectRuntimeInstanceStableId(V4));
    expect(projectRuntimeInstanceStableId(V4).length).toBe(9 + STABLE.length);
    expect(projectRuntimeInstanceStableId(V4).slice("instance-".length)).not.toContain("-");
  });

  it("rejects non-UUIDv4 input for the projection", () => {
    expect(() => projectRuntimeInstanceStableId("not-a-uuid")).toThrowError(
      RuntimeAuthorityIdentityError,
    );
    expect(() => projectRuntimeInstanceStableId(V4.toUpperCase())).toThrowError(
      RuntimeAuthorityIdentityError,
    );
    expect(() => projectRuntimeInstanceStableId("")).toThrowError(RuntimeAuthorityIdentityError);
    expect(() =>
      projectRuntimeInstanceStableId("11111111-1111-7111-8111-111111111111"),
    ).toThrowError(RuntimeAuthorityIdentityError);
  });
});
