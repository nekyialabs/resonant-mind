/**
 * handleMindStoreImage — store/view/search/delete images with R2 + multimodal embedding.
 * Stores validated JPEG/PNG/GIF/WebP originals with canonical metadata.
 */

import type { Env } from "../types";
import { getEmbedding, imageUrl } from "../shared/mind-helpers";
import { getImageEmbedding } from "../embeddings";
import { normalizeText } from "../shared/text";
import { R2_IMAGE_PATH_PREFIX } from "../shared/constants";
import { decodeBase64Image, fetchRemoteImage, validateImageBytes } from "../shared/image-security";
import { clampLimit } from "../shared/limits";

export async function handleMindStoreImage(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;

  // === STORE: validate → unique R2 object → embedding → durable row → optional vector index.
  // Failures before the row commits remove the new object; indexing failures return a stored warning.
  if (action === "store") {
    const imageData = params.image_data as string | undefined;
    const sourceUrl = params.source_url as string | undefined;
    const filename = params.filename as string;
    const description = params.description as string;
    const entityName = params.entity_name as string;
    const emotion = params.emotion as string;
    const weight = (params.weight as string) || "medium";
    const context = params.context as string;
    const observationId = params.observation_id as number;

    if (!imageData && !sourceUrl) return "Error: either image_data (base64) or source_url (URL the worker can fetch) is required.";
    if (!description) return "Error: description is required.";
    if (!env.R2_IMAGES) return "Error: R2 binding unavailable.";

    // Resolve entity
    let entityId: number | null = null;
    if (entityName) {
      const entity = await env.DB.prepare("SELECT id FROM entities WHERE name = ?").bind(entityName).first();
      if (entity) entityId = entity.id as number;
    }

    // --- Acquire raw bytes: either decode base64 or fetch the source URL. ---
    let rawBinary: Uint8Array;
    if (sourceUrl) {
      try {
        rawBinary = await fetchRemoteImage(sourceUrl);
      } catch (e) {
        return `Error: source_url fetch failed — ${e instanceof Error ? e.message : String(e).slice(0, 120)}`;
      }
    } else {
      try {
        rawBinary = decodeBase64Image(imageData!);
      } catch (e) {
        return `Error: base64 decode failed — ${e instanceof Error ? e.message : "image_data is not valid base64"}`;
      }
    }

    let imageFormat;
    try {
      imageFormat = validateImageBytes(rawBinary);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : "unsupported image bytes"}`;
    }
    const mimeType = imageFormat.mime;

    // --- R2 upload. Throws on failure → no D1 insert. ---
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const safeName = (filename || description.slice(0, 50))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60);
    const storedKey = `${date}_${safeName}_${crypto.randomUUID()}${imageFormat.extension}`;
    await env.R2_IMAGES.put(storedKey, rawBinary, { httpMetadata: { contentType: mimeType } });

    const storedPath = `${R2_IMAGE_PATH_PREFIX}${storedKey}`;
    const storedMime = mimeType;
    let databaseCommitted = false;

    try {
      const contextText = [
        entityName ? `${entityName}:` : "", description,
        context ? `(${context})` : "", emotion ? `[${emotion}]` : ""
      ].filter(Boolean).join(" ");

      let embedding: number[];
      let embeddingNote: string | null = null;
      try {
        embedding = await getImageEmbedding(env.GEMINI_API_KEY, rawBinary.buffer as ArrayBuffer, mimeType, contextText);
      } catch (multimodalError) {
        embedding = await getEmbedding(env, contextText);
        embeddingNote = `multimodal failed (${String(multimodalError).slice(0, 80)}), used text fallback`;
      }

      const result = await env.DB.prepare(`
        INSERT INTO images (path, description, context, emotion, weight, entity_id, observation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(storedPath, description, context || null, normalizeText(emotion), weight, entityId, observationId || null).run();

      const imageId = result.meta.last_row_id;
      databaseCommitted = true;
      const imgMetadata: Record<string, string> = {
        source: "image", description, weight, added_at: new Date().toISOString(), path: storedPath
      };
      if (entityName) imgMetadata.entity = entityName;
      if (context) imgMetadata.context = context;
      if (emotion) imgMetadata.emotion = normalizeText(emotion) || emotion;

      let indexWarning: string | null = null;
      try {
        await env.VECTORS.upsert([{ id: `img-${imageId}`, values: embedding, metadata: imgMetadata }]);
      } catch (vectorError) {
        indexWarning = `index warning: stored, but vector indexing failed (${String(vectorError).slice(0, 100)})`;
        console.error("Image stored but vector indexing failed:", vectorError);
      }

      let response = `Image stored (#${imageId}) [R2: ${storedMime}, ${embeddingNote ? "text-fallback" : "multimodal"} embedded${indexWarning ? ", index pending" : ""}]`;
      if (embeddingNote) response += `\n${embeddingNote}`;
      if (indexWarning) response += `\n${indexWarning}`;
      if (entityName) response += `\nEntity: ${entityName}`;
      if (emotion) response += ` | Emotion: ${emotion}`;
      response += `\nPath: ${storedPath}`;
      return response;
    } catch (error) {
      if (!databaseCommitted) {
        try {
          await env.R2_IMAGES.delete(storedKey);
        } catch (cleanupError) {
          console.error("Image store cleanup failed:", cleanupError);
        }
      }
      throw error;
    }
  }

  // === VIEW: Browse images by filter ===
  // the shared-engine audit E-3: "view" reads as a browse/query action but has a
  // real hidden write below — every returned image gets last_viewed_at/
  // view_count bumped. Same class as mind_search/graph_look's (né
  // mind_read_entity) access-tracking; flagged so this doesn't get mistaken
  // for a pure read.
  if (action === "view") {
    const entityName = params.entity_name as string;
    const emotion = params.emotion as string;
    const weight = params.weight as string;
    const random = params.random as boolean;
    const limit = clampLimit(params.limit, 5);

    let query = `SELECT i.*, e.name as entity_name, e.entity_type FROM images i LEFT JOIN entities e ON i.entity_id = e.id WHERE 1=1`;
    const bindings: unknown[] = [];

    if (entityName) { query += ` AND e.name = ?`; bindings.push(entityName); }
    if (emotion) { query += ` AND i.emotion = ?`; bindings.push(emotion); }
    if (weight) { query += ` AND i.weight = ?`; bindings.push(weight); }
    query += random ? ` ORDER BY RANDOM()` : ` ORDER BY i.created_at DESC`;
    query += ` LIMIT ?`;
    bindings.push(limit);

    const images = await env.DB.prepare(query).bind(...bindings).all();
    if (!images.results?.length) {
      return `No visual memories found. Use mind_store_image(action="store") to add some.`;
    }

    for (const id of images.results.map((i: any) => i.id)) {
      await env.DB.prepare(`UPDATE images SET last_viewed_at = datetime('now'), view_count = view_count + 1 WHERE id = ?`).bind(id).run();
    }

    let output = `## Visual Memories\n\n`;
    if (random) output += `*Random selection*\n\n`;
    for (const img of images.results as any[]) {
      const emotionTag = img.emotion ? ` [${img.emotion}]` : "";
      const entityTag = img.entity_name ? ` -> ${img.entity_name}` : "";
      output += `**#${img.id}** [${img.weight}]${emotionTag}${entityTag}\n`;
      output += `${img.description}\n`;
      if (img.context) output += `*${img.context}*\n`;
      if (img.path?.startsWith("r2://")) {
        output += `View: ${await imageUrl(img.id, env)}\n`;
      } else if (img.path && img.path !== "pending") {
        output += `Path: \`${img.path}\`\n`;
      }
      output += `\n`;
    }
    return output;
  }

  // === SEARCH: Semantic image search via pgvector ===
  if (action === "search") {
    const query = params.query as string;
    const limit = clampLimit(params.limit, 5);
    if (!query) return "Error: query is required for image search.";

    const embedding = await getEmbedding(env, query);
    const results = await env.VECTORS.query(embedding, { topK: limit * 3, returnMetadata: "all" });

    const imageMatches = results.matches?.filter((m: any) => m.id.startsWith("img-")) || [];
    if (!imageMatches.length) return "No images match that query.";

    let output = `## Image Search: "${query}"\n\n`;
    for (const match of imageMatches.slice(0, limit)) {
      const meta = match.metadata as Record<string, string>;
      const score = Math.round(match.score * 100);
      output += `**${match.id}** (${score}%)`;
      if (meta?.entity) output += ` -> ${meta.entity}`;
      if (meta?.emotion) output += ` [${meta.emotion}]`;
      const imgId = match.id.replace("img-", "");
      output += `\n${meta?.description || "No description"}\n`;
      output += `View: ${await imageUrl(imgId, env)}\n`;
      output += `\n`;
    }
    return output;
  }

  // === DELETE: Remove DB row + Vectorize entry + R2 object (only if unreferenced). ===
  if (action === "delete") {
    const imgId = params.image_id as number;
    if (!imgId) return "Error: image_id required for delete.";
    const img = await env.DB.prepare(`SELECT path, description FROM images WHERE id = ?`).bind(imgId).first();
    if (!img) return `Image #${imgId} not found.`;
    await env.DB.prepare(`DELETE FROM images WHERE id = ?`).bind(imgId).run();
    try { await env.VECTORS.deleteByIds([`img-${imgId}`]); } catch {}
    let r2Note = "R2 not stored";
    if (img.path && String(img.path).startsWith(R2_IMAGE_PATH_PREFIX)) {
      const r2Key = String(img.path).slice(R2_IMAGE_PATH_PREFIX.length);
      // Only delete R2 if no other row still references this path (avoids cascading on duplicates).
      const stillUsed = await env.DB.prepare(`SELECT 1 FROM images WHERE path = ? LIMIT 1`).bind(img.path).first();
      if (stillUsed) {
        r2Note = "R2 retained (still referenced by another row)";
      } else {
        try { await env.R2_IMAGES.delete(r2Key); r2Note = "R2 cleaned"; } catch { r2Note = "R2 delete failed"; }
      }
    }
    return `Deleted image #${imgId}: "${String(img.description).slice(0, 50)}..." [DB + Vectorize cleaned, ${r2Note}]`;
  }

  return "Unknown action. Use: store, view, search, or delete.";
}
