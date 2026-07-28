import pino from "pino";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

export interface LoggerOptions {
  level: string;
  logDir?: string;
}

export type Logger = pino.Logger & {
  close(): Promise<void>;
};

/**
 * Get today's date string for log file naming.
 */
function getDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Creates a Writable stream that rotates log files by date at write time.
 * On each write, checks if the date has changed; if so, closes the old
 * stream and opens a new file. Runs in the main thread (no worker),
 * avoiding pino custom transport crashes on Linux (see TASK_HANDOVER).
 */
function createDailyRotateStream(logDir: string): Writable {
  mkdirSync(logDir, { recursive: true });

  let currentDate = getDateString();
  let stream: WriteStream = createWriteStream(join(logDir, `${currentDate}.log`), { flags: "a" });

  return new Writable({
    write(chunk, _encoding, callback) {
      const today = getDateString();
      if (today !== currentDate) {
        currentDate = today;
        stream.end();
        stream = createWriteStream(join(logDir, `${currentDate}.log`), { flags: "a" });
      }
      stream.write(chunk, callback);
    },
    final(callback) {
      stream.end(callback);
    },
  });
}

/**
 * Create a logger with date-based file rotation.
 * - Console output via pino-pretty
 * - File output to <logDir>/<date>.log (appended, rotated daily at write time)
 *
 * Uses a main-thread Writable stream for file rotation to avoid
 * pino worker-thread transport crashes (see TASK_HANDOVER).
 */
export function createLogger(options: LoggerOptions): Logger {
  const { level, logDir } = options;

  if (logDir) {
    const rotateStream = createDailyRotateStream(logDir);
    // Use pino.multistream: pretty console + rotating file, all in main thread
    const streams = [
      { stream: process.stderr },
      { level: "trace" as const, stream: rotateStream },
    ];
    const logger = pino({ level }, pino.multistream(streams)) as Logger;
    let closePromise: Promise<void> | undefined;
    logger.close = () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        rotateStream.once("error", onError);
        rotateStream.end(() => {
          rotateStream.off("error", onError);
          resolve();
        });
      });
      return closePromise;
    };
    return logger;
  }

  const logger = pino({ level }, process.stderr) as Logger;
  logger.close = async () => {
    await new Promise<void>((resolve, reject) => {
      logger.flush((error) => (error ? reject(error) : resolve()));
    });
  };
  return logger;
}
