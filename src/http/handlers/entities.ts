// HTTP handler for /api/entities — extracted from src/index.ts.
import { jsonResponse } from "../response";
import { deleteEntity, mergeEntities, updateEntity, type EntityFieldUpdate } from "../../shared/surgery";
import type { Env } from "../../types";

export async function handleApiEntities(request: Request, env: Env, pathParts: string[]): Promise<Response> {
  const method = request.method;
  const entityId = pathParts[2] ? parseInt(pathParts[2]) : null;

  // GET /api/entities - list all
  if (method === "GET" && !entityId) {
    const typeFilter = new URL(request.url).searchParams.get("type");
    const contextFilter = new URL(request.url).searchParams.get("context");

    let query = `SELECT e.*, COUNT(o.id) as observation_count
                 FROM entities e LEFT JOIN observations o ON e.id = o.entity_id`;
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (typeFilter) { conditions.push("e.entity_type = ?"); bindings.push(typeFilter); }
    if (contextFilter) { conditions.push("o.context = ?"); bindings.push(contextFilter); }

    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " GROUP BY e.id ORDER BY e.name";

    const results = await env.DB.prepare(query).bind(...bindings).all();
    return jsonResponse(results.results);
  }

  // GET /api/entities/:id - get one with observations
  if (method === "GET" && entityId) {
    const entity = await env.DB.prepare("SELECT id, name, entity_type, primary_context, salience, created_at, updated_at FROM entities WHERE id = ?").bind(entityId).first();
    if (!entity) return jsonResponse({ error: "Not found" }, 404);

    const observations = await env.DB.prepare(
      `SELECT id, entity_id, content, salience, emotion, weight, certainty, source, context, charge, sit_count, added_at, archived_at FROM observations WHERE entity_id = ? ORDER BY added_at DESC`
    ).bind(entityId).all();

    const entityName = entity.name as string;
    const relations = await env.DB.prepare(
      `SELECT id, from_entity, to_entity, relation_type, from_context, to_context, store_in, created_at FROM relations WHERE from_entity = ? OR to_entity = ?`
    ).bind(entityName, entityName).all();

    return jsonResponse({ ...entity, observations: observations.results, relations: relations.results });
  }

  // POST /api/entities - create
  if (method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const result = await env.DB.prepare(
      "INSERT INTO entities (name, entity_type, primary_context) VALUES (?, ?, ?)"
    ).bind(body.name, body.entity_type || "concept", body.context || "default").run();
    return jsonResponse({ id: result.meta.last_row_id, ...body }, 201);
  }

  // PUT /api/entities/:id - update (handles partial updates)
  if (method === "PUT" && entityId) {
    const body = await request.json() as Record<string, unknown>;

    const current = await env.DB.prepare("SELECT id FROM entities WHERE id = ?").bind(entityId).first();
    if (!current) return jsonResponse({ error: "Not found" }, 404);

    if (body.name !== undefined && (typeof body.name !== "string" || !body.name)) {
      return jsonResponse({ error: "name must be a non-empty string" }, 400);
    }

    const fields: EntityFieldUpdate = {};
    if (body.name !== undefined) fields.name = body.name as string;
    if (body.entity_type !== undefined) fields.entity_type = body.entity_type as string;
    if (body.context !== undefined) fields.primary_context = body.context as string;
    if (body.salience !== undefined) fields.salience = body.salience as string;

    // One atomic statement: the entity row and the relations that name it.
    const outcome = await updateEntity(env, entityId, fields);
    if (outcome.status === "missing") return jsonResponse({ error: "Not found" }, 404);
    if (outcome.status === "name-taken") {
      return jsonResponse({ error: "Another entity already has that name. Merge them instead of renaming.", conflicting_entity_id: outcome.takenById }, 409);
    }

    return jsonResponse({ id: entityId, ...body });
  }

  // POST /api/entities/merge - merge two entities
  if (method === "POST" && pathParts[2] === "merge") {
    const body = await request.json() as Record<string, unknown>;
    const mergeFromId = body.merge_from_id as number;
    const mergeIntoId = body.merge_into_id as number;

    if (!mergeFromId || !mergeIntoId) {
      return jsonResponse({ error: "merge_from_id and merge_into_id required" }, 400);
    }

    // Shared engine (same as graph_shape merge): one atomic statement.
    // Response shape unchanged.
    if (Number(mergeFromId) === Number(mergeIntoId)) {
      return jsonResponse({ error: "Cannot merge an entity into itself" }, 400);
    }
    let result;
    try {
      result = await mergeEntities(env, mergeFromId, mergeIntoId);
    } catch (e) {
      return jsonResponse({ error: `Merge failed and was not applied: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
    if (result.missing === "from") return jsonResponse({ error: "Source entity not found" }, 404);
    if (result.missing === "into") return jsonResponse({ error: "Target entity not found" }, 404);

    return jsonResponse({
      success: true,
      merged_from: result.fromName,
      merged_into: result.intoName,
      observations_moved: result.observationsMoved
    });
  }

  // DELETE /api/entities/:id - delete
  // Shared engine (the collision audit D-3): embeddings cleanup for the entity +
  // its observations, same complete flow mind_delete uses. Response shape
  // unchanged.
  if (method === "DELETE" && entityId) {
    await deleteEntity(env, { entityId });
    return jsonResponse({ deleted: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
