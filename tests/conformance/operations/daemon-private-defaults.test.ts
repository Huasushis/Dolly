import { describe, expect, it } from "vitest";
import {
  NetworkExposureError,
  NetworkExposurePolicy,
  type NetworkRequestMetadata,
} from "../../../src/core/network-exposure.js";

function localRequest(
  overrides: Partial<NetworkRequestMetadata> = {},
): NetworkRequestMetadata {
  return {
    peerAddress: "127.0.0.1",
    encrypted: false,
    host: "127.0.0.1:9800",
    origin: "http://127.0.0.1:9800",
    ...overrides,
  };
}

function proxyRequest(
  overrides: Partial<NetworkRequestMetadata> = {},
): NetworkRequestMetadata {
  return {
    peerAddress: "127.0.0.2",
    encrypted: false,
    host: "127.0.0.1:9800",
    origin: "https://admin.example.test",
    forwarded: "for=203.0.113.7;proto=https;host=admin.example.test",
    ...overrides,
  };
}

describe("OPS-002 private-by-default daemon exposure", () => {
  it("defaults local mode to an exact IPv4 loopback listener and same origin", () => {
    const policy = new NetworkExposurePolicy({ mode: "local", listenPort: 9800 });
    expect(policy.listenAddress).toEqual({ host: "127.0.0.1", port: 9800 });
    expect(policy.validateRequest(localRequest(), { requireOrigin: true })).toEqual({
      mode: "local",
      effectiveOrigin: "http://127.0.0.1:9800",
      clientAddress: "127.0.0.1",
      peerAddress: "127.0.0.1",
      viaTrustedProxy: false,
    });
  });

  it("binds a port-zero policy to the kernel-selected port before accepting requests", () => {
    const unbound = new NetworkExposurePolicy({ mode: "local", listenPort: 0 });
    expect(() =>
      unbound.validateRequest(localRequest(), { requireOrigin: true }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_CONFIG_INVALID" }));
    const bound = unbound.withBoundPort(9800);
    expect(bound.listenAddress).toEqual({ host: "127.0.0.1", port: 9800 });
    expect(bound.validateRequest(localRequest(), { requireOrigin: true })).toMatchObject({
      effectiveOrigin: "http://127.0.0.1:9800",
    });
  });

  it("rejects DNS-rebinding Hosts, non-loopback peers, and every forwarding header locally", () => {
    const policy = new NetworkExposurePolicy({ mode: "local", listenPort: 9800 });
    expect(() =>
      policy.validateRequest(localRequest({ host: "localhost:9800" }), {
        requireOrigin: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_HOST_DENIED" }));
    expect(() =>
      policy.validateRequest(localRequest({ peerAddress: "192.168.1.8" }), {
        requireOrigin: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_PEER_DENIED" }));
    expect(() =>
      policy.validateRequest(localRequest({ forwarded: "for=127.0.0.1;proto=http;host=127.0.0.1:9800" }), {
        requireOrigin: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_FORWARDED_DENIED" }));
  });

  it("supports an exact IPv6 loopback origin without accepting an unspecified bind", () => {
    const policy = new NetworkExposurePolicy({
      mode: "local",
      listenHost: "::1",
      listenPort: 9800,
    });
    expect(
      policy.validateRequest(
        localRequest({
          peerAddress: "::1",
          host: "[::1]:9800",
          origin: "http://[::1]:9800",
        }),
        { requireOrigin: true },
      ),
    ).toMatchObject({ effectiveOrigin: "http://[::1]:9800" });
    expect(
      () =>
        new NetworkExposurePolicy({
          mode: "local",
          listenHost: "::" as "::1",
          listenPort: 9800,
        }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_CONFIG_INVALID" }));
  });

  it("accepts external authority only through an explicitly trusted proxy and HTTPS origin", () => {
    const policy = new NetworkExposurePolicy({
      mode: "reverse-proxy",
      listenHost: "127.0.0.1",
      listenPort: 9800,
      trustedProxyAddresses: ["127.0.0.2"],
      externalOrigins: ["https://admin.example.test"],
    });
    expect(policy.validateRequest(proxyRequest(), { requireOrigin: true })).toEqual({
      mode: "reverse-proxy",
      effectiveOrigin: "https://admin.example.test",
      clientAddress: "203.0.113.7",
      peerAddress: "127.0.0.2",
      viaTrustedProxy: true,
    });

    expect(() =>
      policy.validateRequest(proxyRequest({ peerAddress: "127.0.0.3" }), {
        requireOrigin: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_PEER_DENIED" }));
    expect(() =>
      policy.validateRequest(
        proxyRequest({ forwarded: "for=203.0.113.7;proto=http;host=admin.example.test" }),
        { requireOrigin: true },
      ),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_HTTPS_REQUIRED" }));
  });

  it("rejects conflicting standard and X-Forwarded metadata", () => {
    const policy = new NetworkExposurePolicy({
      mode: "reverse-proxy",
      listenHost: "127.0.0.1",
      listenPort: 9800,
      trustedProxyAddresses: ["127.0.0.2"],
      externalOrigins: ["https://admin.example.test"],
    });
    expect(() =>
      policy.validateRequest(
        proxyRequest({
          xForwardedProto: "https",
          xForwardedHost: "other.example.test",
          xForwardedFor: "203.0.113.7",
        }),
        { requireOrigin: true },
      ),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_FORWARDED_CONFLICT" }));
    expect(() =>
      policy.validateRequest(
        proxyRequest({
          forwarded: undefined,
          xForwardedProto: "https,http",
          xForwardedHost: "admin.example.test",
          xForwardedFor: "203.0.113.7",
        }),
        { requireOrigin: true },
      ),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_FORWARDED_DENIED" }));
  });

  it("rejects duplicate security headers and an absent required browser Origin", () => {
    const policy = new NetworkExposurePolicy({ mode: "local", listenPort: 9800 });
    expect(() =>
      policy.validateRequest(localRequest({ host: ["127.0.0.1:9800", "attacker.test"] }), {
        requireOrigin: true,
      }),
    ).toThrowError(NetworkExposureError);
    expect(() =>
      policy.validateRequest(localRequest({ origin: undefined }), {
        requireOrigin: true,
      }),
    ).toThrowError(NetworkExposureError);
  });

  it("refuses public upstream binds and non-HTTPS external origins", () => {
    expect(
      () =>
        new NetworkExposurePolicy({
          mode: "reverse-proxy",
          listenHost: "0.0.0.0",
          listenPort: 9800,
          trustedProxyAddresses: ["127.0.0.2"],
          externalOrigins: ["https://admin.example.test"],
        }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_CONFIG_INVALID" }));
    expect(
      () =>
        new NetworkExposurePolicy({
          mode: "reverse-proxy",
          listenHost: "127.0.0.1",
          listenPort: 9800,
          trustedProxyAddresses: ["127.0.0.2"],
          externalOrigins: ["http://admin.example.test"],
        }),
    ).toThrowError(expect.objectContaining({ code: "EXPOSURE_CONFIG_INVALID" }));
  });
});
