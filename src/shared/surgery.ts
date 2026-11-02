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
  /** Set when the merge was refused before anything was written. */
  refused?: "same-entity";
  fromName?: string;
  intoName?: string;
  observationsMoved?: number;
  vectorsMoved?: number;
  duplicateVectorsRemoved?: number;
  imagesMoved?: number;
  threadLinksMoved?: number;
  consolidationGroupsMoved?: number;
  relationsMoved?: number;
}

/**
 * Before the move: a memory may already carry more than one vector (an older
 * merge left `obs-{FROM}-{id}` behind and a later edit wrote a second one at
 * the current key). Keep exactly one per memory: the one at the current key
 * `obs-{entity_id}-{id}` (where edits write, so it holds the newest content),
 * else the newest. Without this the re-key below would give two rows the same
 * id and the whole merge would be refused. Only derived vectors are removed;
 * no memory is touched. Idempotent, and safe if the merge then fails.
 */
const DEDUPE_MOVING_VECTORS_SQL = `
DELETE FROM embeddings e
 WHERE e.source_type = 'observation'
   AND e.source_id IN (SELECT id FROM observations WHERE entity_id = ?)
   AND e.id <> (
     SELECT k.id FROM embeddings k
      WHERE k.source_type = 'observation' AND k.source_id = e.source_id
      ORDER BY (k.id = 'obs-' || ?::text || '-' || k.source_id) DESC,
               k.created_at DESC NULLS LAST, k.id DESC
      LIMIT 1)`;

/**
 * The merge itself: ONE statement. The adapter opens a connection per
 * statement and has no transactions, but a single PostgreSQL statement is
 * atomic, data-modifying CTEs included: either every row below moves and the
 * source entity goes, or nothing changes. All CTEs read the same snapshot, so
 * `moving` still names FROM's observations while `obs` moves them. Foreign-key
 * actions run at the end of the statement, after the rows have moved, so the
 * delete of the source entity cascades to nothing that was carried over.
 *
 * Everything that points at an entity is carried to INTO:
 *   - observations: entity_id AND the person_id/node_id subject columns (the
 *     routing trigger only fills those when both are NULL, so an entity_id-only
 *     update left them on the deleted entity, hiding the memories from readers
 *     that use person_id, such as bonds);
 *   - their vectors: re-keyed to obs-{INTO}-{id}, metadata.entity renamed,
 *     the vector values themselves unchanged; entity-{FROM} is removed;
 *   - images (FK ON DELETE SET NULL: were left attached to nothing);
 *   - thread links (FK ON DELETE CASCADE: were deleted); a link INTO already
 *     has for the same thread and role is left to cascade, as INTO keeps it;
 *   - consolidation groups (FK NO ACTION: the delete failed half-way, after the
 *     observations had moved);
 *   - relations, by name (no FK), each row updated once;
 *   - relational_state.person, by name, when both entities are people (bonds
 *     read a person's feelings by name).
 * If INTO is in neither people nor nodes the observations' subject CHECK fails
 * and the whole statement is refused, rather than guessing a subject.
 */
const MERGE_SQL = `
WITH p AS (
  SELECT ?::int AS from_id, ?::int AS into_id, ?::text AS from_name, ?::text AS into_name
), k AS (
  SELECT EXISTS (SELECT 1 FROM people WHERE id = p.into_id) AS into_person,
         EXISTS (SELECT 1 FROM nodes  WHERE id = p.into_id) AS into_node,
         EXISTS (SELECT 1 FROM people WHERE id = p.from_id) AS from_person
    FROM p
), moving AS (
  SELECT o.id FROM observations o, p WHERE o.entity_id = p.from_id
), vec AS (
  UPDATE embeddings e
     SET id = 'obs-' || p.into_id::text || '-' || e.source_id,
         metadata = jsonb_set(COALESCE(e.metadata, '{}'::jsonb), '{entity}', to_jsonb(p.into_name))
    FROM p
   WHERE e.source_type = 'observation' AND e.source_id IN (SELECT id FROM moving)
  RETURNING e.id
), entity_vec AS (
  DELETE FROM embeddings e USING p WHERE e.id = 'entity-' || p.from_id::text
  RETURNING e.id
), obs AS (
  UPDATE observations o
     SET entity_id = p.into_id,
         person_id = CASE WHEN k.into_person THEN p.into_id END,
         node_id   = CASE WHEN k.into_node AND NOT k.into_person THEN p.into_id END
    FROM p, k
   WHERE o.entity_id = p.from_id
  RETURNING o.id
), imgs AS (
  UPDATE images i
     SET entity_id = p.into_id,
         person_id = CASE WHEN k.into_person THEN p.into_id END,
         node_id   = CASE WHEN k.into_node AND NOT k.into_person THEN p.into_id END
    FROM p, k
   WHERE i.entity_id = p.from_id
  RETURNING i.id
), groups AS (
  UPDATE consolidation_groups g
     SET entity_id = p.into_id,
         person_id = CASE WHEN k.into_person THEN p.into_id END,
         node_id   = CASE WHEN k.into_node AND NOT k.into_person THEN p.into_id END
    FROM p, k
   WHERE g.entity_id = p.from_id
  RETURNING g.id
), threads AS (
  UPDATE thread_entities t
     SET entity_id = p.into_id
    FROM p
   WHERE t.entity_id = p.from_id
     AND NOT EXISTS (
       SELECT 1 FROM thread_entities t2
        WHERE t2.thread_id = t.thread_id AND t2.role = t.role AND t2.entity_id = p.into_id)
  RETURNING t.id
), rels AS (
  UPDATE relations r
     SET from_entity = CASE WHEN r.from_entity = p.from_name THEN p.into_name ELSE r.from_entity END,
         to_entity   = CASE WHEN r.to_entity   = p.from_name THEN p.into_name ELSE r.to_entity END
    FROM p
   WHERE r.from_entity = p.from_name OR r.to_entity = p.from_name
  RETURNING r.id
), feelings AS (
  UPDATE relational_state s
     SET person = p.into_name
    FROM p, k
   WHERE k.from_person AND k.into_person AND s.person = p.from_name
  RETURNING s.id
), gone AS (
  DELETE FROM entities x USING p WHERE x.id = p.from_id
  RETURNING x.id
)
SELECT (SELECT count(*) FROM obs)::int     AS observations_moved,
       (SELECT count(*) FROM vec)::int     AS vectors_moved,
       (SELECT count(*) FROM imgs)::int    AS images_moved,
       (SELECT count(*) FROM threads)::int AS thread_links_moved,
       (SELECT count(*) FROM groups)::int  AS consolidation_groups_moved,
       (SELECT count(*) FROM rels)::int    AS relations_moved,
       (SELECT count(*) FROM feelings)::int AS feelings_moved,
       (SELECT count(*) FROM entity_vec)::int AS entity_vectors_removed,
       (SELECT count(*) FROM gone)::int    AS entities_deleted`;

/**
 * mergeEntities — THE one merge engine for entities (MCP `graph_shape` merge
 * and HTTP `POST /api/entities/merge`). Refuses a merge of an entity into
 * itself (the old code then deleted the entity and, by cascade, every one of
 * its memories). Otherwise: an idempotent vector de-duplication, then the
 * merge as one atomic statement (see MERGE_SQL). If the merge statement
 * fails, nothing of the merge was applied; the error is thrown to the door.
 */
export async function mergeEntities(env: Env, fromId: number, intoId: number): Promise<MergeEntitiesResult> {
  if (Number(fromId) === Number(intoId)) return { found: false, refused: "same-entity" };

  const fromEntity = await env.DB.prepare(`SELECT id, name FROM entities WHERE id = ?`).bind(fromId).first();
  const intoEntity = await env.DB.prepare(`SELECT id, name FROM entities WHERE id = ?`).bind(intoId).first();
  if (!fromEntity) return { found: false, missing: "from" };
  if (!intoEntity) return { found: false, missing: "into" };

  const fromName = fromEntity.name as string;
  const intoName = intoEntity.name as string;

  const deduped = await env.DB.prepare(DEDUPE_MOVING_VECTORS_SQL).bind(fromId, fromId).run();

  const row = await env.DB.prepare(MERGE_SQL).bind(fromId, intoId, fromName, intoName).first();
  if (!row || Number(row.entities_deleted) !== 1) {
    // Unreachable unless the source entity vanished between the lookup and
    // the merge (a concurrent delete); say so rather than report success.
    throw new Error(`merge of #${fromId} into #${intoId} did not delete the source entity; it may have been removed concurrently`);
  }

  return {
    found: true,
    fromName,
    intoName,
    observationsMoved: Number(row.observations_moved),
    vectorsMoved: Number(row.vectors_moved),
    duplicateVectorsRemoved: deduped.meta.changes ?? 0,
    imagesMoved: Number(row.images_moved),
    threadLinksMoved: Number(row.thread_links_moved),
    consolidationGroupsMoved: Number(row.consolidation_groups_moved),
    relationsMoved: Number(row.relations_moved),
  };
}
