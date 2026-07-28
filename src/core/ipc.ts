import net from "node:net";
import { createHash } from "node:crypto";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

// ── Protocol Types ───────────────────────────────────────────────

export interface IpcRequest {
  id: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── Socket Path ──────────────────────────────────────────────────

/**
 * Compute the platform-specific IPC socket path for a given identifier.
 * Windows: \\.\pipe\dolly-<hash>
 * Linux/macOS: /tmp/dolly-<hash>.sock
 */
export function getIpcPath(id: string): string {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  if (platform() === "win32") {
    return `\\\\.\\pipe\\dolly-${hash}`;
  }
  return join(tmpdir(), `dolly-${hash}.sock`);
}

// ── IPC Server ───────────────────────────────────────────────────

export type IpcMessageHandler = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown> | unknown;

/**
 * JSON-over-socket IPC server.
 * Each message is a single line of JSON (newline-delimited).
 */
export class IpcServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private handler: IpcMessageHandler;

  constructor(socketPath: string, handler: IpcMessageHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.onConnection(socket));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server?.removeListener("error", reject);
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        this.handleLine(socket, line);
      }
    });

    socket.on("error", () => {
      /* connection reset — ignore */
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      return;
    }

    let response: IpcResponse;
    try {
      const result = await this.handler(req.command, req.params);
      response = { id: req.id, ok: true, result };
    } catch (err) {
      response = { id: req.id, ok: false, error: (err as Error).message };
    }

    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}

// ── IPC Client ───────────────────────────────────────────────────

/**
 * JSON-over-socket IPC client with request/response correlation.
 */
export class IpcClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> =
    new Map();
  private buffer = "";
  private reqCounter = 0;
  private connected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`IPC connect timeout: ${this.socketPath}`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        this.attach(socket);
        resolve();
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private attach(socket: net.Socket): void {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const res = JSON.parse(line) as IpcResponse;
          const p = this.pending.get(res.id);
          if (p) {
            this.pending.delete(res.id);
            if (res.ok) p.resolve(res.result);
            else p.reject(new Error(res.error ?? "IPC error"));
          }
        } catch {
          /* malformed — ignore */
        }
      }
    });

    socket.on("close", () => {
      this.connected = false;
      for (const [, p] of this.pending) p.reject(new Error("IPC connection closed"));
      this.pending.clear();
    });

    socket.on("error", () => {
      /* handled by close */
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  request(command: string, params?: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error("IPC not connected"));
    }
    const id = `r${++this.reqCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC request timeout: ${command}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.socket!.write(JSON.stringify({ id, command, params } satisfies IpcRequest) + "\n");
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.pending.clear();
  }
}
