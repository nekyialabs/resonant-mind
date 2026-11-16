export interface Env {
  DB: D1Database;
  HYPERDRIVE: Hyperdrive;
  VECTORS: VectorizeIndex;
  R2_IMAGES: R2Bucket;
  /** Workers AI — dream-work composition (one call/night). Structurally typed
   * to avoid pinning @cloudflare/workers-types' Ai interface version. */
  AI: { run(model: string, options: Record<string, unknown>): Promise<unknown> };
  GEMINI_API_KEY: string;
  MIND_API_KEY: string;
  SIGNING_SECRET?: string;
  WORKER_URL?: string;
  MCP_CONNECTOR_SECRET?: string;
  WEATHER_API_KEY?: string;
  LOCATION_NAME?: string;
  LOCATION_TIMEZONE?: string;
  DASHBOARD_ALLOWED_ORIGIN?: string;
  INTERNAL_KEY?: string;
  /** Auto-supersede similarity threshold: a number above 0 up to 1, or "off". Unset: 0.85. */
  AUTO_SUPERSEDE?: string;
  /** Bond warmth thresholds in days: "warm,cooling,cold". Unset: "1,4,14". */
  BOND_WARMTH_DAYS?: string;
}

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type MCPToolHandler = (
  env: Env,
  params: Record<string, unknown>
) => Promise<string>;

export type MCPToolHandlerMap = Record<string, MCPToolHandler>;
