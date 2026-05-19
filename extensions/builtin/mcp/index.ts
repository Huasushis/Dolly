import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";

interface McpServerConfig { command: string; args: string[]; env?: Record<string, string>; }
interface ConnInfo { client: Client; transport: StdioClientTransport; tools: Map<string, any>; }

let ctx: ModuleContext;
let connections = new Map<string, ConnInfo>();

const mcpModule: DollyModule = {
  id: "builtin/mcp",

  async init(c: ModuleContext) {
    ctx = c;
    const mcpPath = resolve(import.meta.dirname!, "..", "..", "..", "mcp.json");
    if (!existsSync(mcpPath)) return;

    const config = JSON.parse(readFileSync(mcpPath, "utf-8"));
    for (const [name, cfg] of Object.entries(config.servers || {}) as any) {
      try {
        const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env });
        const client = new Client({ name: "dolly", version: "0.1.0" }, { capabilities: {} });
        await client.connect(transport);
        const toolsResult = await client.listTools();
        const tools = new Map<string, any>();
        for (const t of toolsResult.tools) tools.set(`${name}.${t.name}`, t);
        connections.set(name, { client, transport, tools });
      } catch (err: any) {
        console.error(`[MCP] ${name}: ${err.message}`);
      }
    }

    // Add available tools to system prompt
    const allDesc: string[] = [];
    for (const [, conn] of connections) for (const [t, info] of conn.tools) {
      allDesc.push(`  - ${t}: ${(info as any).description || ""}`);
    }
    if (allDesc.length > 0) {
      c.setSystemPrompt(`你可以使用 fenced JSON 调用工具：
\`\`\`json
{"tool":"工具名","params":{...}}
\`\`\`
可用 MCP 工具:
${allDesc.join("\n")}`);
    }
  },

  async handleCli(args: string[], _c: ModuleContext) {
    if (args[0] === "reload") {
      // Close and reconnect all
      for (const [name, conn] of connections) {
        try { await conn.transport.close(); } catch {}
      }
      connections.clear();
      if (mcpModule.init) await mcpModule.init(_c);
      process.stdout.write(`${connections.size} MCP servers reconnected\n`);
    } else if (args[0] === "list") {
      for (const [name, conn] of connections) {
        for (const [t] of conn.tools) process.stdout.write(`${t}\n`);
      }
    } else if (args[0] === "status") {
      process.stdout.write(`${connections.size} MCP servers connected\n`);
      for (const [name] of connections) process.stdout.write(`  ${name}\n`);
    }
  },

  async onBlocksChanged(c: ModuleContext, _changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    return [];
  },
};

export async function handleMcpCall(fullName: string, params: Record<string, unknown>): Promise<string> {
  const dot = fullName.indexOf(".");
  if (dot !== -1) {
    const serverName = fullName.slice(0, dot);
    const toolName = fullName.slice(dot + 1);
    const conn = connections.get(serverName);
    if (conn) return callTool(conn, toolName, params);
  }

  for (const [serverName, conn] of connections) {
    if (conn.tools.has(`${serverName}.${fullName}`) || conn.tools.has(fullName)) {
      return callTool(conn, fullName.includes(".") ? fullName.split(".").pop()! : fullName, params);
    }
  }

  return JSON.stringify({ error: `MCP tool not found: ${fullName}` });
}

async function callTool(conn: any, toolName: string, params: Record<string, unknown>): Promise<string> {
  try {
    const result = await conn.client.callTool({ name: toolName, arguments: params });
    const texts = (result.content as any[]).filter((i: any) => i.type === "text").map((i: any) => i.text);
    return texts.join("\n") || JSON.stringify(result.content);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export default mcpModule;
