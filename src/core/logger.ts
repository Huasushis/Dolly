import pino from "pino";
import { mkdirSync } from "node:fs";

export interface LoggerOptions {
  level: string;
  logDir?: string;
}

export type Logger = pino.Logger;

export function createLogger(options: LoggerOptions): Logger {
  const { level, logDir } = options;

  const targets: pino.TransportTargetOptions[] = [
    { target: "pino-pretty", level, options: { destination: 2 } },
  ];

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFile = `${logDir}/${timestamp}.jsonl`;
    targets.push({
      target: "pino/file",
      level: "trace",
      options: { destination: logFile },
    });
  }

  return pino({
    level,
    transport: { targets },
  });
}
