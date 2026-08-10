import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../../src/core/canonical-json.js";
import { ExperimentFetchTransport } from "../../../scripts/experiments/probes/general-agent-live-v0/run.mjs";

describe("general Agent experiment transport evidence", () => {
  it("records a bounded non-2xx body even when the broker does not consume it", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "temporarily_unavailable" } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("test HTTP server did not expose a TCP address");
    }
    const records: JsonValue[] = [];
    const transport = new ExperimentFetchTransport((record) => records.push(record));
    try {
      const response = await transport.dispatch({
        url: new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`),
        networkScope: "loopback",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ model: "fixture" }), "utf8"),
        timeoutMs: 2_000,
        maxResponseBytes: 4_096,
        signal: new AbortController().signal,
      });

      expect(response.status).toBe(503);
      expect(records).toEqual([expect.objectContaining({
        httpStatus: 503,
        response: { error: { code: "temporarily_unavailable" } },
      })]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
