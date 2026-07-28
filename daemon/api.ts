import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, auth: { user: string; password: string }): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const [user, ...rest] = decoded.split(":");
  return user === auth.user && rest.join(":") === auth.password;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => res(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ── MIME types for static files ───────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const ext = extname(filePath);
  const contentType = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
}

// ── WebSocket Broadcaster (F5) ───────────────────────────────────

export interface WsMessage {
  type: string;
  data: unknown;
}

export class Broadcaster {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  get wssInstance(): WebSocketServer {
    return this.wss;
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  send(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

// Singleton broadcaster shared between api.ts and index.ts
export const broadcaster = new Broadcaster();

/** Handle HTTP upgrade → WebSocket (F5) */
export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  daemon: Daemon,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Auth: check Basic header or query param
  const authHeader = req.headers.authorization;
  let authenticated = false;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [user, ...rest] = decoded.split(":");
    authenticated = user === daemon.auth.user && rest.join(":") === daemon.auth.password;
  }
  if (!authenticated) {
    const token = url.searchParams.get("auth");
    if (token) {
      const decoded = Buffer.from(token, "base64").toString();
      const [user, ...rest] = decoded.split(":");
      authenticated = user === daemon.auth.user && rest.join(":") === daemon.auth.password;
    }
  }

  if (!authenticated) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  broadcaster.wssInstance.handleUpgrade(req, socket, head, (ws) => {
    broadcaster.addClient(ws);
    // Send initial state
    ws.send(JSON.stringify({ type: "instances", data: daemon.getStatus() }));
  });
}

// ── Request Handler ───────────────────────────────────────────────

const WEB_DIR = resolve(fileURLToPath(import.meta.url), "..", "web");

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  daemon: Daemon,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Health endpoint doesn't require auth
  if (url.pathname === "/api/health") {
    json(res, 200, { status: "ok", uptime: process.uptime() });
    return;
  }

  // Auth check for all other routes
  if (!checkAuth(req, daemon.auth)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Dolly Daemon"' });
    res.end("Unauthorized");
    return;
  }

  // ── API Routes ──────────────────────────────────────────────

  if (url.pathname === "/api/instances" && req.method === "GET") {
    json(res, 200, daemon.getStatus());
    return;
  }

  if (url.pathname === "/api/instances/start" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { configPath?: string };
      if (!body.configPath) {
        json(res, 400, { error: "configPath is required" });
        return;
      }
      const record = await daemon.startInstance(body.configPath);
      broadcaster.send({ type: "instances", data: daemon.getStatus() });
      json(res, 200, record);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/instances/stop" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { configPath?: string };
      if (!body.configPath) {
        json(res, 400, { error: "configPath is required" });
        return;
      }
      daemon.stopInstance(body.configPath);
      broadcaster.send({ type: "instances", data: daemon.getStatus() });
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/instances/restart" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { configPath?: string };
      if (!body.configPath) {
        json(res, 400, { error: "configPath is required" });
        return;
      }
      const record = await daemon.restartInstance(body.configPath);
      broadcaster.send({ type: "instances", data: daemon.getStatus() });
      json(res, 200, record);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  // ── Static Files (Web Panel) ────────────────────────────────

  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  serveStatic(res, resolve(WEB_DIR, "." + filePath));
}
