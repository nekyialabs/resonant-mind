/**
 * handleMindGraph — graph-shape introspection. Polymorphic by `view`:
 *
 *   - sparse        — entities with ≥4 active observations and ≤1 relation.
 *                     The actionable list for relation work. (default)
 *   - disconnected  — entities with 0 relations. Some are legit standalone,
 *                     others are crying to be tied in.
 *   - hubs          — top-N entities by relation count.
 *   - empty         — entities with 0 active observations (named but unspoken).
 *   - connections   — for a named entity, show its full relation neighborhood.
 *
 * The engine under regions/network.ts's `graph_walk` verb (Gate A, Mind
 * Reshape 2) — a straight pass-through, no wrapping logic added.
 */

import type { Env } from "../types";
import { dict } from "../shared/dict";
import { clampLimit } from "../shared/limits";

interface EntityRow {
  id: number;
  name: string;
  entity_type: string;
  rel_count: number;
  obs_count: number;
  last_obs?: string | null;
  sample?: string | null;
}

function previewObs(s: string | null | undefined, n = 160): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n).trimEnd()}...` : s;
}

export async function handleMindGraph(env: Env, params: Record<string, unknown>): Promise<string> {
  const view = ((params.view as string | undefined) ?? "sparse").toLowerCase();
  const limit = clampLimit(params.limit, 25, 200);

  if (view === "connections") {
    const name = (params.name as string | undefined)?.trim();
    if (!name) return "mind_graph(view='connections') needs `name`.";

    const ent = (await env.DB.prepare(
      `SELECT id, name, entity_type FROM entities WHERE name = $1`
    ).bind(name).first()) as { id: number; name: string; entity_type: string } | null;

    if (!ent) return `No entity matched '${name}'.`;

    const rels = await env.DB.prepare(`
      SELECT relation_type,
             CASE WHEN from_entity = $1 THEN to_entity ELSE from_entity END AS other,
             CASE WHEN from_entity = $1 THEN 'out' ELSE 'in' END AS direction
      FROM relations
      WHERE from_entity = $1 OR to_entity = $1
      ORDER BY relation_type, other
    `).bind(ent.name).all();

    const rows = (rels.results || []) as Array<Record<string, unknown>>;
    if (!rows.length) return `${ent.name} (${ent.entity_type}) has 0 relations. Disconnected.`;

    let out = `=== GRAPH: ${ent.name} (${ent.entity_type}) — ${rows.length} relations ===\n\n`;
    const byType: Record<string, string[]> = dict<string[]>();
    for (const r of rows) {
      const t = r.relation_type as string;
      const dir = r.direction === 'out' ? '→' : '←';
      const other = r.other as string;
      if (!byType[t]) byType[t] = [];
      byType[t].push(`${dir} ${other}`);
    }
    for (const [type, edges] of Object.entries(byType)) {
      out += `**${type}** (${edges.length})\n`;
      for (const e of edges) out += `  ${e}\n`;
      out += "\n";
    }
    return out;
  }

  // The shared CTE per-entity rel + active-obs counts (plus sample for ranked views)
  const baseSelect = `
    WITH entity_stats AS (
      SELECT e.id, e.name, e.entity_type,
        (SELECT COUNT(*) FROM relations r WHERE r.from_entity = e.name OR r.to_entity = e.name) AS rel_count,
        (SELECT COUNT(*) FROM observations o
           WHERE (o.person_id = e.id OR o.node_id = e.id OR o.entity_id = e.id)
             AND o.archived_at IS NULL) AS obs_count,
        (SELECT MAX(o.added_at) FROM observations o
           WHERE (o.person_id = e.id OR o.node_id = e.id OR o.entity_id = e.id)
             AND o.archived_at IS NULL) AS last_obs,
        (SELECT o.content FROM observations o
           WHERE (o.person_id = e.id OR o.node_id = e.id OR o.entity_id = e.id)
             AND o.archived_at IS NULL
           ORDER BY o.added_at DESC
           LIMIT 1) AS sample
      FROM entities e
    )
    SELECT id, name, entity_type, rel_count, obs_count, last_obs::text AS last_obs, sample FROM entity_stats
  `;

  let whereClause = "";
  let orderClause = "";
  let title = "";
  let description = "";

  switch (view) {
    case "sparse":
      whereClause = "WHERE obs_count >= 4 AND rel_count <= 1";
      orderClause = "ORDER BY obs_count DESC, rel_count ASC";
      title = "SPARSE-RIPE";
      description = "Entities with ≥4 active observations but ≤1 relation. Highest-leverage candidates for relation work.";
      break;
    case "disconnected":
      whereClause = "WHERE rel_count = 0";
      orderClause = "ORDER BY obs_count DESC, name ASC";
      title = "DISCONNECTED";
      description = "Entities with 0 relations. Sorted by observation count — top of list are content-rich but graph-detached.";
      break;
    case "hubs":
      whereClause = "WHERE rel_count >= 5";
      orderClause = "ORDER BY rel_count DESC";
      title = "HUBS";
      description = "Top-N entities by relation count. Where the graph clusters.";
      break;
    case "empty":
      whereClause = "WHERE obs_count = 0";
      orderClause = "ORDER BY rel_count DESC, name ASC";
      title = "EMPTY";
      description = "Entities with 0 active observations. Named but unspoken — or all observations archived.";
      break;
    default:
      return `mind_graph: unknown view '${view}'. Must be one of: sparse, disconnected, hubs, empty, connections.`;
  }

  const result = await env.DB.prepare(`${baseSelect} ${whereClause} ${orderClause} LIMIT $1`).bind(limit).all();
  const rows = ((result.results || []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    name: r.name as string,
    entity_type: r.entity_type as string,
    rel_count: Number(r.rel_count),
    obs_count: Number(r.obs_count),
    last_obs: (r.last_obs as string | null) ?? null,
    sample: (r.sample as string | null) ?? null,
  })) as EntityRow[];

  if (!rows.length) {
    return `=== GRAPH: ${title} ===\n\n${description}\n\nNothing matched.`;
  }

  let out = `=== GRAPH: ${title} (${rows.length}) ===\n\n${description}\n\n`;
  for (const r of rows) {
    out += `**${r.name}** (${r.entity_type}) — obs:${r.obs_count} / rel:${r.rel_count}\n`;
    if (r.sample) out += `  ${previewObs(r.sample)}\n`;
    out += "\n";
  }
  return out;
}
