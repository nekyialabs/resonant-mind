// HTTP handler for /api/observations — extracted from src/index.ts.
import { jsonResponse } from "../response";
import { getEmbedding } from "../../shared/mind-helpers";
import { normalizeText } from "../../shared/text";
import { editObservation, deleteObservation } from "../../shared/surgery";
import type { Env } from "../../types";
import { clampLimit } from "../../shared/limits";

export async function handleApiObservations(request: Request, env: Env, pathParts: string[]): Promise<Response> {
  const method = request.method;
  const obsId = pathParts[2] ? parseInt(pathParts[2]) : null;
  const action = pathParts[3]; // for /api/observations/:id/sit or /resolve

  // GET /api/observations - list with filters
  if (method === "GET" && !obsId) {
    const params = new URL(request.url).searchParams;
    const entityId = params.get("entity_id");
    const weight = params.get("weight");
    const charge = params.get("charge");
    const limit = clampLimit(params.get("limit"), 100);
    const offset = parseInt(params.get("offset") || "0");

    let query = `SELECT o.*, e.name as entity_name, e.entity_type
                 FROM observations o JOIN entities e ON o.entity_id = e.id`;
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (entityId) { conditions.push("o.entity_id = ?"); bindings.push(parseInt(entityId)); }
    if (weight) { conditions.push("o.weight = ?"); bindings.push(weight); }
    if (charge) { conditions.push("o.charge = ?"); bindings.push(charge); }

    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY o.added_at DESC LIMIT ? OFFSET ?";
    bindings.push(limit, offset);

    const results = await env.DB.prepare(query).bind(...bindings).all();
    return jsonResponse(results.results);
  }

  // GET /api/observations/:id - get one with sit history
  if (method === "GET" && obsId && !action) {
    const obs = await env.DB.prepare(
      `SELECT o.*, e.name as entity_name, e.entity_type
       FROM observations o JOIN entities e ON o.entity_id = e.id WHERE o.id = ?`
    ).bind(obsId).first();
    if (!obs) return jsonResponse({ error: "Not found" }, 404);

    const sits = await env.DB.prepare(
      "SELECT * FROM observation_sits WHERE observation_id = ? ORDER BY sat_at DESC"
    ).bind(obsId).all();

    return jsonResponse({ ...obs, sits: sits.results });
  }

  // POST /api/observations - create
  if (method === "POST" && !obsId) {
    const body = await request.json() as Record<string, unknown>;
    const result = await env.DB.prepare(
      `INSERT INTO observations (entity_id, content, weight, emotion, charge) VALUES (?, ?, ?, ?, 'fresh')`
    ).bind(body.entity_id, body.content, body.weight || "medium", normalizeText(body.emotion as string)).run();

    // Vectorize
    const entity = await env.DB.prepare("SELECT name FROM entities WHERE id = ?").bind(body.entity_id).first();
    if (entity) {
      const obsId = result.meta.last_row_id;
      const embedding = await getEmbedding(env, `${entity.name}: ${body.content}`);
      await env.VECTORS.upsert([{
        id: `obs-${body.entity_id}-${obsId}`,
        values: embedding,
        metadata: { source: "observation", entity: entity.name as string, content: body.content as string, weight: (body.weight || "medium") as string, added_at: new Date().toISOString() }
      }]);
    }

    return jsonResponse({ id: result.meta.last_row_id, ...body }, 201);
  }

  // POST /api/observations/:id/sit - sit with observation
  if (method === "POST" && obsId && action === "sit") {
    const body = await request.json() as Record<string, unknown>;
    const obs = await env.DB.prepare("SELECT charge, sit_count FROM observations WHERE id = ?").bind(obsId).first();
    if (!obs) return jsonResponse({ error: "Not found" }, 404);

    const sitCount = ((obs.sit_count as number) || 0) + 1;
    let newCharge = obs.charge as string || "fresh";
    if (newCharge === "fresh") newCharge = "active";
    else if (newCharge === "active" && sitCount >= 3) newCharge = "processing";

    await env.DB.prepare(
      "UPDATE observations SET charge = ?, sit_count = ?, last_sat_at = datetime('now') WHERE id = ?"
    ).bind(newCharge, sitCount, obsId).run();

    await env.DB.prepare(
      "INSERT INTO observation_sits (observation_id, sit_note) VALUES (?, ?)"
    ).bind(obsId, body.sit_note || "").run();

    return jsonResponse({ id: obsId, charge: newCharge, sit_count: sitCount });
  }

  // POST /api/observations/:id/resolve - resolve observation
  if (method === "POST" && obsId && action === "resolve") {
    const body = await request.json() as Record<string, unknown>;
    await env.DB.prepare(
      `UPDATE observations SET charge = 'metabolized', resolution_note = ?, resolved_at = datetime('now') WHERE id = ?`
    ).bind(body.resolution_note || "", obsId).run();
    return jsonResponse({ id: obsId, charge: "metabolized" });
  }

  // PUT /api/observations/:id - update
  // Shared engine (the collision audit D-3): version-history + content update +
  // re-embed, same complete flow mind_edit uses. Response shape unchanged.
  if (method === "PUT" && obsId) {
    const body = await request.json() as Record<string, unknown>;
    await editObservation(env, obsId, {
      content: body.content as string | undefined,
      weight: body.weight as string | undefined,
      emotion: (body.emotion as string | undefined) || undefined,
    });
    return jsonResponse({ id: obsId, ...body });
  }

  // DELETE /api/observations/:id - delete
  // Shared engine (the collision audit D-3): observation_sits + embeddings +
  // observation_versions + orphan_observations cleaned, same complete flow
  // mind_delete uses. Response shape unchanged.
  if (method === "DELETE" && obsId) {
    await deleteObservation(env, obsId);
    return jsonResponse({ deleted: true });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
