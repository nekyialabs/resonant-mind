/**
 * handleMindListEntities — list entities, optionally filtered by type or
 * by observation context.
 *
 * A flat directory of who/what the mind tracks. Cheap, read-only.
 *
 * The engine under regions/network.ts's `graph_survey` verb (Gate A, Mind
 * Reshape 2). Stays here as the implementation; the MCP surface is the
 * region facade, not this file directly.
 */

import type { Env } from "../types";
import { clampLimit } from "../shared/limits";

export async function handleMindListEntities(env: Env, params: Record<string, unknown>): Promise<string> {
  const entityType = params.entity_type as string;
  const context = params.context as string;
  const limit = clampLimit(params.limit, 50);

  // If context is specified, find entities that have observations in that context
  if (context) {
    const results = await env.DB.prepare(`
      SELECT DISTINCT e.name, e.entity_type, e.primary_context, e.created_at
      FROM entities e
      JOIN observations o ON o.entity_id = e.id
      WHERE o.context = ?
      ${entityType ? 'AND e.entity_type = ?' : ''}
      ORDER BY e.created_at DESC
      LIMIT ?
    `).bind(...(entityType ? [context, entityType, limit] : [context, limit])).all();

    if (!results.results?.length) {
      return `No entities found with observations in context '${context}'.`;
    }

    let output = `## Entities (with observations in '${context}')\n\n`;
    for (const e of results.results as any[]) {
      output += '- **' + e.name + '** [' + e.entity_type + ']\n';
    }
    output += '\nTotal: ' + results.results.length + ' entities';
    return output;
  }

  // Otherwise list all entities
  let query = 'SELECT name, entity_type, primary_context, created_at FROM entities';
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (entityType) {
    conditions.push('entity_type = ?');
    bindings.push(entityType);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  const stmt = env.DB.prepare(query);
  const results = await stmt.bind(...bindings).all();

  if (!results.results?.length) {
    return 'No entities found.';
  }

  let output = '## Entities\n\n';
  for (const e of results.results as any[]) {
    output += '- **' + e.name + '** [' + e.entity_type + '] primary: ' + e.primary_context + '\n';
  }
  output += '\nTotal: ' + results.results.length + ' entities';
  return output;
}
