import { describe, expect, it, vi } from "vitest";
import {
  SecureRemoteFetcher,
  isPublicNetworkAddress,
  type PinnedHttpsTransport,
  type PinnedTransportRequest,
  type PinnedTransportResponse,
  type ResolvedNetworkAddress,
  type SecureDnsResolver,
  type SecureRemoteFetchPolicy,
} from "../../../src/core/secure-remote-fetch.js";

const PUBLIC = "93.184.216.34";

function policy(overrides: Partial<SecureRemoteFetchPolicy> = {}): SecureRemoteFetchPolicy {
  return {
    allowedHosts: ["safe.example"],
    maxUrlBytes: 4096,
    maxRedirects: 3,
    maxBytes: 5,
    connectTimeoutMs: 100,
    headerTimeoutMs: 200,
    totalTimeoutMs: 500,
    ...overrides,
  };
}

function body(...chunks: readonly number[][]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield Uint8Array.from(chunk);
  })();
}

function response(
  input: PinnedTransportRequest,
  overrides: Partial<PinnedTransportResponse> = {},
): PinnedTransportResponse {
  return {
    status: 200,
    headers: {},
    connectedAddress: input.address.address,
    body: body([1]),
    abort: vi.fn(),
    ...overrides,
  };
}

class FakeResolver implements SecureDnsResolver {
  constructor(
    readonly records: Readonly<Record<string, readonly ResolvedNetworkAddress[]>>,
  ) {}

  async resolve(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
    return this.records[hostname] ?? [];
  }
}

class FakeTransport implements PinnedHttpsTransport {
  readonly requests: PinnedTransportRequest[] = [];

  constructor(
    readonly handlers: Array<
      (input: PinnedTransportRequest) => PinnedTransportResponse
    >,
  ) {}

  async request(input: PinnedTransportRequest): Promise<PinnedTransportResponse> {
    this.requests.push(input);
    const handler = this.handlers.shift();
    if (!handler) throw new Error("Unexpected transport request");
    return handler(input);
  }
}

describe("SEC-001 secure remote fetch", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
  ])("classifies %s as non-public", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each([PUBLIC, "1.1.1.1", "2606:4700:4700::1111"])(
    "classifies %s as public",
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );

  it("pins the request to an approved public DNS answer", async () => {
    const resolver = new FakeResolver({
      "safe.example": [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: PUBLIC, family: 4 },
      ],
    });
    const transport = new FakeTransport([
      (input) =>
        response(input, {
          connectedAddress: `::ffff:${PUBLIC}`,
          headers: { "content-type": "image/png; charset=binary" },
          body: body([1, 2], [3]),
        }),
    ]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(fetcher.fetch("https://safe.example/image.png", policy())).resolves.toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: "image/png",
      finalOrigin: "https://safe.example",
      redirects: 0,
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      address: { address: PUBLIC, family: 4 },
    });
  });

  it("rejects the whole DNS answer set when any address is private", async () => {
    const resolver = new FakeResolver({
      "safe.example": [
        { address: PUBLIC, family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    const transport = new FakeTransport([]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(fetcher.fetch("https://safe.example/image.png", policy())).rejects.toMatchObject({
      code: "REMOTE_ADDRESS_DENIED",
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("re-authorizes DNS and address policy after every redirect", async () => {
    const resolver = new FakeResolver({
      "safe.example": [{ address: PUBLIC, family: 4 }],
      "metadata.internal": [{ address: "169.254.169.254", family: 4 }],
    });
    const abort = vi.fn();
    const transport = new FakeTransport([
      (input) =>
        response(input, {
          status: 302,
          headers: { location: "https://metadata.internal/latest/meta-data" },
          abort,
        }),
    ]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(
      fetcher.fetch(
        "https://safe.example/start",
        policy({ allowedHosts: ["safe.example", "metadata.internal"] }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_ADDRESS_DENIED" });
    expect(abort).toHaveBeenCalledOnce();
    expect(transport.requests).toHaveLength(1);
  });

  it("rejects a transport that connected somewhere other than the pinned address", async () => {
    const resolver = new FakeResolver({
      "safe.example": [{ address: PUBLIC, family: 4 }],
    });
    const abort = vi.fn();
    const transport = new FakeTransport([
      (input) =>
        response(input, {
          connectedAddress: "127.0.0.1",
          abort,
        }),
    ]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(fetcher.fetch("https://safe.example/image.png", policy())).rejects.toMatchObject({
      code: "REMOTE_ADDRESS_MISMATCH",
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts a streamed response as soon as it crosses the decoded byte limit", async () => {
    const resolver = new FakeResolver({
      "safe.example": [{ address: PUBLIC, family: 4 }],
    });
    const abort = vi.fn();
    const transport = new FakeTransport([
      (input) =>
        response(input, {
          body: body([1, 2, 3], [4, 5, 6]),
          abort,
        }),
    ]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(fetcher.fetch("https://safe.example/image.png", policy())).rejects.toMatchObject({
      code: "REMOTE_SIZE_LIMIT",
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each([
    "http://safe.example/image.png",
    "https://user:secret@safe.example/image.png",
    "https://safe.example:8443/image.png",
    "https://other.example/image.png",
  ])("rejects unauthorized URL form %s before DNS", async (url) => {
    const resolver = new FakeResolver({});
    const transport = new FakeTransport([]);
    const fetcher = new SecureRemoteFetcher({ resolver, transport });

    await expect(fetcher.fetch(url, policy())).rejects.toBeInstanceOf(Error);
    expect(transport.requests).toHaveLength(0);
  });
});
