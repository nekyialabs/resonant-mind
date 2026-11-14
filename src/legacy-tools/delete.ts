/**
 * handleMindDelete — delete observation, entity, journal, relation, image,
 * thread, or tension. Cleans up embeddings + R2 storage where applicable.
 */

import type { Env } from "../types";
import { deleteObservation, deleteEntity } from "../shared/surgery";
import { R2_IMAGE_PATH_PREFIX } from "../shared/constants";
import { escapeLike } from "../shared/text";

export async function handleMindDelete(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const entityName = params.entity_name as string;
  const context = (params.context as string) || "default";
  const textMatch = params.text_match as string;

  if (observationId) {
    // Shared engine (the collision audit D-3): observation_sits + embeddings +
    // observation_versions + orphan_observations cleaned, one complete
    // implementation for both this MCP path and HTTP's.
    const result = await deleteObservation(env, observationId);
    if (!result.found) return `Observation #${observationId} not found`;
    return `Deleted observation #${observationId}: "${String(result.content).slice(0, 50)}..." [embedding cleaned]`;
  }

  if (textMatch) {
    // Find and delete by text match
    const obs = await env.DB.prepare(
      `SELECT id, content, entity_id FROM observations WHERE content LIKE ? ESCAPE '\\' ORDER BY added_at DESC LIMIT 1`
    ).bind(`%${escapeLike(textMatch)}%`).first();

    if (!obs) return `No observation found matching "${textMatch}"`;

    const result = await deleteObservation(env, obs.id as number);
    return `Deleted observation #${obs.id}: "${String(result.content ?? obs.content).slice(0, 50)}..."`;
  }

  if (entityName) {
    // Shared engine (the collision audit D-3): embeddings cleanup for the entity
    // + its observations, one complete implementation for both this MCP path
    // and HTTP's.
    const result = await deleteEntity(env, { entityName });
    if (!result.found) return `Entity '${entityName}' not found`;
    return `Deleted entity '${entityName}' with ${result.observationCount || 0} observations [embeddings cleaned]`;
  }

  // Delete journal
  const journalId = params.journal_id as number;
  if (journalId) {
    const journal = await env.DB.prepare(`SELECT content FROM journals WHERE id = ?`).bind(journalId).first();
    if (!journal) return `Journal #${journalId} not found`;
    await env.DB.prepare(`DELETE FROM journals WHERE id = ?`).bind(journalId).run();
    try { await env.DB.prepare(`DELETE FROM embeddings WHERE id = ?`).bind(`journal-${journalId}`).run(); } catch {}
    return `Deleted journal #${journalId}: "${String(journal.content).slice(0, 50)}..." [embedding cleaned]`;
  }

  // Delete relation
  const relationId = params.relation_id as number;
  if (relationId) {
    const rel = await env.DB.prepare(`SELECT from_entity, to_entity, relation_type FROM relations WHERE id = ?`).bind(relationId).first();
    if (!rel) return `Relation #${relationId} not found`;
    await env.DB.prepare(`DELETE FROM relations WHERE id = ?`).bind(relationId).run();
    return `Deleted relation #${relationId}: ${rel.from_entity} -> ${rel.to_entity} (${rel.relation_type})`;
  }

  // Delete image
  const imageId = params.image_id as number;
  if (imageId) {
    const img = await env.DB.prepare(`SELECT path, description FROM images WHERE id = ?`).bind(imageId).first();
    if (!img) return `Image #${imageId} not found`;
    await env.DB.prepare(`DELETE FROM images WHERE id = ?`).bind(imageId).run();
    try { await env.VECTORS.deleteByIds([`img-${imageId}`]); } catch {}
    let r2Note = "R2 not stored";
    if (img.path && String(img.path).startsWith(R2_IMAGE_PATH_PREFIX)) {
      const r2Key = String(img.path).slice(R2_IMAGE_PATH_PREFIX.length);
      const stillUsed = await env.DB.prepare(`SELECT 1 FROM images WHERE path = ? LIMIT 1`).bind(img.path).first();
      if (stillUsed) {
        r2Note = "R2 retained (still referenced by another row)";
      } else {
        try { await env.R2_IMAGES.delete(r2Key); r2Note = "R2 cleaned"; } catch { r2Note = "R2 delete failed"; }
      }
    }
    return `Deleted image #${imageId}: "${String(img.description).slice(0, 50)}..." [DB + Vectorize cleaned, ${r2Note}]`;
  }

  // Delete thread
  const threadId = params.thread_id as string;
  if (threadId) {
    const thread = await env.DB.prepare(`SELECT content FROM threads WHERE id = ?`).bind(threadId).first();
    if (!thread) return `Thread '${threadId}' not found`;
    await env.DB.prepare(`DELETE FROM threads WHERE id = ?`).bind(threadId).run();
    return `Deleted thread '${threadId}': "${String(thread.content).slice(0, 50)}..."`;
  }

  // Delete tension
  const tensionId = params.tension_id as string;
  if (tensionId) {
    const tension = await env.DB.prepare(`SELECT pole_a, pole_b FROM tensions WHERE id = ?`).bind(tensionId).first();
    if (!tension) return `Tension '${tensionId}' not found`;
    await env.DB.prepare(`DELETE FROM tensions WHERE id = ?`).bind(tensionId).run();
    return `Deleted tension '${tensionId}': ${tension.pole_a} <-> ${tension.pole_b}`;
  }

  return "Must provide observation_id, text_match, entity_name, journal_id, relation_id, image_id, thread_id, or tension_id";
}
