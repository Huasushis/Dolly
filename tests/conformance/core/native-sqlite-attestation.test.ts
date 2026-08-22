/**
 * Focused fail-safe tests for the Host-internal native SQLite
 * loader/attestation adapter (ADR 0015, REQ-TECH-003, ADR 0006).
 *
 * The loader must never create or mutate a persistent path before the loaded
 * build passes version and compile-option attestation, and must never hand a
 * handler to code that would write through a connection that did not retain
 * the required durable PRAGMAs. The binding seam in `native-sqlite-binding.ts`
 * is the only place the real better-sqlite3 runs, so these tests substitute a
 * fake connection there — the same injectable-seam pattern used for host
 * platform observation — and assert that no caller, platform value, or
 * configuration document can weaken the gate. The real prebuild itself is
 * exercised by the package-install-smoke consumer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSqliteConnection } from "../../../src/adapters/storage/native-sqlite-binding.js";

interface FakeConnection extends NativeSqliteConnection {
  readonly name: string;
  closed: boolean;
  pragmaCalls: string[];
  setCalls: string[];
  setPragma(name: string, value: unknown): void;
  exec(source: string): FakeConnection;
  prepare(source: string): { get(): Record<string, unknown> | undefined };
  close(): FakeConnection;
}

interface MockOpen {
  (filename: string): FakeConnection;
  mockClear(): void;
}

const sealMock = vi.hoisted((): {
  opened: string[];
  connection: FakeConnection | undefined;
  setConnection: (next: FakeConnection) => void;
  open: MockOpen;
} => ({
  opened: [] as string[],
  connection: undefined as FakeConnection | undefined,
  setConnection(next: FakeConnection) {
    sealMock.connection = next;
  },
  open: vi.fn((filename: string) => {
    sealMock.opened.push(filename);
    if (!sealMock.connection) {
      throw new Error(`no fake connection configured for ${filename}`);
    }
    return sealMock.connection;
  }),
}));

vi.mock("../../../src/adapters/storage/native-sqlite-binding.js", () => ({
  openNativeSqlite: sealMock.open,
}));

import {
  BUSY_TIMEOUT_MS,
  FORBIDDEN_SQLITE_COMPILE_OPTIONS,
  REQUIRED_SQLITE_COMPILE_OPTIONS,
  SQLITE_VERSION_EXACT,
  verifyDurablePragmas,
} from "../../../src/adapters/storage/native-sqlite.js";
import { attestNativeSqliteBuild, openAttestedNativeSqlite } from "../../../src/adapters/storage/native-sqlite.js";

const PINNED_COMPILE_OPTIONS = [
  ...REQUIRED_SQLITE_COMPILE_OPTIONS,
  "ENABLE_FTS5",
  "ENABLE_RTREE",
  "OMIT_DEPRECATED",
].sort();

function makeConnection(overrides: {
  version?: string;
  sourceId?: string;
  compileOptions?: string[];
  pragmaValues?: Record<string, unknown>;
} = {}) {
  const observed: Record<string, unknown> = {};
  const forced: Record<string, unknown> = { ...(overrides.pragmaValues ?? {}) };
  const connection = {
    name: ":memory:",
    open: true,
    closed: false,
    pragmaCalls: [] as string[],
    setCalls: [] as string[],
    setPragma(name: string, value: unknown) {
      forced[name] = value;
    },
    prepare(source: string) {
      if (source.includes("sqlite_version")) {
        return {
          get: () => ({
            version: overrides.version ?? SQLITE_VERSION_EXACT,
            source_id: overrides.sourceId ?? "fake-source-id",
          }),
        };
      }
      return { get: () => undefined };
    },
    pragma(source: string, options?: { simple?: boolean }) {
      connection.pragmaCalls.push(source);
      const [name, value] = source.split("=").map((part) => part.trim());
      if (value) {
        // A real better-sqlite3/SQLite normalizes the readback; mirror it.
        observed[name] =
          name === "journal_mode"
            ? String(value).toLowerCase()
            : name === "busy_timeout"
              ? Number(value)
              : name === "trusted_schema"
                ? String(value).toUpperCase() === "OFF"
                  ? 0
                  : 1
                : name === "foreign_keys"
                  ? 1
                  : name === "synchronous"
                    ? 2
                    : value;
        connection.setCalls.push(source);
        return [];
      }
      if (name === "compile_options") {
        const options_ = (overrides.compileOptions ?? PINNED_COMPILE_OPTIONS).map((option) => ({ compile_options: option }));
        return options?.simple ? options_.map((row) => row.compile_options) : options_;
      }
      const stored = Object.hasOwn(forced, name) ? forced[name] : observed[name];
      return options?.simple ? stored : [{ [name]: stored }];
    },
    exec(source: string) {
      return connection;
    },
    close() {
      connection.closed = true;
      connection.open = false;
      return connection;
    },
  };
  return connection;
}

describe("native SQLite loader attestation", () => {
  beforeEach(() => {
    sealMock.opened.length = 0;
    sealMock.open.mockClear();
    sealMock.setConnection(makeConnection());
  });

  it("fails closed on a version below the pinned release before opening any persistent path", () => {
    sealMock.setConnection(makeConnection({ version: "3.52.0" }));
    expect(() => attestNativeSqliteBuild()).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_SQLITE_BUILD" }),
    );
    expect(sealMock.opened).toEqual([":memory:"]);
  });

  it("fails closed on a missing required compile option before any persistent path", () => {
    sealMock.setConnection(
      makeConnection({
        compileOptions: [...PINNED_COMPILE_OPTIONS.filter((option) => !option.startsWith("THREADSAFE"))].sort(),
      }),
    );
    expect(() => attestNativeSqliteBuild()).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_SQLITE_BUILD" }),
    );
    expect(sealMock.opened).toEqual([":memory:"]);
  });

  it("fails closed when a forbidden compile option is present", () => {
    sealMock.setConnection(
      makeConnection({ compileOptions: [...PINNED_COMPILE_OPTIONS, "OMIT_WAL"].sort() }),
    );
    expect(() => attestNativeSqliteBuild()).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_SQLITE_BUILD" }),
    );
    expect(sealMock.opened).toEqual([":memory:"]);
  });

  it("fails closed when a durable PRAGMA is not retained", () => {
    const connection = makeConnection({ pragmaValues: { journal_mode: "memory" } });
    expect(() => verifyDurablePragmas(connection)).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_CONFIGURATION" }),
    );
  });

  it("fails closed in openAttestedNativeSqlite and closes the connection when PRAGMAs are not retained", () => {
    sealMock.setConnection(
      makeConnection({
        pragmaValues: {
          journal_mode: "wal",
          synchronous: 1, // FULL must read back as 2
          foreign_keys: 1,
          trusted_schema: 0,
          busy_timeout: BUSY_TIMEOUT_MS,
        },
      }),
    );
    expect(() => openAttestedNativeSqlite("/tmp/native-sqlite-attested.db")).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_CONFIGURATION" }),
    );
    // The persistent connection was closed after the failed verify.
    expect(sealMock.connection?.closed).toBe(true);
  });

  it("opens a persistent database only after attestation passes", () => {
    const fake = sealMock.connection!;
    const handle = openAttestedNativeSqlite("/tmp/native-sqlite-attested.db");
    expect(sealMock.opened).toEqual([":memory:", "/tmp/native-sqlite-attested.db"]);
    expect(handle.attestation.version).toBe(SQLITE_VERSION_EXACT);
    expect(handle.attestation.compileOptions).toEqual(PINNED_COMPILE_OPTIONS);
    // Every required durable PRAGMA was set through the connection.
    expect(fake.setCalls).toEqual([
      "foreign_keys = ON",
      "journal_mode = WAL",
      "synchronous = FULL",
      "trusted_schema = OFF",
      `busy_timeout = ${BUSY_TIMEOUT_MS}`,
    ]);
    handle.close();
    expect(handle.database.open).toBe(false);
  });

  it("allows an in-memory database without the durable PRAGMA profile", () => {
    const handle = openAttestedNativeSqlite(":memory:");
    expect(handle.attestation.version).toBe(SQLITE_VERSION_EXACT);
    handle.close();
  });

  it("rejects a version matching the floor rules but before the pinned release", () => {
    sealMock.setConnection(makeConnection({ version: "3.51.3" }));
    expect(() => attestNativeSqliteBuild()).toThrow(
      expect.objectContaining({ code: "STORAGE_UNSAFE_SQLITE_BUILD" }),
    );
  });

  it("freezes the fixed busy timeout and required/forbidden option contracts", () => {
    expect(BUSY_TIMEOUT_MS).toBe(5000);
    expect(REQUIRED_SQLITE_COMPILE_OPTIONS).toContain("THREADSAFE=2");
    expect(FORBIDDEN_SQLITE_COMPILE_OPTIONS).toContain("OMIT_WAL");
  });
});
