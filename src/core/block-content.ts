import { assertJsonValue, type JsonValue } from "./canonical-json.js";

/**
 * A structured-data schema name has a lowercase dotted owner/name followed by
 * an explicit decimal version. The whole-segment form lets Core derive an
 * Extension publisher without normalizing or guessing an identifier.
 */
export const CONTENT_SCHEMA_NAME_PATTERN =
  /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+\/[1-9][0-9]{0,3}$/u;

/**
 * A rectangle uses coordinates from 0 to 1 relative to the original image.
 * The media store converts it to pixels only when a provider needs bytes.
 */
export interface Rect {
  readonly topLeft: { readonly x: number; readonly y: number };
  readonly bottomRight: { readonly x: number; readonly y: number };
}

export interface TextContentItem {
  readonly type: "text";
  readonly text: string;
  readonly format?: "plain" | "markdown";
}

export interface BlockReferenceItem {
  readonly type: "block-reference";
  readonly blockId: string;
}

export interface MediaReferenceItem {
  readonly type: "media-reference";
  readonly mediaId: string;
  readonly crop?: Rect;
  readonly caption?: string;
  readonly accessibility?: {
    readonly decorative?: boolean;
    readonly description?: string;
    readonly transcript?: string;
    readonly language?: string;
  };
}

export interface DataContentItem {
  readonly type: "data";
  readonly schema: string;
  readonly value: JsonValue;
}

export type BlockContentItem =
  | TextContentItem
  | BlockReferenceItem
  | MediaReferenceItem
  | DataContentItem;

export interface BlockContent {
  readonly items: readonly BlockContentItem[];
}

/** Internal lists used to build reference-graph dependencies from validated content items. */
export interface BlockContentReferences {
  readonly blocks: readonly BlockReferenceItem[];
  readonly media: readonly MediaReferenceItem[];
}

function closedObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a non-empty opaque identifier`);
  }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** Validate one structured-data schema name without changing its bytes. */
export function parseContentSchemaName(
  value: unknown,
  label = "content schema name",
): string {
  if (typeof value !== "string" || !CONTENT_SCHEMA_NAME_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a lowercase dotted name followed by a version from 1 to 9999`,
    );
  }
  return value;
}

function optionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string when present`);
  }
}

function coordinate(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
}

/** Validate and copy a normalized rectangle from an untrusted input. */
export function parseRect(value: unknown, label = "crop"): Rect {
  closedObject(value, ["topLeft", "bottomRight"], label);
  closedObject(value.topLeft, ["x", "y"], `${label}.topLeft`);
  closedObject(value.bottomRight, ["x", "y"], `${label}.bottomRight`);
  coordinate(value.topLeft.x, `${label}.topLeft.x`);
  coordinate(value.topLeft.y, `${label}.topLeft.y`);
  coordinate(value.bottomRight.x, `${label}.bottomRight.x`);
  coordinate(value.bottomRight.y, `${label}.bottomRight.y`);
  if (
    value.topLeft.x >= value.bottomRight.x ||
    value.topLeft.y >= value.bottomRight.y
  ) {
    throw new Error(`${label} must have positive width and height`);
  }
  return {
    topLeft: { x: value.topLeft.x, y: value.topLeft.y },
    bottomRight: { x: value.bottomRight.x, y: value.bottomRight.y },
  };
}

/** Validate and copy one Media reference from an untrusted input. */
export function parseMediaReferenceItem(
  value: unknown,
  label = "media reference",
): MediaReferenceItem {
  closedObject(
    value,
    ["type", "mediaId", "crop", "caption", "accessibility"],
    label,
  );
  if (value.type !== "media-reference") {
    throw new Error(`${label}.type must be media-reference`);
  }
  identifier(value.mediaId, `${label}.mediaId`);
  optionalString(value.caption, `${label}.caption`);
  let parsedAccessibility: MediaReferenceItem["accessibility"];
  if (value.accessibility !== undefined) {
    closedObject(
      value.accessibility,
      ["decorative", "description", "transcript", "language"],
      `${label}.accessibility`,
    );
    if (
      value.accessibility.decorative !== undefined &&
      typeof value.accessibility.decorative !== "boolean"
    ) {
      throw new Error(`${label}.accessibility.decorative must be boolean`);
    }
    optionalString(
      value.accessibility.description,
      `${label}.accessibility.description`,
    );
    optionalString(
      value.accessibility.transcript,
      `${label}.accessibility.transcript`,
    );
    optionalString(value.accessibility.language, `${label}.accessibility.language`);
    parsedAccessibility = {
      ...(value.accessibility.decorative === undefined
        ? {}
        : { decorative: value.accessibility.decorative }),
      ...(value.accessibility.description === undefined
        ? {}
        : { description: value.accessibility.description }),
      ...(value.accessibility.transcript === undefined
        ? {}
        : { transcript: value.accessibility.transcript }),
      ...(value.accessibility.language === undefined
        ? {}
        : { language: value.accessibility.language }),
    };
  }
  if (
    parsedAccessibility?.decorative === true &&
    (value.caption !== undefined ||
      parsedAccessibility.description !== undefined ||
      parsedAccessibility.transcript !== undefined)
  ) {
    throw new Error(`${label} decorative media cannot have descriptive text`);
  }
  return {
    type: "media-reference",
    mediaId: value.mediaId,
    ...(value.crop === undefined
      ? {}
      : { crop: parseRect(value.crop, `${label}.crop`) }),
    ...(value.caption === undefined ? {} : { caption: value.caption }),
    ...(parsedAccessibility === undefined
      ? {}
      : { accessibility: parsedAccessibility }),
  };
}

function parseItem(value: unknown, index: number): BlockContentItem {
  const label = `content.items[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (typeof (value as { type?: unknown }).type !== "string") {
    throw new Error(`${label}.type must be a string`);
  }

  switch ((value as { type: string }).type) {
    case "text": {
      closedObject(value, ["type", "text", "format"], label);
      nonEmptyString(value.text, `${label}.text`);
      if (value.format !== undefined && value.format !== "plain" && value.format !== "markdown") {
        throw new Error(`${label}.format is not supported`);
      }
      return {
        type: "text",
        text: value.text,
        ...(value.format === undefined ? {} : { format: value.format }),
      };
    }
    case "block-reference": {
      closedObject(value, ["type", "blockId"], label);
      identifier(value.blockId, `${label}.blockId`);
      return {
        type: "block-reference",
        blockId: value.blockId,
      };
    }
    case "media-reference": {
      return parseMediaReferenceItem(value, label);
    }
    case "data": {
      closedObject(value, ["type", "schema", "value"], label);
      const schema = parseContentSchemaName(value.schema, `${label}.schema`);
      assertJsonValue(value.value, `${label}.value`);
      return { type: "data", schema, value: value.value };
    }
    default:
      throw new Error(`${label}.type is not supported`);
  }
}

export function parseBlockContent(value: unknown, maxItems = 256): BlockContent {
  closedObject(value, ["items"], "content");
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new Error("content.items must be a non-empty array");
  }
  if (value.items.length > maxItems) {
    throw new Error(`content.items exceeds the limit of ${maxItems}`);
  }
  return {
    items: value.items.map((item, index) => parseItem(item, index)),
  };
}

export function contentReferences(content: BlockContent): BlockContentReferences {
  const blocks: BlockReferenceItem[] = [];
  const media: MediaReferenceItem[] = [];
  for (const item of content.items) {
    if (item.type === "block-reference") blocks.push(item);
    if (item.type === "media-reference") media.push(item);
  }
  return { blocks, media };
}
