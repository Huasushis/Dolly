import { createServer, Socket } from "net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";

const SOCKET_DIR = resolve(import.meta.dirname!, "..", "..", ".dolly", "sockets");

/** Start a TCP relay that mirrors the daemon's stdin/stdout */
import type { Server } from "net";

export function startRelay(name: string, onConnect: (socket: Socket) => void): Server {
  if (!existsSync(SOCKET_DIR)) mkdirSync(SOCKET_DIR, { recursive: true });

  const server = createServer((socket) => {
    socket.setEncoding("utf-8");
    onConnect(socket);
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as any;
    const portFile = resolve(SOCKET_DIR, `${name}.port`);
    writeFileSync(portFile, String(addr.port));
  });

  return server;
}

/** Connect to a running daemon */
export function attach(name = "default"): void {
  const portFile = resolve(SOCKET_DIR, `${name}.port`);
  if (!existsSync(portFile)) {
    console.log(`Not running: ${name}`);
    process.exit(1);
  }
  const port = parseInt(readFileSync(portFile, "utf-8"));
  const socket = new (require("net").Socket)();
  socket.connect(port, "127.0.0.1", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on("close", () => process.exit(0));
  });
}

export function cleanupRelay(name: string) {
  const portFile = resolve(SOCKET_DIR, `${name}.port`);
  try { unlinkSync(portFile); } catch {}
}
