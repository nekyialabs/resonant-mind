/**
 * handleMindEdit — edit observation, image, or journal.
 * Re-embeds when content/description changes. Versions observations.
 */

import type { Env } from "../types";
import { getEmbedding } from "../shared/mind-helpers";
import { normalizeText, escapeLike } from "../shared/text";
import { editObservation } from "../shared/surgery";

export async function handleMindEdit(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const imageId = params.image_id as number;
  const journalId = params.journal_id as number;
  const textMatch = params.text_match as string;
  const descriptionMatch = params.description_match as string;
  const newContent = params.new_content as string;
  const newWeight = params.new_weight as string;
  const newEmotion = params.new_emotion as string;
  const newContext = params.new_context as string;
  const newPath = params.new_path as string;

  // === EDIT JOURNAL ===
  if (journalId) {
    const journal = await env.DB.prepare(`SELECT id, content, entry_date, emotion FROM journals WHERE id = ?`).bind(journalId).first();
    if (!journal) return `Journal #${journalId} not found`;
    if (!newContent) return "new_content is required for journal editing";

    await env.DB.prepare(`UPDATE journals SET content = ?, emotion = ? WHERE id = ?`)
      .bind(newContent, newEmotion || journal.emotion || null, journalId).run();

    // Re-embed (best-effort — but report honestly)
    let journalReembedded = false;
    try {
      const embedding = await getEmbedding(env, newContent);
      await env.VECTORS.upsert([{
        id: `journal-${journalId}`,
        values: embedding,
        metadata: { source: "journal", title: String(journal.entry_date || ""), content: newContent, emotion: String(newEmotion || journal.emotion || "") }
      }]);
      journalReembedded = true;
    } catch (e) { console.error(`Journal re-embed failed (journal #${journalId}):`, e); }

    const journalEmbedNote = journalReembedded ? '[re-embedded]' : '[re-embed FAILED — search will serve stale text until re-embedded]';
    return `Journal #${journalId} updated ${journalEmbedNote}\nOld: "${String(journal.content).slice(0, 50)}..."\nNew: "${newContent.slice(0, 50)}..."`;
  }

  // Determine if editing an image or observation
  const editingImage = imageId || descriptionMatch;

  if (editingImage) {
    // === EDIT IMAGE ===
    let img;
    if (imageId) {
      img = await env.DB.prepare(
        `SELECT i.id, i.description, i.path, i.context, i.emotion, i.weight, e.name as entity_name
         FROM images i LEFT JOIN entities e ON i.entity_id = e.id WHERE i.id = ?`
      ).bind(imageId).first();
    } else if (descriptionMatch) {
      img = await env.DB.prepare(
        `SELECT i.id, i.description, i.path, i.context, i.emotion, i.weight, e.name as entity_name
         FROM images i LEFT JOIN entities e ON i.entity_id = e.id
         WHERE i.description LIKE ? ESCAPE '\\' ORDER BY i.created_at DESC LIMIT 1`
      ).bind(`%${escapeLike(descriptionMatch)}%`).first();
    }

    if (!img) {
      return "Image not found";
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let descriptionChanged = false;
    let contextChanged = false;
    let emotionChanged = false;

    if (newContent) {
      updates.push("description = ?");
      values.push(newContent);
      descriptionChanged = true;
    }
    if (newWeight) {
      updates.push("weight = ?");
      values.push(newWeight);
    }
    if (newEmotion) {
      updates.push("emotion = ?");
      values.push(normalizeText(newEmotion));
      emotionChanged = true;
    }
    if (newContext) {
      updates.push("context = ?");
      values.push(newContext);
      contextChanged = true;
    }
    if (newPath) {
      updates.push("path = ?");
      values.push(newPath);
    }

    if (updates.length === 0) {
      return "No updates provided";
    }

    values.push(img.id);

    await env.DB.prepare(
      `UPDATE images SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();

    // Update vector embedding if semantic content changed
    if (descriptionChanged || contextChanged || emotionChanged) {
      const finalDescription = newContent || String(img.description);
      const finalContext = newContext || (img.context ? String(img.context) : "");
      const finalEmotion = newEmotion ? normalizeText(newEmotion) : (img.emotion ? String(img.emotion) : "");
      const entityName = img.entity_name ? String(img.entity_name) : "";
      const imgWeight = newWeight || String(img.weight || "medium");
      const imgPath = newPath || (img.path ? String(img.path) : "");

      const semanticText = [
        entityName ? `${entityName}:` : "",
        finalDescription,
        finalContext ? `(${finalContext})` : "",
        finalEmotion ? `[${finalEmotion}]` : ""
      ].filter(Boolean).join(" ");

      const imgVectorId = `img-${img.id}`;
      const embedding = await getEmbedding(env, semanticText);
      const editMetadata: Record<string, string> = {
        source: "image",
        description: finalDescription,
        weight: imgWeight,
        added_at: new Date().toISOString()
      };
      if (entityName) editMetadata.entity = entityName;
      if (finalContext) editMetadata.context = finalContext;
      if (finalEmotion) editMetadata.emotion = finalEmotion;
      if (imgPath) editMetadata.path = imgPath;

      await env.VECTORS.upsert([{
        id: imgVectorId,
        values: embedding,
        metadata: editMetadata
      }]);
    }

    const oldPreview = String(img.description).slice(0, 50);
    const newPreview = newContent ? newContent.slice(0, 50) : oldPreview;
    return `📷 Image #${img.id} updated\nOld: "${oldPreview}..."\nNew: "${newPreview}..."`;

  } else {
    // === EDIT OBSERVATION (original logic) ===
    let obs;
    if (observationId) {
      obs = await env.DB.prepare(
        `SELECT id, content, entity_id, weight, emotion FROM observations WHERE id = ?`
      ).bind(observationId).first();
    } else if (textMatch) {
      obs = await env.DB.prepare(
        `SELECT id, content, entity_id, weight, emotion FROM observations WHERE content LIKE ? ESCAPE '\\' ORDER BY added_at DESC LIMIT 1`
      ).bind(`%${escapeLike(textMatch)}%`).first();
    } else {
      return "Must provide observation_id, image_id, text_match, or description_match";
    }

    if (!obs) {
      return "Observation not found";
    }

    if (!newContent && !newWeight && !newEmotion) {
      return "No updates provided";
    }

    // Shared engine (the collision audit D-3): version-history + content update +
    // re-embed, one complete implementation for both this MCP path and HTTP's.
    const result = await editObservation(env, obs.id as number, {
      content: newContent || undefined,
      weight: newWeight || undefined,
      emotion: newEmotion || undefined,
    });

    if (!result.found) return "Observation not found";
    if (result.noUpdates) return "No updates provided";

    const oldPreview = String(result.oldContent).slice(0, 50);
    const newPreview = newContent ? newContent.slice(0, 50) : oldPreview;
    const obsEmbedNote = newContent ? (result.reembedded ? '[re-embedded]' : '[re-embed FAILED — search will serve stale text until re-embedded]') : '';
    return `Observation #${obs.id} updated (v${(result.versionNum || 0) + 1}) ${obsEmbedNote}\nOld: "${oldPreview}..."\nNew: "${newPreview}..."`;
  }
}
