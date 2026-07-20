import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
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
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
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
      const record = daemon.startInstance(body.configPath);
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
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
    return;
  }

  // ── Static Files (Web Panel) ────────────────────────────────

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  serveStatic(res, resolve(WEB_DIR, "." + filePath));
}
