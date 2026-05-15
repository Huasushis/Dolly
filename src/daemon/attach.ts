import { createServer, Socket } from "net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { resolve } from "path";

const SOCKET_DIR = resolve(import.meta.dirname!, "..", "..", ".dolly", "sockets");

/** Start a TCP relay so clients can attach */
export function startRelay(name: string, onConnect: (socket: Socket) => void) {
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

/** Wait for daemon's port file to appear (max 30s) */
export async function waitForPort(name: string): Promise<void> {
  const portFile = resolve(SOCKET_DIR, `${name}.port`);
  for (let i = 0; i < 300; i++) {
    if (existsSync(portFile)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for daemon "${name}" to start`);
}

/** Connect to a running daemon and forward stdin/stdout */
export function attachClient(name: string): void {
  const portFile = resolve(SOCKET_DIR, `${name}.port`);
  if (!existsSync(portFile)) {
    console.log(`Not running: ${name}`);
    process.exit(1);
  }
  const port = parseInt(readFileSync(portFile, "utf-8"));
  const socket = new (require("net").Socket)();
  socket.connect(port, "127.0.0.1", () => {
    process.stdin.setRawMode?.(true);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on("close", () => {
      process.stdin.setRawMode?.(false);
      process.exit(0);
    });
  });
}

export function cleanupRelay(name: string) {
  const portFile = resolve(SOCKET_DIR, `${name}.port`);
  try { unlinkSync(portFile); } catch {}
}
