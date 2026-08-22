/**
 * Host-internal native SQLite loader/attestation adapter for the shared
 * Runtime SQLite authority database (ADR 0015, REQ-TECH-003, ADR 0006).
 *
 * This slice implements only the dependency/attestation bridge, not the
 * H1 schema or migration. Every durable-conformance build must embed and use
 * an upstream SQLite whose runtime version is at least 3.51.3 and whose
 * loaded identity matches the release attestation before writable startup
 * (REQ-TECH-003). The pinned better-sqlite3 12.9.0 prebuild embeds SQLite
 * 3.53.0, so the loader requires exactly that version AND the floor.
 *
 * Fail-closed ordering:
 *   1. Attestation always runs against an in-memory database first, so no
 *      persistent path is created or touched unless the loaded library
 *      already satisfies version and compile-option checks.
 *   2. A persistent connection is opened only after attestation passes, then
 *      the required durable PRAGMAs are set and read back before the handle
 *      is returned.
 *
 * There is deliberately no fallback to a system SQLite, `node:sqlite`, or any
 * dynamically selected backend: the binding seam imports the pinned
 * better-sqlite3 statically, and any mismatch or load failure refuses startup.
 */
import { openNativeSqlite, type NativeSqliteConnection } from "./native-sqlite-binding.js";

/** Pinned runtime version string, byte-for-byte, from better-sqlite3 12.9.0's bundled SQLite 3.53.0. */
export const SQLITE_VERSION_EXACT = "3.53.0";

/** Numeric form of `SQLITE_VERSION_EXACT` using SQLite's own encoding: major*1e6 + minor*1e3 + patch. */
export const SQLITE_VERSION_NUMBER_EXACT = 3_053_000;

/**
 * Absolute spec floor from REQ-TECH-003 / ADR 0006:
 * `sqlite3_libversion_number() >= 3051003` (3.51.3). Do not lower it; the
 * WAL-reset race motivating the floor exists through 3.51.2.
 */
export const SQLITE_VERSION_NUMBER_MIN = 3_051_003;

/** `PRAGMA busy_timeout` milliseconds fixed by the storage spec. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Compile options the durable profile depends on, each of which MUST be
 * present in the sorted `PRAGMA compile_options` of the loaded library.
 * These are the spec-required set; a substituted build missing any of them
 * cannot deliver the required PRAGMA profile.
 */
export const REQUIRED_SQLITE_COMPILE_OPTIONS: readonly string[] = Object.freeze([
  "THREADSAFE=2",
  "DEFAULT_FOREIGN_KEYS",
  "DEFAULT_SYNCHRONOUS=2",
  "DEFAULT_WAL_SYNCHRONOUS=1",
]);

/**
 * Compile options that MUST be absent. These options describe a build that
 * cannot implement the required durable profile (WAL journal, foreign-key
 * enforcement, PRAGMA control, trusted-schema control).
 */
export const FORBIDDEN_SQLITE_COMPILE_OPTIONS: readonly string[] = Object.freeze([
  "OMIT_WAL",
  "OMIT_FOREIGN_KEYS",
  "OMIT_PRAGMA",
  "THREADSAFE=0",
]);

export type NativeSqliteErrorCode =
  | "STORAGE_UNSAFE_SQLITE_BUILD"
  | "STORAGE_UNSAFE_CONFIGURATION"
  | "NATIVE_SQLITE_UNAVAILABLE";

export class NativeSqliteError extends Error {
  constructor(readonly code: NativeSqliteErrorCode, message: string) {
    super(message);
    this.name = "NativeSqliteError";
  }
}

/** Verified identity of the loaded native SQLite library. */
export interface NativeSqliteAttestation {
  readonly version: string;
  readonly versionNumber: number;
  readonly sourceId: string;
  /** Sorted `PRAGMA compile_options` rows of the loaded library. */
  readonly compileOptions: readonly string[];
}

/** An opened, attested connection with its verified identity. */
export interface AttestedNativeSqlite {
  readonly database: NativeSqliteConnection;
  readonly attestation: NativeSqliteAttestation;
  close(): void;
}

/** Splits "3.53.0" into SQLite's numeric version encoding, or returns 0 if malformed. */
export function parseSqliteVersionNumber(version: string): number {
  const parts = version.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/u.test(part))) {
    return 0;
  }
  const [major, minor, patch] = parts.map((part) => Number(part));
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * Reads the loaded library's identity from an open connection. This is the
 * only place the loader touches a live connection for identity data; the
 * enclosing caller holds an in-memory probe here so no persistent path is
 * mutated before a check runs.
 */
export function readNativeSqliteAttestation(connection: NativeSqliteConnection): NativeSqliteAttestation {
  const identity = connection.prepare(
    "SELECT sqlite_version() AS version, sqlite_source_id() AS source_id",
  ).get();
  const version = String(identity?.version ?? "");
  const sourceId = String(identity?.source_id ?? "");
  const rows = connection.pragma("compile_options") as Array<{ compile_options: string }>;
  const compileOptions = (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.compile_options ?? ""))
    .filter((option) => option.length > 0)
    .sort();
  return { version, versionNumber: parseSqliteVersionNumber(version), sourceId, compileOptions };
}

/**
 * Verifies a loaded library's identity against the pinned release
 * attestation. Throws `STORAGE_UNSAFE_SQLITE_BUILD` on any mismatch; there is
 * no writable override.
 */
export function verifyNativeSqliteAttestation(attestation: NativeSqliteAttestation): void {
  if (attestation.version !== SQLITE_VERSION_EXACT || attestation.versionNumber < SQLITE_VERSION_NUMBER_MIN) {
    throw new NativeSqliteError(
      "STORAGE_UNSAFE_SQLITE_BUILD",
      `Loaded SQLite ${attestation.version || "(none)"} (v${attestation.versionNumber}) does not match pinned ` +
        `${SQLITE_VERSION_EXACT} (v${SQLITE_VERSION_NUMBER_EXACT}, floor ${SQLITE_VERSION_NUMBER_MIN})`,
    );
  }
  const compileOptions = attestation.compileOptions;
  const missing = REQUIRED_SQLITE_COMPILE_OPTIONS.filter((option) => !compileOptions.includes(option));
  if (missing.length > 0) {
    throw new NativeSqliteError(
      "STORAGE_UNSAFE_SQLITE_BUILD",
      `Loaded SQLite is missing required compile options: ${missing.join(", ")}`,
    );
  }
  const present = FORBIDDEN_SQLITE_COMPILE_OPTIONS.filter((option) => compileOptions.includes(option));
  if (present.length > 0) {
    throw new NativeSqliteError(
      "STORAGE_UNSAFE_SQLITE_BUILD",
      `Loaded SQLite has forbidden compile options: ${present.join(", ")}`,
    );
  }
}

export interface DurableProfile {
  readonly foreignKeys: boolean | number;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly trustedSchema: number;
  readonly busyTimeout: number;
}

/**
 * Sets and reads back the required durable PRAGMAs from a live connection.
 * Any readback mismatch throws `STORAGE_UNSAFE_CONFIGURATION`; the caller
 * closes the connection after a failure so a non-conforming build is never
 * handed to code that would write through it.
 */
export function verifyDurablePragmas(connection: NativeSqliteConnection): DurableProfile {
  connection.pragma("foreign_keys = ON");
  connection.pragma("journal_mode = WAL");
  connection.pragma("synchronous = FULL");
  connection.pragma("trusted_schema = OFF");
  connection.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const foreignKeys = connection.pragma("foreign_keys", { simple: true });
  const journalMode = connection.pragma("journal_mode", { simple: true });
  const synchronous = connection.pragma("synchronous", { simple: true });
  const trustedSchema = connection.pragma("trusted_schema", { simple: true });
  const busyTimeout = connection.pragma("busy_timeout", { simple: true });
  const profile: DurableProfile = {
    foreignKeys: Number(foreignKeys),
    journalMode: String(journalMode),
    synchronous: Number(synchronous),
    trustedSchema: Number(trustedSchema),
    busyTimeout: Number(busyTimeout),
  };
  const ok =
    profile.foreignKeys === 1 &&
    profile.journalMode === "wal" &&
    profile.synchronous === 2 &&
    profile.trustedSchema === 0 &&
    profile.busyTimeout === BUSY_TIMEOUT_MS;
  if (!ok) {
    throw new NativeSqliteError(
      "STORAGE_UNSAFE_CONFIGURATION",
      `Connection did not retain the required durable PRAGMAs: ${JSON.stringify(profile)}`,
    );
  }
  return profile;
}

/**
 * Attests the loaded native SQLite build against the pinned release without
 * touching any persistent path: an in-memory connection is opened, verified,
 * and closed. Throws `STORAGE_UNSAFE_SQLITE_BUILD` on mismatch.
 */
export function attestNativeSqliteBuild(): NativeSqliteAttestation {
  const probe = openNativeSqlite(":memory:");
  try {
    const attestation = readNativeSqliteAttestation(probe);
    verifyNativeSqliteAttestation(attestation);
    return attestation;
  } finally {
    probe.close();
  }
}

/**
 * Opens a connection and returns it only after (1) the loaded build passed
 * the in-memory attestation and (2) the required durable PRAGMAs were set and
 * read back. For `":memory:"` the PRAGMA verification step is skipped because
 * journal mode is meaningless there; a persistent path is never opened before
 * attestation passes, so a failing check leaves no file behind.
 */
export function openAttestedNativeSqlite(filename: string): AttestedNativeSqlite {
  const attestation = attestNativeSqliteBuild();
  const database = openNativeSqlite(filename);
  if (filename !== ":memory:") {
    try {
      verifyDurablePragmas(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  return {
    database,
    attestation,
    close: () => database.close(),
  };
}
