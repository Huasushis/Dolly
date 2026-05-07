import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { EventBus } from "../core/bus.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: Map<string, { name: string; description: string; inputSchema: any }>;
}

/**
 * Manages MCP server connections.
 * Spawns each server as a child process, communicates via JSON-RPC over stdio.
 */
export class McpManager {
  private connections = new Map<string, McpConnection>();

  constructor(private bus: EventBus) {}

  async connect(config: McpServerConfig): Promise<string[]> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });

    const client = new Client(
      { name: "dolly", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    // Discover available tools
    const toolsResult = await client.listTools();
    const tools = new Map<string, any>();
    for (const tool of toolsResult.tools) {
      tools.set(`${config.name}.${tool.name}`, tool);
    }

    this.connections.set(config.name, { client, transport, tools });

    return Array.from(tools.keys());
  }

  async callTool(fullName: string, params: Record<string, unknown>): Promise<unknown> {
    // fullName format: "servername.toolname" or just "toolname"
    const dotIdx = fullName.indexOf(".");
    if (dotIdx === -1) {
      return { error: `MCP tool must be in format "server.tool", got: ${fullName}` };
    }

    const serverName = fullName.slice(0, dotIdx);
    const toolName = fullName.slice(dotIdx + 1);

    const conn = this.connections.get(serverName);
    if (!conn) {
      return { error: `MCP server not connected: ${serverName}` };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: params,
      });

      // Extract text content from MCP response
      const textParts: string[] = [];
      for (const item of result.content as any[]) {
        if (item.type === "text") textParts.push(item.text);
      }
      return textParts.join("\n") || JSON.stringify(result.content);
    } catch (err: any) {
      return { error: `MCP call failed: ${err.message}` };
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn) {
      await conn.client.close();
      this.connections.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.disconnect(name);
    }
  }

  listServers(): string[] {
    return Array.from(this.connections.keys());
  }

  getTools(): Array<{ server: string; name: string; description: string }> {
    const tools: Array<{ server: string; name: string; description: string }> = [];
    for (const [serverName, conn] of this.connections) {
      for (const [toolName, tool] of conn.tools) {
        tools.push({
          server: serverName,
          name: toolName,
          description: tool.description ?? "",
        });
      }
    }
    return tools;
  }
}
