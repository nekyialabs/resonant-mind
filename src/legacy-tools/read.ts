/**
 * handleMindRead — JSON read of mind state.
 * Scopes: all, context, recent, observation.
 */

import type { Env } from "../types";
import { recordAccessTracking } from "../daemon/state";

export async function handleMindRead(env: Env, params: Record<string, unknown>): Promise<string> {
  const scope = (params.scope as string) || "all";
  const context = (params.context as string) || "default";
  const hours = (params.hours as number) || 24;

  try {
    if (scope === "all") {
      // Get observation contexts (context now lives on observations, not entities)
      const contexts = await env.DB.prepare(
        `SELECT DISTINCT context FROM observations ORDER BY context`
      ).all();

      const contextList = contexts.results?.map((r: any) => r.context) || ["default"];
      const allData: any = { timestamp: new Date().toISOString(), contexts: {} };

      // Total entities (now global, not per-context)
      const totalEntitiesResult = await env.DB.prepare(`SELECT COUNT(*) as count FROM entities`).first();
      const totalRelationsResult = await env.DB.prepare(`SELECT COUNT(*) as count FROM relations`).first();

      for (const ctx of contextList) {
        const obsCount = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM observations WHERE context = ?`
        ).bind(ctx).first();

        const entityCount = await env.DB.prepare(
          `SELECT COUNT(DISTINCT entity_id) as count FROM observations WHERE context = ?`
        ).bind(ctx).first();

        allData.contexts[ctx] = {
          observation_count: (obsCount?.count as number) || 0,
          entities_with_observations: (entityCount?.count as number) || 0
        };
      }

      allData.summary = {
        total_entities: (totalEntitiesResult?.count as number) || 0,
        total_relations: (totalRelationsResult?.count as number) || 0,
        contexts_with_content: Object.keys(allData.contexts).length
      };

      return JSON.stringify(allData, null, 2);
    }

    if (scope === "context") {
      // Find entities that have observations in this context
      const entitiesResult = await env.DB.prepare(`
        SELECT DISTINCT e.id, e.name, e.entity_type, e.primary_context, e.salience, e.created_at
        FROM entities e
        JOIN observations o ON o.entity_id = e.id
        WHERE o.context = ?
        ORDER BY e.created_at DESC
      `).bind(context).all();

      const relationsResult = await env.DB.prepare(
        `SELECT id, from_entity, to_entity, relation_type, from_context, to_context, store_in, created_at FROM relations WHERE store_in = ? ORDER BY created_at DESC`
      ).bind(context).all();

      return JSON.stringify({
        context,
        entities: entitiesResult.results || [],
        relations: relationsResult.results || [],
        entity_count: entitiesResult.results?.length || 0,
        relation_count: relationsResult.results?.length || 0
      }, null, 2);
    }

    if (scope === "recent") {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const recent = await env.DB.prepare(
        `SELECT e.name, e.entity_type, o.context, o.content, o.added_at
         FROM observations o
         JOIN entities e ON o.entity_id = e.id
         WHERE o.added_at > ?
         ORDER BY o.added_at DESC`
      ).bind(cutoff).all();

      // D-3 (the shared-engine audit): episode_recall previously couldn't read what
      // episode_record writes — journals were invisible to its own region's
      // recall verb. Journals have no `context`/`entity_id` column (see
      // migrations/postgres/0001_core.sql), so only the hours filter applies
      // here; modest addition, clearly labeled as its own section rather than
      // merged into `observations`.
      const recentJournals = await env.DB.prepare(
        `SELECT id, entry_date, content, tags, emotion, created_at
         FROM journals
         WHERE created_at > ?
         ORDER BY created_at DESC`
      ).bind(cutoff).all();

      return JSON.stringify({
        query: `Last ${hours} hours`,
        cutoff,
        observations: recent.results || [],
        observation_count: recent.results?.length || 0,
        journals: recentJournals.results || [],
        journal_count: recentJournals.results?.length || 0
      }, null, 2);
    }

    if (scope === "observation") {
      const obsId = params.observation_id as number;
      if (!obsId) return JSON.stringify({ error: "observation_id is required for scope='observation'" });

      const obs = await env.DB.prepare(`
        SELECT o.id, o.content, o.context, o.emotion, o.weight, o.certainty, o.source,
               o.charge, o.sit_count, o.last_sat_at, o.resolution_note, o.resolved_at,
               o.linked_observation_id, o.surface_count, o.last_surfaced_at, o.novelty_score,
               o.archived_at, o.added_at, o.updated_at, o.source_date,
               COALESCE(o.access_count, 0) as access_count, o.last_accessed_at,
               o.valid_from, o.valid_until, o.superseded_by, o.supersedes,
               e.name as entity_name, e.entity_type, e.salience as entity_salience
        FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE o.id = ?
      `).bind(obsId).first();

      if (!obs) return JSON.stringify({ error: `Observation #${obsId} not found` });

      // Get sit history
      const sits = await env.DB.prepare(
        `SELECT sit_note, sat_at FROM observation_sits WHERE observation_id = ? ORDER BY sat_at DESC`
      ).bind(obsId).all();

      // The released fresh-v4 table stores snapshots as content/weight/emotion
      // at edited_at. Keep the established direct-read response keys stable.
      const versions = await env.DB.prepare(
        `SELECT content AS previous_content, weight AS previous_weight, emotion AS previous_emotion, edited_at AS changed_at
         FROM observation_versions
         WHERE observation_id = ?
         ORDER BY edited_at DESC`
      ).bind(obsId).all();

      // Get supersession chain
      let supersededObs = null;
      if (obs.supersedes) {
        supersededObs = await env.DB.prepare(
          `SELECT id, content FROM observations WHERE id = ?`
        ).bind(obs.supersedes).first();
      }
      let supersededByObs = null;
      if (obs.superseded_by) {
        supersededByObs = await env.DB.prepare(
          `SELECT id, content FROM observations WHERE id = ?`
        ).bind(obs.superseded_by).first();
      }

      // Track this access
      recordAccessTracking(env, [obsId]).catch(() => {});

      const result: any = {
        id: obs.id,
        entity: { name: obs.entity_name, type: obs.entity_type, salience: obs.entity_salience },
        content: obs.content,
        context: obs.context,
        emotion: obs.emotion,
        weight: obs.weight,
        certainty: obs.certainty,
        source: obs.source,
        charge: obs.charge,
        sit_count: obs.sit_count,
        surface_count: obs.surface_count,
        access_count: obs.access_count,
        novelty_score: obs.novelty_score,
        dates: {
          added: obs.added_at,
          updated: obs.updated_at,
          source_date: obs.source_date,
          last_surfaced: obs.last_surfaced_at,
          last_accessed: obs.last_accessed_at,
          last_sat: obs.last_sat_at,
          archived: obs.archived_at,
          resolved: obs.resolved_at,
          valid_from: obs.valid_from,
          valid_until: obs.valid_until,
        },
      };

      if (obs.resolution_note) result.resolution = obs.resolution_note;
      if (obs.linked_observation_id) result.linked_observation_id = obs.linked_observation_id;
      if (supersededObs) result.supersedes = { id: supersededObs.id, content: (supersededObs.content as string).slice(0, 200) };
      if (supersededByObs) result.superseded_by = { id: supersededByObs.id, content: (supersededByObs.content as string).slice(0, 200) };
      if (sits.results?.length) result.sit_history = sits.results;
      if (versions.results?.length) result.edit_history = versions.results;

      return JSON.stringify(result, null, 2);
    }

    return JSON.stringify({ error: `Invalid scope '${scope}'. Must be: all, context, recent, observation` });
  } catch (error) {
    console.error("mind_read failed", error);
    return JSON.stringify({ error: "Internal error" });
  }
}
