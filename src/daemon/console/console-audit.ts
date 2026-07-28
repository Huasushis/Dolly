/**
 * Audit events for management-console operations.
 *
 * `security-operations.md` Section 11 fixes the required fields — timestamp,
 * event type, result, operation identifier, actor or session identity,
 * instance identifier, generation identifier where applicable, and
 * configuration revision — and requires credentials, signed URLs, raw Media,
 * full prompts, and response bodies to stay out by default.
 * `instance-topology.md` Section 11 adds that both editing interfaces MUST emit
 * the same event types with the same fields for the same change, and that the
 * interface used MAY be recorded as an attribute of the actor but MUST NOT
 * change which events exist. That is why `ConsoleActor.interface` lives inside
 * the actor object and nowhere else.
 */

import { deepFreeze, type JsonValue } from "../../core/canonical-json.js";

export type ConsoleInterfaceKind = "cli" | "graphical";

export interface ConsoleActor {
  /** Stable non-secret identity of the operator or service account. */
  readonly principalId: string;
  /** Present for a browser session; absent for an in-process CLI call. */
  readonly sessionId?: string;
  readonly interface: ConsoleInterfaceKind;
}

export interface ConsoleAuditEvent {
  readonly schemaVersion: "dolly.console-audit/1";
  readonly observedAt: string;
  readonly eventType: string;
  readonly result: "succeeded" | "refused" | "failed";
  readonly operationId: string;
  readonly instanceId: string;
  readonly actor: ConsoleActor;
  readonly configRevision?: string;
  readonly newConfigRevision?: string;
  readonly moduleGenerationId?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type ConsoleAuditSink = (event: ConsoleAuditEvent) => void;

export interface ConsoleAuditEventInput {
  readonly eventType: string;
  readonly result: ConsoleAuditEvent["result"];
  readonly operationId: string;
  readonly instanceId: string;
  readonly actor: ConsoleActor;
  readonly configRevision?: string;
  readonly newConfigRevision?: string;
  readonly moduleGenerationId?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export function buildConsoleAuditEvent(
  now: () => string,
  input: ConsoleAuditEventInput,
): ConsoleAuditEvent {
  const parsed = Date.parse(now());
  if (!Number.isFinite(parsed)) {
    throw new TypeError("The console clock returned an invalid instant");
  }
  return deepFreeze({
    schemaVersion: "dolly.console-audit/1",
    observedAt: new Date(parsed).toISOString(),
    eventType: input.eventType,
    result: input.result,
    operationId: input.operationId,
    instanceId: input.instanceId,
    actor: {
      principalId: input.actor.principalId,
      ...(input.actor.sessionId === undefined ? {} : { sessionId: input.actor.sessionId }),
      interface: input.actor.interface,
    },
    ...(input.configRevision === undefined ? {} : { configRevision: input.configRevision }),
    ...(input.newConfigRevision === undefined
      ? {}
      : { newConfigRevision: input.newConfigRevision }),
    ...(input.moduleGenerationId === undefined
      ? {}
      : { moduleGenerationId: input.moduleGenerationId }),
    ...(input.details === undefined ? {} : { details: input.details }),
  }) as ConsoleAuditEvent;
}
