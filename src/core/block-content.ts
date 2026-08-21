import { assertJsonValue, type JsonValue } from "./canonical-json.js";

/**
 * A structured-data schema name has a lowercase dotted owner/name followed by
 * an explicit decimal version. The whole-segment form lets Core derive an
 * Extension publisher without normalizing or guessing an identifier.
 */
export const CONTENT_SCHEMA_NAME_PATTERN =
  /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+\/[1-9][0-9]{0,3}$/u;

/**
 * The fixed-point division scale of a normalized crop rectangle. Every crop
 * coordinate is an integer on `0..=1_000_000`; the wire record `image_rect_v1`
 * names this scale only implicitly.
 */
export const CROP_NORMALIZED_SCALE = 1_000_000;

/**
 * The largest supported display dimension: the safe JSON integer ceiling
 * `9007199254740991` (`2^53 - 1`). Multiplications above this ceiling are
 * rejected before any arithmetic, and within it intermediate products are
 * computed in `BigInt` so they stay exact.
 */
export const MAX_SUPPORTED_DIMENSION = 9_007_199_254_740_991;

/**
 * The versioned fixed-point crop rectangle `image_rect_v1`. Coordinates are
 * integers on the `0..=1_000_000` grid of upright display space; the origin is
 * the top-left corner, right and bottom edges are exclusive, and a valid
 * rectangle satisfies `x0 < x1` and `y0 < y1`. This is the single crop type
 * shared by Block content, the Media store, provider access, and the
 * delivered-Media read capability.
 */
export interface Rect {
  readonly kind: "image_rect_v1";
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Exact pixel bounds produced by materializing a fixed-point crop. */
export interface MaterializedCropBounds {
  /** Inclusive left pixel column in `0..width`. */
  readonly left: number;
  /** Inclusive top pixel row in `0..height`. */
  readonly top: number;
  /** Exclusive right pixel column in `0..width`. */
  readonly right: number;
  /** Exclusive bottom pixel row in `0..height`. */
  readonly bottom: number;
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

function fixedCoordinate(
  value: unknown,
  label: string,
  max = CROP_NORMALIZED_SCALE,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new Error(`${label} must be a fixed-point integer in 0..${max}`);
  }
}

/** Validate and copy a fixed-point crop rectangle from an untrusted input. */
export function parseRect(value: unknown, label = "crop"): Rect {
  closedObject(value, ["kind", "x0", "y0", "x1", "y1"], label);
  if (value.kind !== "image_rect_v1") {
    throw new Error(`${label}.kind must be image_rect_v1`);
  }
  fixedCoordinate(value.x0, `${label}.x0`);
  fixedCoordinate(value.y0, `${label}.y0`);
  fixedCoordinate(value.x1, `${label}.x1`);
  fixedCoordinate(value.y1, `${label}.y1`);
  if (value.x0 >= value.x1 || value.y0 >= value.y1) {
    throw new Error(
      `${label} must satisfy x0 < x1 and y0 < y1 (the right and bottom edges are exclusive)`,
    );
  }
  return {
    kind: "image_rect_v1",
    x0: value.x0,
    y0: value.y0,
    x1: value.x1,
    y1: value.y1,
  };
}

/**
 * The single shared fixed-point crop materializer, never copied as a separate
 * formula. It is identical in semantics to the accepted Rust lane: with an
 * integer `BigInt` divide and a precise ceil, it computes
 * `left/top = floor(coordinate * dimension / 1_000_000)` and
 * `right/bottom = ceil(coordinate * dimension / 1_000_000)`, clamps each edge
 * to `[0, limit]`, and refuses a display whose dimension is not a positive
 * safe integer no larger than `MAX_SUPPORTED_DIMENSION`. The empty guard
 * (`right <= left` or `bottom <= top`) exists as the pipeline's fail-closed
 * safety net just like `EMPTY_CROP`; for any crop this module accepts on any
 * positive display it cannot fire.
 *
 * Returns `null` when any premise is invalid (fail closed); it never guesses a
 * coordinate or appends to a crop. A caller decides the typed error it maps
 * `null` to (`MEDIA_CROP_INVALID`, `MEDIA_SNAPSHOT_INVALID`,
 * `CAPABILITY_ARGUMENT_INVALID`, ...).
 */
export function materializeCropBounds(
  rect: Rect,
  displayWidth: number,
  displayHeight: number,
): MaterializedCropBounds | null {
  if (!Number.isSafeInteger(displayWidth) || !Number.isSafeInteger(displayHeight)) {
    return null;
  }
  if (displayWidth <= 0 || displayHeight <= 0 || displayWidth > MAX_SUPPORTED_DIMENSION || displayHeight > MAX_SUPPORTED_DIMENSION) {
    return null;
  }
  if (rect.kind !== "image_rect_v1") return null;
  const coords = [rect.x0, rect.y0, rect.x1, rect.y1];
  for (const coordinate of coords) {
    if (!Number.isSafeInteger(coordinate) || coordinate < 0 || coordinate > CROP_NORMALIZED_SCALE) {
      return null;
    }
  }
  if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1) return null;

  const scale = CROP_NORMALIZED_SCALE;
  const w = BigInt(displayWidth);
  const h = BigInt(displayHeight);
  const numerator = BigInt(scale);

  const left = Number((BigInt(rect.x0) * w) / numerator);
  const top = Number((BigInt(rect.y0) * h) / numerator);
  const rightNumerator = BigInt(rect.x1) * w;
  const bottomNumerator = BigInt(rect.y1) * h;
  const rightRaw = Number((rightNumerator + numerator - 1n) / numerator);
  const bottomRaw = Number((bottomNumerator + numerator - 1n) / numerator);
  const leftClamped = Math.min(Math.max(left, 0), displayWidth);
  const topClamped = Math.min(Math.max(top, 0), displayHeight);
  const rightClamped = Math.min(Math.max(rightRaw, 0), displayWidth);
  const bottomClamped = Math.min(Math.max(bottomRaw, 0), displayHeight);
  if (rightClamped <= leftClamped || bottomClamped <= topClamped) {
    // The fail-closed empty guard of the fixed-point pipeline. It is
    // unreachable for valid input but kept so a drifted decoder cannot
    // materialize an empty region.
    return null;
  }
  return {
    left: leftClamped,
    top: topClamped,
    right: rightClamped,
    bottom: bottomClamped,
  };
}

/** Exact equality of two fixed-point crop rectangles. */
export function cropEquals(left: Rect, right: Rect): boolean {
  return (
    left.kind === right.kind &&
    left.x0 === right.x0 &&
    left.y0 === right.y0 &&
    left.x1 === right.x1 &&
    left.y1 === right.y1
  );
}

/** One fixed-point crop entirely inside another. */
export function cropContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x0 >= outer.x0 &&
    inner.y0 >= outer.y0 &&
    inner.x1 <= outer.x1 &&
    inner.y1 <= outer.y1
  );
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
