/**
 * handleMindSit — sit with an observation (increment sit_count, update charge).
 * Find by ID, text match, or semantic query.
 */

import type { Env } from "../types";
import { getEmbedding } from "../shared/mind-helpers";
import { escapeLike } from "../shared/text";

export async function handleMindSit(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  const semanticQuery = params.query as string;
  const sitNote = params.sit_note as string;

  // Find the observation with entity info
  let obs;
  let matchMethod = '';

  if (observationId) {
    matchMethod = 'id';
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.id = ?`
    ).bind(observationId).first();
  } else if (textMatch) {
    matchMethod = 'text';
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.content LIKE ? ESCAPE '\\' ORDER BY o.added_at DESC LIMIT 1`
    ).bind(`%${escapeLike(textMatch)}%`).first();
  } else if (semanticQuery) {
    matchMethod = 'semantic';
    // Use vector search to find closest matching observation
    const embedding = await getEmbedding(env, semanticQuery);
    const vectorResults = await env.VECTORS.query(embedding, {
      topK: 5,
      returnMetadata: "all"
    });

    // Find the best observation match (filter out non-observations)
    for (const match of vectorResults.matches || []) {
      if (match.id.startsWith('obs-')) {
        // Extract observation ID from vector ID pattern: obs-{entity_id}-{obs_id}
        const parts = match.id.split('-');
        if (parts.length >= 3) {
          const matchedObsId = parseInt(parts[2]);
          obs = await env.DB.prepare(
            `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, e.name as entity_name
             FROM observations o
             JOIN entities e ON o.entity_id = e.id
             WHERE o.id = ?`
          ).bind(matchedObsId).first();
          if (obs) break;
        }
      }
    }
  } else {
    return "Must provide observation_id, text_match, or query (semantic search)";
  }

  if (!obs) {
    return `Observation not found`;
  }

  const currentSitCount = (obs.sit_count as number) || 0;
  const newSitCount = currentSitCount + 1;

  // Determine new charge level based on sit count
  let newCharge: string;
  if (newSitCount === 0) {
    newCharge = 'fresh';
  } else if (newSitCount <= 2) {
    newCharge = 'active';
  } else {
    newCharge = 'processing';
  }

  // Update the observation
  await env.DB.prepare(
    `UPDATE observations SET sit_count = ?, charge = ?, last_sat_at = datetime('now') WHERE id = ?`
  ).bind(newSitCount, newCharge, obs.id).run();

  // Record the sit in history
  await env.DB.prepare(
    `INSERT INTO observation_sits (observation_id, sit_note) VALUES (?, ?)`
  ).bind(obs.id, sitNote).run();

  const contentPreview = String(obs.content).slice(0, 80);
  const matchInfo = matchMethod === 'semantic' ? ` *(found via "${semanticQuery}")*` : '';
  return `Sat with observation #${obs.id} on **${obs.entity_name}** [${obs.weight}/${newCharge}]${matchInfo}\n"${contentPreview}..."\n\nSit #${newSitCount}: ${sitNote}`;
}
