/**
 * handleMindEntity — entity admin actions: set_salience, edit, merge, archive_old.
 * Re-vectorizes after edits.
 *
 * The engine under regions/network.ts's `graph_shape` verb (Gate A, Mind
 * Reshape 2). C-2 (the collision audit): `archive_old` sets entities.salience
 * = 'archive' — an entity-level salience TIER, NOT the same mechanism as
 * observations.archived_at (the observation-level timestamp Surgery's
 * mind_archive owns). Same word, two unrelated columns/tables.
 */

import type { Env } from "../types";
import { getEmbedding } from "../shared/mind-helpers";
import { mergeEntities, updateEntity, type EntityFieldUpdate } from "../shared/surgery";

export async function handleMindEntity(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;
  const entityId = params.entity_id as number;
  const entityName = params.entity_name as string;
  const context = (params.context as string) || "default";

  // Helper to find entity (globally unique by name now)
  async function findEntity(): Promise<{ id: number; name: string; entity_type: string; primary_context: string; salience: string } | null> {
    if (entityId) {
      return await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context, salience FROM entities WHERE id = ?`
      ).bind(entityId).first() as any;
    } else if (entityName) {
      return await env.DB.prepare(
        `SELECT id, name, entity_type, primary_context, salience FROM entities WHERE name = ?`
      ).bind(entityName).first() as any;
    }
    return null;
  }

  switch (action) {
    case "set_salience": {
      const salience = params.salience as string;
      if (!salience || !["foundational", "active", "background", "archive"].includes(salience)) {
        return "Must provide valid salience: foundational, active, background, or archive";
      }

      const entity = await findEntity();
      if (!entity) return "Entity not found";

      await env.DB.prepare(
        `UPDATE entities SET salience = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(salience, entity.id).run();

      return `Set ${entity.name} salience to '${salience}' (was '${entity.salience || 'active'}')`;
    }

    case "edit": {
      const entity = await findEntity();
      if (!entity) return "Entity not found";

      const newName = params.new_name as string;
      const newType = params.new_type as string;
      const newContext = params.new_context as string;

      const fields: EntityFieldUpdate = {};
      const changes: string[] = [];

      if (newName && newName !== entity.name) {
        fields.name = newName;
        changes.push(`name: ${entity.name} → ${newName}`);
      }
      if (newType && newType !== entity.entity_type) {
        fields.entity_type = newType;
        changes.push(`type: ${entity.entity_type} → ${newType}`);
      }
      if (newContext && newContext !== entity.primary_context) {
        fields.primary_context = newContext;
        changes.push(`primary_context: ${entity.primary_context} → ${newContext}`);
      }

      if (changes.length === 0) {
        return "No changes provided";
      }

      // One atomic statement: the entity row and the relations that name it.
      const outcome = await updateEntity(env, entity.id, fields);
      if (outcome.status === "missing") return "Entity not found";
      if (outcome.status === "name-taken") {
        return `Cannot rename '${entity.name}' to '${newName}': another entity already has that name. Use action 'merge' to combine them. Nothing was changed.`;
      }

      // Re-vectorize the entity with updated info
      try {
        const finalName = newName || entity.name;
        const finalType = newType || entity.entity_type;
        const finalContext = newContext || entity.primary_context;
        const entityText = `${finalName} is a ${finalType}. Primary context: ${finalContext}`;
        const entityEmbedding = await getEmbedding(env, entityText);
        await env.VECTORS.upsert([{
          id: `entity-${entity.id}`,
          values: entityEmbedding,
          metadata: {
            source: "entity",
            name: finalName,
            entity_type: finalType,
            context: finalContext,
            updated_at: new Date().toISOString()
          }
        }]);
      } catch (e) {
        console.log(`Failed to re-vectorize entity ${entity.id}: ${e}`);
      }

      return `Updated entity #${entity.id}:\n${changes.join("\n")}`;
    }

    case "merge": {
      const mergeFromId = params.merge_from_id as number;
      const mergeIntoId = params.merge_into_id as number;

      if (!mergeFromId || !mergeIntoId) {
        return "Must provide merge_from_id and merge_into_id";
      }

      // Shared engine: one atomic statement carries observations, their
      // vectors, images, thread links, consolidation groups and relations.
      let result;
      try {
        result = await mergeEntities(env, mergeFromId, mergeIntoId);
      } catch (e) {
        return `Merge of #${mergeFromId} into #${mergeIntoId} failed and was not applied: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (result.refused === "same-entity") return `Cannot merge entity #${mergeFromId} into itself`;
      if (result.missing === "from") return `Source entity #${mergeFromId} not found`;
      if (result.missing === "into") return `Target entity #${mergeIntoId} not found`;

      return `Merged '${result.fromName}' (#${mergeFromId}) into '${result.intoName}' (#${mergeIntoId})\nMoved ${result.observationsMoved} observations`;
    }

    case "archive_old": {
      const olderThanDays = (params.older_than_days as number) || 30;
      const typeFilter = params.entity_type_filter as string;

      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

      let query = `UPDATE entities SET salience = 'archive', updated_at = datetime('now')
                   WHERE salience != 'foundational' AND salience != 'archive'
                   AND updated_at < ?`;
      const bindings: unknown[] = [cutoff];

      if (typeFilter) {
        query += ` AND entity_type = ?`;
        bindings.push(typeFilter);
      }

      const result = await env.DB.prepare(query).bind(...bindings).run();

      const typeDesc = typeFilter ? ` of type '${typeFilter}'` : "";
      return `Archived ${result.meta.changes} entities${typeDesc} older than ${olderThanDays} days`;
    }

    default:
      return `Unknown action: ${action}. Valid actions: set_salience, edit, merge, archive_old`;
  }
}
