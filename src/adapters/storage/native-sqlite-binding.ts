/**
 * Host-internal seam where the better-sqlite3 native binding enters the
 * loader. Keeping the import here lets the conformance suite substitute a
 * fake connection without reimplementing or weakening the attestation gate
 * and without letting a caller, platform value, or configuration document
 * pick another SQLite backend.
 *
 * There is deliberately no fallback: no system SQLite, `node:sqlite`, dynamic
 * `require`, or runtime substitution is attempted here. A missing or broken
 * native binding surfaces as an import/load failure, which the loader wraps
 * and fails closed on.
 */
import Database from "better-sqlite3";

/**
 * The minimal structural surface the loader and its tests use. It is a
 * deliberately small subset of `better-sqlite3.Database`, so a conformance
 * fake can implement it without carrying the full native type.
 */
export interface NativeSqliteConnection {
  readonly name: string;
  readonly open: boolean;
  prepare(source: string): NativeSqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): unknown;
  close(): void;
}

export interface NativeSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

/**
 * Opens a connection to a SQLite database at `filename` (a filesystem path or
 * the string `":memory:"`) using the pinned better-sqlite3 12.9.0 binding.
 */
export function openNativeSqlite(filename: string): NativeSqliteConnection {
  return new Database(filename);
}
