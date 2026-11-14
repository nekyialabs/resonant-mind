// HTTP handler for /api/identity — extracted from src/index.ts.
import { jsonResponse } from "../response";
import type { Env } from "../../types";
import { dict } from "../../shared/dict";

export async function handleApiIdentity(request: Request, env: Env, pathParts: string[]): Promise<Response> {
  const method = request.method;
  const section = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;

  // GET /api/identity - list all sections
  if (method === "GET" && !section) {
    const results = await env.DB.prepare(
      "SELECT id, section, content, weight, connections, timestamp FROM identity WHERE archived_at IS NULL ORDER BY section"
    ).all();

    // Build tree structure from dot-notation sections
    const tree: Record<string, unknown[]> = dict<unknown[]>();
    for (const row of results.results || []) {
      const r = row as { section: string; [k: string]: unknown };
      const parts = r.section.split('.');
      const root = parts[0];
      if (!tree[root]) tree[root] = [];
      tree[root].push(row);
    }

    return jsonResponse({ entries: results.results, tree });
  }

  // GET /api/identity/:section - get specific section
  if (method === "GET" && section) {
    // Support wildcards like 'core.*'
    const query = section.includes('*')
      ? `SELECT * FROM identity WHERE section LIKE ? AND archived_at IS NULL ORDER BY weight DESC`
      : `SELECT * FROM identity WHERE section = ? AND archived_at IS NULL`;
    const binding = section.includes('*') ? section.replace('*', '%') : section;
    const results = await env.DB.prepare(query).bind(binding).all();
    return jsonResponse(results.results);
  }

  // POST /api/identity - create new section
  if (method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const result = await env.DB.prepare(
      "INSERT INTO identity (section, content, weight, connections) VALUES (?, ?, ?, ?)"
    ).bind(body.section, body.content, body.weight || 1.0, body.connections || null).run();
    return jsonResponse({ id: result.meta.last_row_id, ...body }, 201);
  }

  // PUT /api/identity/:section - update section
  if (method === "PUT" && section) {
    const body = await request.json() as Record<string, unknown>;
    await env.DB.prepare(
      "UPDATE identity SET content = ?, weight = ?, connections = ? WHERE section = ?"
    ).bind(body.content, body.weight, body.connections || null, section).run();
    return jsonResponse({ section, ...body });
  }

  // DELETE /api/identity/:section — SOFT archive (soft-delete by design).
  // Was a raw hard DELETE — the exact second-door landmine the collision audit
  // Part 0 warned about, coexisting with spine_amend{remove}'s soft archive on
  // the same table. Identity rows are identity: they fade, they don't vanish.
  if (method === "DELETE" && section) {
    const result = await env.DB.prepare(
      "UPDATE identity SET archived_at = NOW() WHERE section = ? AND archived_at IS NULL"
    ).bind(section).run();
    return jsonResponse({ archived: true, rows: result.meta.changes ?? 0 });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
