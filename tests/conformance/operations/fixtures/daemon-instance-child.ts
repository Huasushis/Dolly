/**
 * A real Dolly instance child for daemon supervision tests.
 *
 * `DOLLY_TEST_CHILD_BEHAVIOR` selects one scripted lifecycle so a test can
 * exercise readiness, a startup crash, or a process that never reports
 * readiness, all with a genuine operating-system process.
 */

import { createServer } from "node:http";
import {
  createAuthenticatedReadinessEnvelope,
  parseSupervisorBootstrapMessage,
} from "../../../../src/core/process-supervisor.js";

type ChildBehavior = "ready" | "silent" | "exit-before-ready";

const behavior = (process.env.DOLLY_TEST_CHILD_BEHAVIOR ?? "ready") as ChildBehavior;

if (behavior === "exit-before-ready") {
  // Exit after the parent has certainly received the process handle, so the
  // test observes an unexpected exit rather than a launch failure.
  setTimeout(() => process.exit(3), 25);
} else if (behavior === "silent") {
  // Stay alive without ever reporting readiness. Default signal handling ends
  // the process when the supervisor terminates it.
  setInterval(() => undefined, 1_000);
} else {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });

  let initialized = false;
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.disconnect?.();
    process.exit(0);
  };

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
}
