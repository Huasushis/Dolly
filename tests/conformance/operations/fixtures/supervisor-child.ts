import { createServer } from "node:http";
import {
  createAuthenticatedReadinessEnvelope,
  parseSupervisorBootstrapMessage,
} from "../../../../src/core/process-supervisor.js";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"status":"ok"}');
});

let initialized = false;
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.disconnect?.();
  process.exit(0);
}

process.once("message", (value) => {
  if (initialized) process.exit(70);
  initialized = true;
  const bootstrap = parseSupervisorBootstrapMessage(value);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") process.exit(71);
    process.send?.(
      createAuthenticatedReadinessEnvelope(bootstrap, {
        endpoints: [{ kind: "http", address: `http://127.0.0.1:${address.port}` }],
        durableStateReady: true,
        requiredListenersReady: true,
      }),
    );
  });
});

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.once("disconnect", () => void stop());
