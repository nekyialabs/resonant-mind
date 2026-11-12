import { describe, expect, it, vi } from 'vitest';
import { handleMcpProtocolRequest } from '../src/mcp/protocol';
import type { Env, MCPToolHandlerMap } from '../src/types';

const env = {} as Env;
const rawRequest = (body: string) => new Request('https://mind.example/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
const request = (body: Record<string, unknown>) => rawRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }));
const options = (toolHandlers: MCPToolHandlerMap = {}) => ({
  serverName: 'resonant-mind',
  serverVersion: '4.0.0',
  tools: [],
  toolHandlers,
});

async function responseBody(response: Response) {
  return response.json() as Promise<{
    jsonrpc?: string;
    id?: string | number | null;
    error?: { code: number; message: string };
    result?: { content?: Array<{ type: string; text: string }> };
  }>;
}

describe('MCP protocol errors', () => {
  it('returns a parse error for malformed JSON without leaking the parser exception', async () => {
    const response = await handleMcpProtocolRequest(rawRequest('{"jsonrpc":"2.0",'), env, options());

    expect(await responseBody(response)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it.each([
    ['missing', {}],
    ['null', { method: null }],
    ['numeric', { method: 42 }],
  ])('returns invalid request when method is %s', async (_label, body) => {
    const response = await handleMcpProtocolRequest(request(body), env, options());

    expect((await responseBody(response)).error).toEqual({
      code: -32600,
      message: 'Invalid Request',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'not-an-object'],
    ['an array', []],
  ])('returns invalid params when params is %s', async (_label, params) => {
    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params }),
      env,
      options(),
    );

    expect((await responseBody(response)).error).toEqual({
      code: -32602,
      message: 'Invalid params',
    });
  });

  it('preserves expected request validation errors', async () => {
    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params: {} }),
      env,
      options(),
    );

    expect((await responseBody(response)).error).toEqual({
      code: -32602,
      message: 'Tool name is required',
    });
  });

  it('sanitizes unexpected tool failures for clients and logs the original error', async () => {
    const unexpected = new Error('postgres://user:password@private-host/internal_table');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params: { name: 'explode' } }),
      env,
      options({ explode: async () => { throw unexpected; } }),
    );

    expect((await responseBody(response)).error).toEqual({
      code: -32603,
      message: 'Internal error',
    });
    expect(consoleError).toHaveBeenCalledWith('MCP request failed', unexpected);
    consoleError.mockRestore();
  });

  it('returns ordinary tool validation messages unchanged', async () => {
    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params: { name: 'validate', arguments: {} } }),
      env,
      options({ validate: async () => 'Validation error: title is required' }),
    );

    expect((await responseBody(response)).result?.content).toEqual([
      { type: 'text', text: 'Validation error: title is required' },
    ]);
  });
  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'valueOf',
    'isPrototypeOf',
    'toLocaleString',
  ])('treats inherited property %s as an unknown tool', async (name) => {
    const real = vi.fn(async () => 'ok');
    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params: { name, arguments: {} } }),
      env,
      options({ real }),
    );

    expect((await responseBody(response)).error).toEqual({
      code: -32602,
      message: `Unknown tool: ${name}`,
    });
    expect(real).not.toHaveBeenCalled();
  });

  it('still calls a handler registered under its own name', async () => {
    const real = vi.fn(async () => 'ok');
    const response = await handleMcpProtocolRequest(
      request({ method: 'tools/call', params: { name: 'real', arguments: { a: 1 } } }),
      env,
      options({ real }),
    );

    expect((await responseBody(response)).result?.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(real).toHaveBeenCalledWith(env, { a: 1 });
  });
});
