import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

/** Returns today's date string in YYYY-MM-DD format (local time). */
function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface DailyRotateOptions {
  logDir: string;
}

/**
 * Pino transport: rotates log file by date.
 * File pattern: `<logDir>/YYYY-MM-DD.log`
 */
export default function dailyRotateTransport(opts: DailyRotateOptions): Writable {
  mkdirSync(opts.logDir, { recursive: true });

  let currentDate = todayStr();
  let stream: WriteStream = createWriteStream(
    join(opts.logDir, `${currentDate}.log`),
    { flags: "a" },
  );

  return new Writable({
    write(chunk, _encoding, callback) {
      const today = todayStr();
      if (today !== currentDate) {
        currentDate = today;
        stream.end();
        stream = createWriteStream(
          join(opts.logDir, `${currentDate}.log`),
          { flags: "a" },
        );
      }
      stream.write(chunk, callback);
    },
    final(callback) {
      stream.end(callback);
    },
  });
}
