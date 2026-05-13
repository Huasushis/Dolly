import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DollyModule, ModuleContext } from "../../../src/modules/base.js";
import type { BlockChange, BlockMutation } from "../../../src/blocks/index.js";
import { setMcpTools } from "../skill/index.js";

interface McpServerConfig { command: string; args: string[]; env?: Record<string, string>; }
interface ConnInfo { client: Client; transport: StdioClientTransport; tools: Map<string, any>; }

let ctx: ModuleContext;
let connections = new Map<string, ConnInfo>();

const mcpModule: DollyModule = {
  id: "builtin/mcp",

  async init(c: ModuleContext) {
    ctx = c;
    // Load mcp.json
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

    // Notify skill module of available tools
    const allNames: string[] = [];
    for (const [, conn] of connections) for (const [t] of conn.tools) allNames.push(t);
    setMcpTools(allNames);
  },

  async onBlocksChanged(c: ModuleContext, changes: BlockChange[]): Promise<BlockMutation[]> {
    ctx = c;
    return [];
  },
};

// Handle tool calls (called from main.ts when tool.call_requested fires)
export async function handleMcpCall(fullName: string, params: Record<string, unknown>): Promise<string> {
  const dot = fullName.indexOf(".");
  if (dot === -1) return JSON.stringify({ error: `invalid MCP tool: ${fullName}` });
  const serverName = fullName.slice(0, dot);
  const toolName = fullName.slice(dot + 1);
  const conn = connections.get(serverName);
  if (!conn) return JSON.stringify({ error: `MCP server not found: ${serverName}` });
  try {
    const result = await conn.client.callTool({ name: toolName, arguments: params });
    const texts = (result.content as any[]).filter((i: any) => i.type === "text").map((i: any) => i.text);
    return texts.join("\n") || JSON.stringify(result.content);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export default mcpModule;
