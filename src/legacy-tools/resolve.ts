/**
 * handleMindResolve — mark an observation metabolized with a resolution
 * note, optionally linked to the observation that resolved it.
 *
 * Resolution is the natural endpoint of a charge: surfaced, sat with,
 * and now folded back in.
 *
 * Lives in legacy-tools/ pending R3 (wholesale cut of old MCP surface) —
 * post-reshape this is part of the Active region's lifecycle verbs.
 */

import type { Env } from "../types";
import { escapeLike } from "../shared/text";

export async function handleMindResolve(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  const resolutionNote = params.resolution_note as string;
  const linkedObservationId = params.linked_observation_id as number;

  // Find the observation with entity info
  let obs;
  if (observationId) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.id = ?`
    ).bind(observationId).first();
  } else if (textMatch) {
    obs = await env.DB.prepare(
      `SELECT o.id, o.content, o.weight, o.charge, o.sit_count, e.name as entity_name
       FROM observations o
       JOIN entities e ON o.entity_id = e.id
       WHERE o.content LIKE ? ESCAPE '\\' ORDER BY o.added_at DESC LIMIT 1`
    ).bind(`%${escapeLike(textMatch)}%`).first();
  } else {
    return "Must provide observation_id or text_match";
  }

  if (!obs) {
    return `Observation not found`;
  }

  // Update the observation to metabolized
  await env.DB.prepare(
    `UPDATE observations SET charge = 'metabolized', resolution_note = ?, resolved_at = datetime('now'), linked_observation_id = ? WHERE id = ?`
  ).bind(resolutionNote, linkedObservationId || null, obs.id).run();

  const contentPreview = String(obs.content).slice(0, 80);
  let output = `Resolved observation #${obs.id} on **${obs.entity_name}** [${obs.weight}] → metabolized\n"${contentPreview}..."\n\nResolution: ${resolutionNote}`;

  if (linkedObservationId) {
    const linked = await env.DB.prepare(
      `SELECT o.content, e.name as entity_name FROM observations o JOIN entities e ON o.entity_id = e.id WHERE o.id = ?`
    ).bind(linkedObservationId).first();
    if (linked) {
      output += `\n\nLinked to observation #${linkedObservationId} on **${linked.entity_name}**: "${String(linked.content).slice(0, 60)}..."`;
    }
  }

  return output;
}
