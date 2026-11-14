import type {
  Env,
  MCPRequest,
  MCPResponse,
  MCPToolDefinition,
  MCPToolHandlerMap
} from "../types";

interface MCPProtocolOptions {
  serverName: string;
  serverVersion: string;
  tools: MCPToolDefinition[];
  toolHandlers: MCPToolHandlerMap;
}

class MCPProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export async function handleMcpProtocolRequest(
  request: Request,
  env: Env,
  options: MCPProtocolOptions
): Promise<Response> {
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    const response: MCPResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" }
    };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Partial<MCPRequest>
    : {};
  const id = body.id ?? null;

  let params: Record<string, unknown> = {};

  let result: unknown;

  try {
    if (typeof body.method !== "string") {
      throw new MCPProtocolError(-32600, "Invalid Request");
    }
    if (body.params !== undefined) {
      if (body.params === null || typeof body.params !== "object" || Array.isArray(body.params)) {
        throw new MCPProtocolError(-32602, "Invalid params");
      }
      params = body.params;
    }

    const { method } = body;
    if (method.startsWith("notifications/") || body.id === undefined) {
      return new Response(null, { status: 202 });
    }

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: options.serverName,
            version: options.serverVersion
          }
        };
        break;

      case "tools/list":
        result = { tools: options.tools };
        break;

      case "tools/call": {
        const toolName = (params as { name?: string }).name;
        if (!toolName) throw new MCPProtocolError(-32602, "Tool name is required");

        const toolHandler = Object.hasOwn(options.toolHandlers, toolName)
          ? options.toolHandlers[toolName]
          : undefined;
        if (typeof toolHandler !== "function") throw new MCPProtocolError(-32602, `Unknown tool: ${toolName}`);

        const toolParams =
          (params as { arguments?: Record<string, unknown> }).arguments ?? {};

        result = {
          content: [{ type: "text", text: await toolHandler(env, toolParams) }]
        };
        break;
      }

      default:
        throw new MCPProtocolError(-32601, `Unknown method: ${method}`);
    }

    const response: MCPResponse = { jsonrpc: "2.0", id, result };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    const expected = error instanceof MCPProtocolError;
    if (!expected) console.error("MCP request failed", error);
    const response: MCPResponse = {
      jsonrpc: "2.0",
      id,
      error: expected
        ? { code: error.code, message: error.message }
        : { code: -32603, message: "Internal error" }
    };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  }
}
