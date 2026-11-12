/**
 * handleMindSurfaceSpark — random associative surfacing with hot-entity bias.
 * 20% chance to include archived observations bubbling up.
 */

import type { Env } from "../types";
import { getSubconsciousState } from "../daemon/state";
import { clampLimit } from "../shared/limits";

export async function handleMindSurfaceSpark(env: Env, params: Record<string, unknown>): Promise<string> {
  const count = clampLimit(params.limit, 5);
  const context = params.context as string;
  const weightBias = params.weight_bias as string;

  // 20% chance to include archived observations - old memories bubbling up
  const includeArchived = Math.random() < 0.2;
  const archivedFilter = includeArchived ? "" : "AND o.archived_at IS NULL";

  // Get hot entities from subconscious to bias selection
  const subconscious = await getSubconsciousState(env);
  const hotEntityNames = subconscious?.hot_entities?.slice(0, 5).map(e => e.name) || [];

  // Split count: half from hot entities, half random (if hot entities exist)
  const hotCount = hotEntityNames.length > 0 ? Math.ceil(count / 2) : 0;
  const randomCount = count - hotCount;

  let allResults: Array<Record<string, unknown>> = [];

  // Get sparks from hot entities first
  if (hotCount > 0 && hotEntityNames.length > 0) {
    const placeholders = hotEntityNames.map(() => '?').join(',');
    const hotQuery = `SELECT o.id, o.content, o.weight, o.emotion, o.archived_at, e.name as entity_name
                      FROM observations o
                      LEFT JOIN entities e ON o.entity_id = e.id
                      WHERE e.name IN (${placeholders}) ${archivedFilter}
                      ORDER BY RANDOM() LIMIT ?`;
    const hotResults = await env.DB.prepare(hotQuery).bind(...hotEntityNames, hotCount).all();
    if (hotResults.results) {
      allResults = allResults.concat(hotResults.results as Array<Record<string, unknown>>);
    }
  }

  // Get random sparks
  if (randomCount > 0) {
    let query = `SELECT o.id, o.content, o.weight, o.emotion, o.archived_at, e.name as entity_name
                 FROM observations o
                 LEFT JOIN entities e ON o.entity_id = e.id`;

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (context) {
      conditions.push("o.context = ?");
      bindings.push(context);
    }
    if (weightBias) {
      conditions.push("o.weight = ?");
      bindings.push(weightBias);
    }
    if (!includeArchived) {
      conditions.push("o.archived_at IS NULL");
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY RANDOM() LIMIT ?";
    bindings.push(randomCount);

    const randomResults = await env.DB.prepare(query).bind(...bindings).all();
    if (randomResults.results) {
      allResults = allResults.concat(randomResults.results as Array<Record<string, unknown>>);
    }
  }

  if (!allResults.length) {
    return "No observations found to spark from.";
  }

  // Shuffle combined results
  for (let i = allResults.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allResults[i], allResults[j]] = [allResults[j], allResults[i]];
  }

  let output = "## Sparks\n\n";
  if (hotCount > 0) {
    output += `*Biased toward what's hot: ${hotEntityNames.slice(0, 3).join(', ')}...*\n\n`;
  }
  if (includeArchived) {
    output += `*Including memories from the deep*\n\n`;
  }
  for (const obs of allResults) {
    const entity = obs.entity_name ? ` [${obs.entity_name}]` : "";
    const weight = obs.weight ? ` {${obs.weight}}` : "";
    const emotion = obs.emotion ? ` (${obs.emotion})` : "";
    const archived = obs.archived_at ? ` [from the deep]` : "";
    output += `- ${obs.content}${entity}${weight}${emotion}${archived}\n`;
  }
  output += `\n*${allResults.length} observations for associative thinking*`;
  return output;
}
