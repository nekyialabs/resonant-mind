/**
 * Surgery engines — THE complete edit/delete implementations (the shared-engine audit D-3,
 * the v4 behavior Gate N's "one door per (act, target)" principle).
 *
 * D-3 found three complementary-incomplete cleanup mismatches between the HTTP and
 * MCP surfaces — each side did HALF the correct work:
 *   - Edit: HTTP `PUT /api/observations/:id` skipped `observation_versions` and
 *     re-embedding entirely; MCP `mind_edit` did both.
 *   - Observation delete: HTTP cleaned `observation_sits` but not `embeddings`;
 *     MCP `mind_delete` cleaned `embeddings` but not `observation_sits`.
 *   - Entity delete: HTTP skipped embedding cleanup (entity + its observations);
 *     MCP cleaned embeddings.
 *
 * This file is the convergence point, same shape as `shared/archive-observation.ts`
 * (Gate N #3): one engine per act, both surfaces call it, "edit/delete an X" has
 * exactly one complete implementation regardless of which door triggered it.
 *
 * Schema note verified against migrations/postgres/0001_core.sql: `observation_sits`,
 * `observation_versions`, `orphan_observations`, and `co_surfacing` all carry
 * `FOREIGN KEY ... ON DELETE CASCADE` back to `observations(id)` — Postgres already
 * removes those rows the instant the observation row goes. The explicit deletes
 * below are defense-in-depth (harmless no-ops under the current schema; they only
 * matter if a tenant's cascade were ever missing) and are kept for the same reason
 * `archiveObservation` keeps its own belt-and-suspenders queue cleanup. `embeddings`
 * is the one table that is NOT FK-linked (it's a polymorphic string-keyed table —
 * `obs-{entity_id}-{id}` / `entity-{id}` — with no `source_id` foreign key) so its
 * cleanup is the only structurally load-bearing delete here.
 *
 * Ordering discipline (no transactions in this adapter): dependents first, the
 * `observations`/`entities` row itself LAST — a mid-failure leaves a still-visible
 * row instead of orphaned fragments.
 */

import type { Env } from "../types";
import { getEmbedding } from "./mind-helpers";

// ---------------------------------------------------------------------------
// editObservation
// ---------------------------------------------------------------------------

export interface EditObservationChanges {
  content?: string;
  weight?: string;
  emotion?: string;
}

export interface EditObservationResult {
  found: boolean;
  noUpdates?: boolean;
  oldContent?: string;
  /** The version_num just written to observation_versions for the PRE-edit
   *  content (matches legacy-tools/edit.ts's original `versionNum` semantic —
   *  callers building the "(vN)" message add 1, same as before). */
  versionNum?: number;
  contentChanged?: boolean;
  /** Only meaningful when contentChanged is true. */
  reembedded?: boolean;
  entityId?: number;
}

/**
 * editObservation — THE one edit engine for observations (the shared-engine audit D-3).
 * Lifted verbatim from legacy-tools/edit.ts's original observation branch
 * (version-history row -> content update -> re-embed), extracted so both the
 * MCP and HTTP surfaces get the complete flow instead of half of it.
 */
export async function editObservation(
  env: Env,
  observationId: number,
  changes: EditObservationChanges
): Promise<EditObservationResult> {
  const obs = await env.DB.prepare(
    `SELECT id, content, entity_id, weight, emotion FROM observations WHERE id = ?`
  ).bind(observationId).first();

  if (!obs) return { found: false };

  const updates: string[] = [];
  const values: unknown[] = [];

  if (changes.content !== undefined) {
    updates.push("content = ?");
    values.push(changes.content);
  }
  if (changes.weight !== undefined) {
    updates.push("weight = ?");
    values.push(changes.weight);
  }
  if (changes.emotion !== undefined) {
    updates.push("emotion = ?");
    values.push(changes.emotion);
  }

  if (updates.length === 0) {
    return { found: true, noUpdates: true, oldContent: String(obs.content), entityId: obs.entity_id as number };
  }

  // Preserve previous version before updating
  let versionNum = 1;
  try {
    const versionResult = await env.DB.prepare(`
      SELECT COALESCE(MAX(version_num), 0) as max_version
      FROM observation_versions
      WHERE observation_id = ?
    `).bind(obs.id).first();
    versionNum = ((versionResult?.max_version as number) || 0) + 1;

    await env.DB.prepare(`
      INSERT INTO observation_versions (observation_id, version_num, content, weight, emotion)
      VALUES (?, ?, ?, ?, ?)
    `).bind(obs.id, versionNum, obs.content, obs.weight, obs.emotion).run();
  } catch (e) {
    console.log(`Version tracking skipped: ${e}`);
  }

  values.push(obs.id);

  await env.DB.prepare(
    `UPDATE observations SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  // Re-embed if content changed (best-effort — but report honestly)
  let reembedded = false;
  const contentChanged = changes.content !== undefined;
  if (contentChanged) {
    try {
      const entity = await env.DB.prepare(
        `SELECT e.name FROM entities e JOIN observations o ON o.entity_id = e.id WHERE o.id = ?`
      ).bind(obs.id).first();
      const entityName = entity?.name ? String(entity.name) : "";
      const text = `${entityName}: ${changes.content}`;
      const embedding = await getEmbedding(env, text);
      await env.VECTORS.upsert([{
        id: `obs-${obs.entity_id}-${obs.id}`,
        values: embedding,
        metadata: {
          source: "observation",
          entity: entityName,
          content: changes.content as string,
          weight: changes.weight || String(obs.weight || "medium"),
        }
      }]);
      reembedded = true;
    } catch (e) {
      console.error(`Re-embed after edit failed (observation #${obs.id}):`, e);
    }
  }

  return {
    found: true,
    noUpdates: false,
    oldContent: String(obs.content),
    versionNum,
    contentChanged,
    reembedded,
    entityId: obs.entity_id as number,
  };
}

// ---------------------------------------------------------------------------
// deleteObservation
// ---------------------------------------------------------------------------

export interface DeleteObservationResult {
  found: boolean;
  content?: string;
  entityId?: number;
}

/**
 * deleteObservation — THE one delete engine for observations (the shared-engine audit D-3).
 * Union of both prior partial implementations: HTTP's `observation_sits` cleanup
 * + MCP's `embeddings` cleanup, plus the two neither side did explicitly
 * (`observation_versions`, `orphan_observations` — see file header re: these
 * being FK-cascaded already, kept here as defense-in-depth). `observations` row
 * deleted LAST.
 */
export async function deleteObservation(env: Env, observationId: number): Promise<DeleteObservationResult> {
  const obs = await env.DB.prepare(
    `SELECT content, entity_id FROM observations WHERE id = ?`
  ).bind(observationId).first();

  if (!obs) return { found: false };

  // Dependents first. Defense-in-depth: Postgres FK CASCADE (migrations/postgres/
  // 0001_core.sql) already removes these when the observation row goes, but the
  // explicit cleanup costs nothing and protects any tenant whose schema variant
  // lacks the cascade.
  try {
    await env.DB.prepare(`DELETE FROM observation_sits WHERE observation_id = ?`).bind(observationId).run();
  } catch { /* table may not exist on an unmigrated tenant */ }
  try {
    await env.DB.prepare(`DELETE FROM observation_versions WHERE observation_id = ?`).bind(observationId).run();
  } catch { /* table may not exist on an unmigrated tenant */ }
  try {
    await env.DB.prepare(`DELETE FROM orphan_observations WHERE observation_id = ?`).bind(observationId).run();
  } catch { /* table may not exist on an unmigrated tenant */ }

  // embeddings — the one table that is NOT FK-linked; this delete is load-bearing.
  // Keyed by (source_type, source_id), not by rebuilding `obs-{entity_id}-{id}`:
  // the string id bakes in the entity the observation was written under, so a
  // rebuilt key misses (and orphans) the vector of any observation that later
  // moved entity — the same predicate deleteEntity already uses.
  try {
    await env.DB.prepare(
      `DELETE FROM embeddings WHERE source_type = 'observation' AND source_id = ?`
    ).bind(observationId).run();
  } catch { /* embedding may not exist */ }

  // The observation row itself, LAST.
  await env.DB.prepare(`DELETE FROM observations WHERE id = ?`).bind(observationId).run();

  return { found: true, content: String(obs.content), entityId: obs.entity_id as number };
}

// ---------------------------------------------------------------------------
// deleteEntity
// ---------------------------------------------------------------------------

export interface DeleteEntityParams {
  entityId?: number;
  entityName?: string;
}

export interface DeleteEntityResult {
  found: boolean;
  entityId?: number;
  entityName?: string;
  observationCount?: number;
}

/**
 * deleteEntity — THE one delete engine for entities (the shared-engine audit D-3).
 * Lifted from legacy-tools/delete.ts's entity branch (already the more-complete
 * side — it clean embeddings for the entity AND its observations), which the
 * HTTP `DELETE /api/entities/:id` path skipped entirely. Callers may resolve by
 * either id or name; relations are keyed by entity name (no FK), so the name is
 * always looked up before the relation cleanup regardless of which was given.
 */
export async function deleteEntity(env: Env, params: DeleteEntityParams): Promise<DeleteEntityResult> {
  let entityId = params.entityId;
  let entityName = params.entityName;

  if (entityName && !entityId) {
    const entity = await env.DB.prepare(`SELECT id FROM entities WHERE name = ?`).bind(entityName).first();
    if (!entity) return { found: false };
    entityId = entity.id as number;
  } else if (entityId && !entityName) {
    const entity = await env.DB.prepare(`SELECT name FROM entities WHERE id = ?`).bind(entityId).first();
    if (!entity) return { found: false };
    entityName = entity.name as string;
  }

  if (!entityId || !entityName) return { found: false };

  // Count observations that will be deleted
  const obsCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE entity_id = ?`
  ).bind(entityId).first();

  // Clean up all embeddings for this entity's observations + the entity itself
  // (the piece HTTP's DELETE /api/entities/:id skipped — D-3).
  try {
    await env.DB.prepare(
      `DELETE FROM embeddings WHERE source_type = 'observation' AND source_id IN (SELECT id FROM observations WHERE entity_id = ?)`
    ).bind(entityId).run();
    await env.DB.prepare(`DELETE FROM embeddings WHERE id = ?`).bind(`entity-${entityId}`).run();
  } catch { /* embeddings may not exist */ }

  // Delete observations first (FK CASCADE also carries observation_sits/
  // observation_versions/orphan_observations/co_surfacing for each of them).
  await env.DB.prepare(`DELETE FROM observations WHERE entity_id = ?`).bind(entityId).run();

  // Delete relations (keyed by name, no FK)
  await env.DB.prepare(`DELETE FROM relations WHERE from_entity = ? OR to_entity = ?`).bind(entityName, entityName).run();

  // Delete entity — LAST
  await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(entityId).run();

  return {
    found: true,
    entityId,
    entityName,
    observationCount: Number(obsCount?.c || 0),
  };
}

// ---------------------------------------------------------------------------
// mergeEntities
// ---------------------------------------------------------------------------

export interface MergeEntitiesResult {
  found: boolean;
  missing?: "from" | "into";
  fromName?: string;
  intoName?: string;
  observationsMoved?: number;
}

/**
 * mergeEntities — THE one merge engine for entities. The MCP (`graph_shape`
 * merge) and HTTP (`POST /api/entities/merge`) paths each carried their own
 * copy, and both moved observations without touching `embeddings`:
 *   - the moved observations kept vector ids `obs-{FROM}-{id}`, so a later
 *     edit upserted a second vector at `obs-{INTO}-{id}` (two vectors, one
 *     memory) and the metadata still named the old entity;
 *   - `entity-{FROM}` outlived its entity.
 * Here the moved vectors are re-keyed to `obs-{INTO}-{id}` (metadata.entity
 * renamed with them) and `entity-{FROM}` is dropped. Ordering: vectors are
 * re-keyed first (the only moment FROM's rows are still identifiable), then
 * observations move, then relations; the source entity row goes LAST. A
 * re-key failure is logged, never fatal: the merge itself still lands, and
 * deleteObservation's (source_type, source_id) predicate still finds the
 * stale-keyed vectors.
 */
export async function mergeEntities(env: Env, fromId: number, intoId: number): Promise<MergeEntitiesResult> {
  const fromEntity = await env.DB.prepare(`SELECT id, name FROM entities WHERE id = ?`).bind(fromId).first();
  const intoEntity = await env.DB.prepare(`SELECT id, name FROM entities WHERE id = ?`).bind(intoId).first();
  if (!fromEntity) return { found: false, missing: "from" };
  if (!intoEntity) return { found: false, missing: "into" };

  const fromName = fromEntity.name as string;
  const intoName = intoEntity.name as string;

  // Re-key BEFORE moving, while `entity_id = FROM` still identifies exactly the
  // rows being moved (afterwards they're indistinguishable from INTO's own).
  try {
    await env.DB.prepare(
      `UPDATE embeddings
       SET id = 'obs-' || ?::text || '-' || source_id,
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{entity}', to_jsonb(?::text))
       WHERE source_type = 'observation'
         AND source_id IN (SELECT id FROM observations WHERE entity_id = ?)`
    ).bind(intoId, intoName, fromId).run();
    await env.DB.prepare(`DELETE FROM embeddings WHERE id = ?`).bind(`entity-${fromId}`).run();
  } catch (e) {
    console.error(`mergeEntities: embedding re-key for '${fromName}' (#${fromId}) → '${intoName}' (#${intoId}) failed — vectors still keyed obs-${fromId}-*: ${e}`);
  }

  const moved = await env.DB.prepare(
    `UPDATE observations SET entity_id = ? WHERE entity_id = ?`
  ).bind(intoId, fromId).run();

  // Relations are keyed by name (no FK).
  await env.DB.prepare(`UPDATE relations SET from_entity = ? WHERE from_entity = ?`).bind(intoName, fromName).run();
  await env.DB.prepare(`UPDATE relations SET to_entity = ? WHERE to_entity = ?`).bind(intoName, fromName).run();

  // Source entity — LAST
  await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(fromId).run();

  return { found: true, fromName, intoName, observationsMoved: moved.meta.changes ?? 0 };
}
