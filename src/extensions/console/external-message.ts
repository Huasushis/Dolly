import { canonicalJsonDigest, deepFreeze } from "../../core/canonical-json.js";
import { consoleError } from "./errors.js";

/**
 * The one versioned external ingress envelope. Both the browser/HTTP binding
 * and the CLI binding hand their untrusted input to `parseExternalMessage`, so
 * `docs/spec/console-extension.md` section 8.3 protocol parity is a property of
 * the code path rather than of two hand-synchronised validators.
 */
export const EXTERNAL_MESSAGE_SCHEMA = "dolly.console.external-message/1" as const;
export const EXTERNAL_MESSAGE_TYPE = "console.message.enqueue" as const;
export const EXTERNAL_MESSAGE_VERSION = "1" as const;

/**
 * The external channel this package speaks for.
 *
 * The channel kind is what makes a Console message distinguishable from a
 * future social-messaging ingress inside a committed Block: each channel owns
 * its own reserved boundary schema, and a producer may only emit the schema
 * reserved for its own kind. Adding a channel means adding a registry entry
 * with its own reserved name, never reusing the Console one.
 */
export type ExternalChannelKind = "console";

/**
 * A `Map`, not an object literal: an object lookup would resolve
 * `constructor`, `toString`, and `__proto__` through `Object.prototype` and
 * hand an unregistered channel a truthy answer.
 */
const RESERVED_BOUNDARY_SCHEMAS: ReadonlyMap<string, string> = new Map<
  ExternalChannelKind,
  string
>([["console", "dolly.console.message-boundary/1"]]);

export function externalChannelBoundarySchema(kind: string): string {
  const schema = RESERVED_BOUNDARY_SCHEMAS.get(kind);
  if (schema === undefined) {
    throw consoleError(
      "PROTOCOL_INCOMPATIBLE",
      "No reserved message-boundary schema is registered for this external channel",
      { channelKind: kind },
    );
  }
  return schema;
}

export const CONSOLE_CHANNEL_KIND: ExternalChannelKind = "console";
export const MESSAGE_BOUNDARY_SCHEMA = externalChannelBoundarySchema(CONSOLE_CHANNEL_KIND);

/**
 * A separator string a renderer MAY draw for the boundary item.
 *
 * It is published here, not committed. `console-extension.md` section 5.5
 * requires the boundary to be a closed `data` item with an empty value and no
 * inline fallback representation, because a second representation of one
 * content item lets two consumers disagree about what the Block says. A
 * renderer that does not know the schema correctly shows nothing: the
 * boundary's whole meaning is "a new message starts here", which a reader who
 * cannot use the grouping loses nothing by missing.
 */
export const MESSAGE_BOUNDARY_FALLBACK_TEXT = "---";

export interface ExternalAttachmentReference {
  /**
   * An opaque, session-scoped upload grant returned by the upload flow. The
   * client never names a `mediaId`: section 7.1 keeps raw Media authority off
   * the external protocol, so the grant is resolved server-side and a message
   * that tries to name a Media directly is rejected as an unknown field.
   */
  readonly uploadGrantId: string;
}

export interface ConsoleExternalMessage {
  readonly schemaVersion: typeof EXTERNAL_MESSAGE_SCHEMA;
  readonly channelKind: ExternalChannelKind;
  readonly operationId: string;
  readonly clientMessageId: string;
  readonly routeAlias: string;
  /** Absent for a media-only message. No placeholder text is ever inserted. */
  readonly text?: string;
  readonly attachments: readonly ExternalAttachmentReference[];
  /** Non-authoritative client metadata. It never reaches Block content. */
  readonly locale?: string;
  readonly clientSentAt?: string;
}

export interface ExternalMessageLimits {
  readonly maxTextBytes: number;
  readonly maxAttachmentsPerMessage: number;
  readonly maxLocaleBytes: number;
}

export const DEFAULT_EXTERNAL_MESSAGE_LIMITS: ExternalMessageLimits = deepFreeze({
  maxTextBytes: 64 * 1024,
  maxAttachmentsPerMessage: 16,
  maxLocaleBytes: 64,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MESSAGE_KEYS = [
  "version",
  "type",
  "operationId",
  "clientMessageId",
  "routeAlias",
  "text",
  "attachments",
  "locale",
  "clientSentAt",
] as const;

function closedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw consoleError("MESSAGE_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw consoleError("MESSAGE_INVALID", `${label} must be a plain object`);
  }
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw consoleError("MESSAGE_INVALID", `${label} contains unknown fields`, {
      fields: unknown.slice(0, 8),
    });
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw consoleError("MESSAGE_INVALID", `${label} must be an opaque identifier`);
  }
  return value;
}

function normalizeLimits(input: Partial<ExternalMessageLimits> | undefined): ExternalMessageLimits {
  const limits = { ...DEFAULT_EXTERNAL_MESSAGE_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw consoleError("MESSAGE_INVALID", `Console limit ${name} must be a positive integer`);
    }
  }
  return deepFreeze(limits);
}

function parseAttachments(
  value: unknown,
  limits: ExternalMessageLimits,
): readonly ExternalAttachmentReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw consoleError("MESSAGE_INVALID", "attachments must be an array when present");
  }
  if (value.length > limits.maxAttachmentsPerMessage) {
    throw consoleError("MESSAGE_INVALID", "attachments exceed the per-message limit", {
      limit: limits.maxAttachmentsPerMessage,
    });
  }
  return value.map((entry, index) => {
    closedObject(entry, ["uploadGrantId"], `attachments[${index}]`);
    return { uploadGrantId: identifier(entry.uploadGrantId, `attachments[${index}].uploadGrantId`) };
  });
}

/**
 * Validates one untrusted external message and returns the normalized envelope.
 *
 * The envelope deliberately carries no session, tenant, route revision, Block,
 * Delivery, or Module job identity. Section 4.1 makes those server-side facts;
 * a client field that looked like one would be a lookup hint at most, so the
 * schema simply has nowhere to put it.
 */
export function parseExternalMessage(
  value: unknown,
  limitsInput?: Partial<ExternalMessageLimits>,
): ConsoleExternalMessage {
  const limits = normalizeLimits(limitsInput);
  closedObject(value, MESSAGE_KEYS, "external message");
  if (value.version !== EXTERNAL_MESSAGE_VERSION || value.type !== EXTERNAL_MESSAGE_TYPE) {
    throw consoleError("PROTOCOL_INCOMPATIBLE", "External message version or type is unsupported", {
      version: typeof value.version === "string" ? value.version : null,
      type: typeof value.type === "string" ? value.type : null,
    });
  }

  const operationId = identifier(value.operationId, "operationId");
  const clientMessageId = identifier(value.clientMessageId, "clientMessageId");
  const routeAlias = identifier(value.routeAlias, "routeAlias");
  const attachments = parseAttachments(value.attachments, limits);

  let text: string | undefined;
  if (value.text !== undefined) {
    if (typeof value.text !== "string" || value.text.length === 0) {
      throw consoleError("MESSAGE_INVALID", "text must be a non-empty string when present");
    }
    if (Buffer.byteLength(value.text, "utf8") > limits.maxTextBytes) {
      throw consoleError("MESSAGE_INVALID", "text exceeds the configured byte limit", {
        limit: limits.maxTextBytes,
      });
    }
    text = value.text;
  }

  // Section 5.1: at least one of text or media, and no synthetic placeholder
  // text is added to make a media-only message look textual.
  if (text === undefined && attachments.length === 0) {
    throw consoleError("MESSAGE_INVALID", "A message needs text, media, or both");
  }

  let locale: string | undefined;
  if (value.locale !== undefined) {
    if (
      typeof value.locale !== "string" ||
      value.locale.length === 0 ||
      Buffer.byteLength(value.locale, "utf8") > limits.maxLocaleBytes
    ) {
      throw consoleError("MESSAGE_INVALID", "locale must be a short non-empty string");
    }
    locale = value.locale;
  }

  let clientSentAt: string | undefined;
  if (value.clientSentAt !== undefined) {
    if (typeof value.clientSentAt !== "string" || !Number.isFinite(Date.parse(value.clientSentAt))) {
      throw consoleError("MESSAGE_INVALID", "clientSentAt must be an ISO-8601 timestamp");
    }
    clientSentAt = new Date(Date.parse(value.clientSentAt)).toISOString();
  }

  const message: ConsoleExternalMessage = {
    schemaVersion: EXTERNAL_MESSAGE_SCHEMA,
    channelKind: CONSOLE_CHANNEL_KIND,
    operationId,
    clientMessageId,
    routeAlias,
    ...(text === undefined ? {} : { text }),
    attachments,
    ...(locale === undefined ? {} : { locale }),
    ...(clientSentAt === undefined ? {} : { clientSentAt }),
  };
  return deepFreeze(message);
}

/** Canonical identity of one logical message, used for idempotency conflicts. */
export function externalMessageDigest(message: ConsoleExternalMessage): string {
  return canonicalJsonDigest(message);
}
