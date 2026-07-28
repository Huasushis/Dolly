import type { JsonValue } from "../../core/canonical-json.js";

/**
 * The Console-specific error taxonomy from `docs/spec/console-extension.md`
 * section 14, restricted to the parts this package actually implements.
 *
 * Every code is stable and safe to show a client. Diagnostic detail belongs in
 * `details`, which callers must keep out of routine logs when it names a
 * session or a Media identifier.
 */
export type ConsoleErrorCode =
  // Session and route authority.
  | "AUTH_REQUIRED"
  | "SESSION_UNKNOWN"
  | "SESSION_REVOKED"
  | "SESSION_SCOPE_DENIED"
  | "ROUTE_DENIED"
  | "ROUTE_UNAVAILABLE"
  // Ingress acceptance.
  | "MESSAGE_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "QUEUE_FULL"
  | "CLAIM_ITEM_OVERSIZE"
  | "PROTOCOL_INCOMPATIBLE"
  // Media contract.
  | "MEDIA_INVALID"
  | "MEDIA_NOT_READY"
  | "MEDIA_NOT_DELIVERED"
  | "MEDIA_CROP_NOT_DELIVERED"
  // Egress and display.
  | "RESULT_INVALID"
  | "BACKPRESSURE"
  | "DISPLAY_START_REQUIRED"
  | "DISPLAY_ACK_INVALID"
  | "DISPLAY_PREPARATION_CONFLICT"
  // Deployment and client surface.
  | "BINDING_NOT_LOOPBACK"
  | "CREDENTIAL_IN_ARGUMENT";

export class ConsoleExtensionError extends Error {
  constructor(
    readonly code: ConsoleErrorCode,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ConsoleExtensionError";
  }
}

export function consoleError(
  code: ConsoleErrorCode,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ConsoleExtensionError {
  return new ConsoleExtensionError(code, message, details);
}
