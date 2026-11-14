// HTTP handler for /api/bonds — aggregated per-person view (the field).
// GET /api/bonds         — all people with warmth, current feeling, counts.
// GET /api/bonds/:name   — drill-in: full bond detail.

import { jsonResponse } from "../response";
import { getSubconsciousState } from "../../daemon/state";
import type { Env } from "../../types";
import { escapeLike } from "../../shared/text";

type WarmthRow = { id: number; state: string; days_since: number | null; last_observed_at: string | null };

function warmthIndex(env: { living_surface?: unknown } | null): Record<number, WarmthRow> {
  const surface = env?.living_surface as Record<string, unknown> | undefined;
  const list = (surface?.bond_warmth as WarmthRow[] | undefined) || [];
  const idx: Record<number, WarmthRow> = {};
  for (const w of list) idx[w.id] = w;
  return idx;
}

export async function handleApiBonds(_request: Request, env: Env, pathParts: string[]): Promise<Response> {
  if (pathParts[2]) {
    return handleSingleBond(env, decodeURIComponent(pathParts[2]));
  }
  return handleAllBonds(env);
}

async function handleAllBonds(env: Env): Promise<Response> {
  const peopleResult = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.kind, p.salience, p.primary_context,
      (SELECT COUNT(*) FROM observations o WHERE o.person_id = p.id AND o.archived_at IS NULL) AS obs_count,
      (SELECT MAX(added_at) FROM observations o WHERE o.person_id = p.id AND o.archived_at IS NULL) AS last_obs_at,
      (SELECT content FROM observations o WHERE o.person_id = p.id AND o.archived_at IS NULL ORDER BY added_at DESC LIMIT 1) AS last_obs_content,
      (SELECT feeling   FROM relational_state rs WHERE rs.person = p.name ORDER BY timestamp DESC LIMIT 1) AS current_feeling,
      (SELECT intensity FROM relational_state rs WHERE rs.person = p.name ORDER BY timestamp DESC LIMIT 1) AS current_intensity,
      (SELECT COUNT(*) FROM thread_entities te JOIN threads t ON t.id = te.thread_id
         WHERE te.entity_id = p.id AND t.status = 'active') AS open_threads
    FROM people p
    ORDER BY p.salience DESC, last_obs_at DESC NULLS LAST
  `).all();

  const rows = (peopleResult.results || []) as Array<Record<string, unknown>>;
  const warmth = warmthIndex(await getSubconsciousState(env));

  return jsonResponse({
    count: rows.length,
    bonds: rows.map((r) => {
      const w = warmth[r.id as number];
      return {
        ...r,
        warmth_state: w?.state ?? "unknown",
        days_since: w?.days_since ?? null,
      };
    }),
  });
}

async function handleSingleBond(env: Env, name: string): Promise<Response> {
  const person = (await env.DB.prepare(
    `SELECT id, name, kind, salience, primary_context FROM people
     WHERE name = $1 OR name ILIKE $2 ESCAPE '\\'
     ORDER BY (name = $1) DESC, LENGTH(name) ASC LIMIT 1`
  ).bind(name, `${escapeLike(name)}%`).first()) as Record<string, unknown> | null;

  if (!person) return jsonResponse({ error: `No bond matched '${name}'` }, 404);

  const personId = person.id as number;
  const personName = person.name as string;

  const [obs, feelings, threads, relations] = await Promise.all([
    env.DB.prepare(`
      SELECT id, content, weight, emotion, charge, added_at
      FROM observations
      WHERE person_id = $1 AND archived_at IS NULL
      ORDER BY added_at DESC LIMIT 30
    `).bind(personId).all(),

    env.DB.prepare(`
      SELECT feeling, intensity, timestamp
      FROM relational_state
      WHERE person = $1
      ORDER BY timestamp DESC LIMIT 20
    `).bind(personName).all(),

    env.DB.prepare(`
      SELECT t.id, t.thread_type, t.content, t.priority, t.status, t.updated_at
      FROM threads t
      JOIN thread_entities te ON te.thread_id = t.id
      WHERE te.entity_id = $1 AND t.status = 'active'
      ORDER BY t.updated_at DESC LIMIT 20
    `).bind(personId).all(),

    env.DB.prepare(`
      SELECT from_entity, to_entity, relation_type
      FROM relations
      WHERE from_entity = $1 OR to_entity = $1
    `).bind(personName).all(),
  ]);

  const warmth = warmthIndex(await getSubconsciousState(env));
  const w = warmth[personId];

  return jsonResponse({
    person: {
      ...person,
      warmth_state: w?.state ?? "unknown",
      days_since: w?.days_since ?? null,
      last_observed_at: w?.last_observed_at ?? null,
    },
    observations: obs.results || [],
    feelings: feelings.results || [],
    threads: threads.results || [],
    relations: relations.results || [],
  });
}
