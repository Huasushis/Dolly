/**
 * Fake MCP stdio server for the Tool Broker handshake and post-handshake
 * session conformance slices.
 *
 * Reads newline-delimited JSON-RPC messages from stdin and writes
 * newline-delimited JSON-RPC messages to stdout. The behaviour is selected by
 * the first command-line argument so a single fixture covers every handshake
 * and ping case the conformance tests exercise. It is a test helper, not a
 * product server: it deliberately implements only the 2025-06-18
 * initialize/initialized lifecycle and the ping substrate the slice observes.
 *
 * Modes:
 *   exact          respond with the handshake, then exit 0 after receiving
 *                  notifications/initialized
 *   wrong-version  respond with protocolVersion "2026-07-28"
 *   malformed      respond with a non-JSON line
 *   no-response    read initialize, never respond, keep stdin open
 *   early-exit     exit with code 1 before responding
 *   duplicate-init respond twice to a single initialize request
 *   initialized-first  send notifications/initialized before responding
 *   ping-ok        full handshake, then answer each ping with result {}
 *   ping-meta      answer ping with result {"_meta":{"x":1}}
 *   ping-wrong-id  answer ping with a wrong id (999)
 *   ping-error     answer ping with a JSON-RPC error envelope
 *   ping-notification  answer ping with a notification frame
 *   ping-malformed-result  answer ping with a non-object result
 *   ping-duplicate answer the same ping twice
 *   ping-no-response    full handshake, then never answer ping
 *   ping-idle-exit      full handshake, then exit 0 after a delay
 *   ping-server-request full handshake, then the server sends a request frame
 */
import { createInterface } from "node:readline";

type Mode =
  | "exact"
  | "wrong-version"
  | "malformed"
  | "no-response"
  | "early-exit"
  | "duplicate-init"
  | "initialized-first"
  | "ping-ok"
  | "ping-meta"
  | "ping-wrong-id"
  | "ping-error"
  | "ping-notification"
  | "ping-malformed-result"
  | "ping-duplicate"
  | "ping-no-response"
  | "ping-idle-exit"
  | "ping-server-request";

const mode = (process.argv[2] ?? "exact") as Mode;

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const serverInfo = { name: "fake-mcp-server", version: "0.0.0-test" };
const capabilities = { tools: {} };

function initializeResponse(id: unknown, protocolVersion: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion,
      capabilities,
      serverInfo,
    },
  };
}

const initializedNotification = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
};

function respond(id: unknown): void {
  switch (mode) {
    case "wrong-version":
      send(initializeResponse(id, "2026-07-28"));
      break;
    case "malformed":
      process.stdout.write("{ not valid json\n");
      break;
    case "duplicate-init":
      send(initializeResponse(id, "2025-06-18"));
      send(initializeResponse(id, "2025-06-18"));
      break;
    case "initialized-first":
      send(initializedNotification);
      send(initializeResponse(id, "2025-06-18"));
      break;
    case "exact":
    default:
      send(initializeResponse(id, "2025-06-18"));
      break;
  }
}

/** Post-handshake behaviour for a ping request with a given id. */
function respondToPing(id: unknown): void {
  switch (mode) {
    case "ping-meta":
      send({ jsonrpc: "2.0", id, result: { _meta: { x: 1 } } });
      break;
    case "ping-wrong-id":
      send({ jsonrpc: "2.0", id: 999, result: {} });
      break;
    case "ping-error":
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      break;
    case "ping-notification":
      send({ jsonrpc: "2.0", method: "notifications/cancelled" });
      break;
    case "ping-malformed-result":
      send({ jsonrpc: "2.0", id, result: "string" });
      break;
    case "ping-duplicate":
      send({ jsonrpc: "2.0", id, result: {} });
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "ping-no-response":
    case "ping-idle-exit":
      break;
    case "ping-ok":
    default:
      send({ jsonrpc: "2.0", id, result: {} });
      break;
  }
}

if (mode === "early-exit") {
  process.exit(1);
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

readline.on("line", (line) => {
  if (!line.trim()) return;
  // Echo every received line to stderr so the test can assert the exact
  // frames the broker sent (initialize request, notifications/initialized,
  // and ping requests). Responses go to stdout; the broker reads those on
  // a separate stream.
  process.stderr.write(`RECV: ${line}\n`);
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const record = message as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  if (record.method === "initialize" && record.id !== undefined) {
    if (mode === "no-response") return;
    respond(record.id);
    return;
  }
  if (record.method === "notifications/initialized") {
    if (mode === "exact") {
      process.exit(0);
    }
    if (mode === "ping-idle-exit") {
      // Leave the handshake complete, then exit cleanly after a delay so
      // the host has a live generation whose child dies mid-request.
      setTimeout(() => process.exit(0), 300);
    }
    if (mode === "ping-server-request") {
      // Reverse premise: the server initiates its own request after the
      // handshake instead of answering the host's next request.
      send({ jsonrpc: "2.0", id: 777, method: "tools/list" });
    }
    return;
  }
  if (record.method === "ping") {
    respondToPing(record.id);
    return;
  }
});

readline.on("close", () => {
  process.exit(0);
});
