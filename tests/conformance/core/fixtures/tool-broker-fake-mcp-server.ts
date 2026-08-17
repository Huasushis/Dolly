/**
 * Fake MCP stdio server for the Tool Broker handshake conformance slice.
 *
 * Reads newline-delimited JSON-RPC messages from stdin and writes
 * newline-delimited JSON-RPC messages to stdout. The behaviour is selected by
 * the first command-line argument so a single fixture covers every handshake
 * case the conformance test exercises. It is a test helper, not a product
 * server: it deliberately implements only the 2025-06-18 initialize/initialized
 * lifecycle frames the slice observes.
 *
 * Modes:
 *   exact          respond with protocolVersion "2025-06-18" then exit 0 after
 *                  receiving notifications/initialized
 *   wrong-version  respond with protocolVersion "2026-07-28"
 *   malformed      respond with a non-JSON line
 *   no-response    read initialize, never respond, keep stdin open
 *   early-exit     exit with code 1 before responding
 *   duplicate-init respond twice to a single initialize request
 *   initialized-first  send notifications/initialized before responding
 */
import { createInterface } from "node:readline";

type Mode =
  | "exact"
  | "wrong-version"
  | "malformed"
  | "no-response"
  | "early-exit"
  | "duplicate-init"
  | "initialized-first";

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

if (mode === "early-exit") {
  process.exit(1);
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

readline.on("line", (line) => {
  if (!line.trim()) return;
  // Echo every received line to stderr so the test can assert the exact
  // frames the broker sent (initialize request, notifications/initialized).
  // Responses go to stdout; the broker reads those separately.
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
    return;
  }
});

readline.on("close", () => {
  process.exit(0);
});
