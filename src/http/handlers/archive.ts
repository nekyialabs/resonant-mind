// HTTP handler for /api/archive — extracted from src/index.ts.
import { jsonResponse } from "../response";
import { getEmbedding } from "../../shared/mind-helpers";
import { rescueObservation } from "../../shared/archive-observation";
import type { Env } from "../../types";
import { clampLimit, clampOffset } from "../../shared/limits";

export async function handleApiArchive(request: Request, env: Env, pathParts: string[]): Promise<Response> {
  const id = pathParts[2] ? parseInt(pathParts[2]) : null;
  const action = pathParts[3]; // rescue or search

  // GET /api/archive - list archived observations
  if (request.method === "GET" && !id && action !== "search") {
    const url = new URL(request.url);
    const limit = clampLimit(url.searchParams.get("limit"), 50);
    const offset = clampOffset(url.searchParams.get("offset"));

    const results = await env.DB.prepare(`
      SELECT o.*, e.name as entity_name, e.entity_type
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.archived_at IS NOT NULL
      ORDER BY o.archived_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM observations WHERE archived_at IS NOT NULL`
    ).first();

    return jsonResponse({
      observations: results.results,
      total: countResult?.total || 0,
      limit,
      offset
    });
  }

  // GET /api/archive/search?q=... - semantic search in archive
  if (request.method === "GET" && action === "search") {
    const query = new URL(request.url).searchParams.get("q");
    if (!query) return jsonResponse({ error: "Query required" }, 400);

    const embedding = await getEmbedding(env, query);
    const vectorResults = await env.VECTORS.query(embedding, {
      topK: 30,
      returnMetadata: "all"
    });

    // Filter to only archived observations
    const obsIds: number[] = [];
    for (const match of vectorResults.matches || []) {
      if (match.id.startsWith("obs-")) {
        const parts = match.id.split("-");
        if (parts.length >= 3) {
          obsIds.push(parseInt(parts[2]));
        }
      }
    }

    if (obsIds.length === 0) return jsonResponse([]);

    const placeholders = obsIds.map(() => "?").join(",");
    const results = await env.DB.prepare(`
      SELECT o.*, e.name as entity_name, e.entity_type
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.id IN (${placeholders}) AND o.archived_at IS NOT NULL
      ORDER BY o.archived_at DESC
    `).bind(...obsIds).all();

    return jsonResponse(results.results);
  }

  // POST /api/archive/:id/rescue - un-archive observation
  // Delegates to the shared rescue engine (the collision audit C-1) — was a
  // standalone inline UPDATE with a different novelty_score than the MCP
  // door; now both doors converge on one semantic.
  if (request.method === "POST" && id && action === "rescue") {
    await rescueObservation(env, id);

    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: "Unknown archive endpoint" }, 404);
}
