/**
 * handleMindWrite — entry point for entity/observation/relation/journal writes.
 * Includes private helpers: writeEntity, detectContradictions, writeObservation,
 * writeRelation, writeJournal.
 */

import type { Env } from "../types";
import { getEmbedding } from "../shared/mind-helpers";
import { normalizeText } from "../shared/text";
import { CONTRADICTION_SIMILARITY_THRESHOLD, AUTO_SUPERSEDE_MAX_CHARS } from "../shared/constants";
import { resolveAutoSupersede, retireObservation } from "../shared/supersede";
import { checkStartle } from "../daemon/somatic";

export async function handleMindWrite(env: Env, params: Record<string, unknown>): Promise<string> {
  switch (params.type as string) {
    case "entity": return writeEntity(env, params);
    case "observation": return writeObservation(env, params);
    case "relation": return writeRelation(env, params);
    case "journal": return writeJournal(env, params);
    case "image": return "Use mind_store_image(action='store') for images — supports R2 upload and multimodal embedding.";
    default: return `Unknown write type: ${params.type}`;
  }
}

async function writeEntity(env: Env, params: Record<string, unknown>): Promise<string> {
  const name = params.name as string;
  if (!name) return "Error: 'name' parameter is required for creating an entity";

  const entity_type = (params.entity_type as string) || "concept";
  let rawObs = params.observations;
  let observations: string[] = [];
  if (typeof rawObs === 'string') {
    try { observations = JSON.parse(rawObs); } catch { observations = []; }
  } else if (Array.isArray(rawObs)) {
    observations = rawObs as string[];
  }
  const context = (params.context as string) || "default";

  // Upsert-returning (compass.ts idiom): the DO UPDATE no-op makes RETURNING fire
  // on conflict too, so we get the id in one statement — no read-after-write gap,
  // no concurrent-create race. entities.name is UNIQUE (0001_core.sql).
  const entity = await env.DB.prepare(
    `INSERT INTO entities (name, entity_type, primary_context) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  ).bind(name, entity_type, context).first();

  if (entity) {
    try {
      const entityText = `${name} is a ${entity_type}. Context: ${context}`;
      const entityEmbedding = await getEmbedding(env, entityText);
      await env.VECTORS.upsert([{
        id: `entity-${entity.id}`,
        values: entityEmbedding,
        metadata: { source: "entity", name, entity_type, context, created_at: new Date().toISOString() }
      }]);
    } catch (e) {
      console.log(`Failed to vectorize entity ${name}: ${e}`);
    }
  }

  let vectorizationFailures = 0;
  if (entity && observations.length) {
    for (const obs of observations) {
      const result = await env.DB.prepare(
        `INSERT INTO observations (entity_id, content, salience, emotion, weight, certainty, source, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        entity.id, obs, params.salience || "active", normalizeText(params.emotion as string),
        params.weight || "medium", params.certainty || "believed", params.source || "conversation", context
      ).run();

      // Startle fast-path — heavy-negative emotion lands a flag orient sees
      // on the very next wake, without waiting for the daemon tick.
      await checkStartle(env, result.meta.last_row_id, obs, params.emotion as string, params.weight as string);

      const obsId = `obs-${entity.id}-${result.meta.last_row_id}`;
      try {
        const embedding = await getEmbedding(env, `${name}: ${obs}`);
        await env.VECTORS.upsert([{
          id: obsId,
          values: embedding,
          metadata: {
            source: "observation", entity_name: name, entity: name, content: obs, context,
            weight: (params.weight as string) || "medium", certainty: (params.certainty as string) || "believed",
            observation_source: (params.source as string) || "conversation", added_at: new Date().toISOString()
          }
        }]);
      } catch (e) {
        vectorizationFailures++;
        console.log(`Failed to vectorize observation ${obsId}: ${e}`);
      }
    }
  }

  const vectorNote = vectorizationFailures === 0
    ? "vectorized"
    : `${observations.length - vectorizationFailures}/${observations.length} vectorized`;
  return `Entity '${name}' created/updated with ${observations.length} observations (${vectorNote})`;
}

// Detect contradictions with existing observations for the same entity
async function detectContradictions(
  env: Env, entityName: string, newContent: string, minSimilarity: number = CONTRADICTION_SIMILARITY_THRESHOLD
): Promise<Array<{ id: number; content: string; similarity: number }>> {
  try {
    const embedding = await getEmbedding(env, `${entityName}: ${newContent}`);
    const vectorResults = await env.VECTORS.query(embedding, { topK: 10, returnMetadata: "all" });

    const candidates: Array<{ id: number; content: string; similarity: number }> = [];
    for (const match of vectorResults.matches || []) {
      if (match.score < minSimilarity) continue;
      const meta = match.metadata as Record<string, string>;
      // Must be same entity
      if (meta?.entity !== entityName && meta?.entity_name !== entityName) continue;
      if (!match.id.startsWith('obs-')) continue;

      const parts = match.id.split('-');
      const obsId = parseInt(parts[parts.length - 1]);
      if (isNaN(obsId)) continue;

      // Must be active (not already superseded or expired)
      const obs = await env.DB.prepare(
        `SELECT id, content FROM observations WHERE id = ? AND archived_at IS NULL AND superseded_by IS NULL AND valid_until IS NULL`
      ).bind(obsId).first();

      if (obs) {
        candidates.push({ id: obs.id as number, content: obs.content as string, similarity: match.score });
      }
    }

    return candidates.slice(0, 5);
  } catch {
    return []; // Don't block writes if contradiction detection fails
  }
}

async function writeObservation(env: Env, params: Record<string, unknown>): Promise<string> {
  // Accept either 'entity_name' or 'name' — the same concept across entity/observation paths
  const entity_name = (params.entity_name || params.name) as string;
  if (!entity_name) return "Error: 'entity_name' (or 'name') parameter is required for adding observations";

  let rawObs = params.observations;
  let observations: string[] = [];
  if (typeof rawObs === 'string') {
    // Tolerate JSON-encoded arrays AND plain strings (treat single string as one-item array)
    const trimmed = rawObs.trim();
    if (trimmed.startsWith('[')) {
      try { observations = JSON.parse(trimmed); } catch { observations = [rawObs]; }
    } else {
      observations = [rawObs];
    }
  } else if (Array.isArray(rawObs)) {
    observations = rawObs as string[];
  }
  if (!observations.length) return "Error: 'observations' must be a non-empty array of strings (or a single string)";

  const context = (params.context as string) || "default";

  let entity = await env.DB.prepare(
    `SELECT id FROM entities WHERE name = ?`
  ).bind(entity_name).first();

  if (!entity) {
    // Upsert-returning (compass.ts idiom): if a concurrent writer created the
    // entity between our SELECT and this INSERT, the DO UPDATE no-op still makes
    // RETURNING yield the existing id. entities.name is UNIQUE (0001_core.sql).
    entity = await env.DB.prepare(
      `INSERT INTO entities (name, entity_type, primary_context) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    ).bind(entity_name, "concept", context).first();
  }

  let totalSuperseded = 0;
  let totalProposed = 0;
  let vectorizationFailures = 0;

  // AUTO_SUPERSEDE: unset = default threshold, a number = that threshold, "off" = never.
  const autoSupersede = resolveAutoSupersede(env);

  for (const obs of observations) {
    // Phase 2: Check for contradictions before writing. With AUTO_SUPERSEDE=off
    // nothing below uses them, so skip the search.
    const contradictions = autoSupersede.off
      ? []
      : await detectContradictions(env, entity_name, obs, Math.min(CONTRADICTION_SIMILARITY_THRESHOLD, autoSupersede.threshold));

    const result = await env.DB.prepare(
      `INSERT INTO observations (entity_id, content, salience, emotion, weight, certainty, source, context, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`
    ).bind(
      entity!.id, obs, params.salience || "active", normalizeText(params.emotion as string),
      params.weight || "medium", params.certainty || "believed", params.source || "conversation", context
    ).run();

    const newRowId = result.meta.last_row_id;

    // Startle fast-path — see daemon/somatic.ts checkStartle.
    await checkStartle(env, newRowId, obs, params.emotion as string, params.weight as string);

    const obsId = `obs-${entity!.id}-${newRowId}`;
    // Vectorization is best-effort — if Gemini fails, the observation row is still saved
    try {
      const embedding = await getEmbedding(env, `${entity_name}: ${obs}`);
      await env.VECTORS.upsert([{
        id: obsId,
        values: embedding,
        metadata: {
          source: "observation", entity: entity_name, content: obs, context,
          weight: (params.weight as string) || "medium", certainty: (params.certainty as string) || "believed",
          observation_source: (params.source as string) || "conversation", added_at: new Date().toISOString()
        }
      }]);
    } catch (e) {
      vectorizationFailures++;
      console.log(`Failed to vectorize observation ${obsId}: ${e}`);
    }

    // Similar observations on the same entity. Short facts (both sides at most
    // AUTO_SUPERSEDE_MAX_CHARS) are retired automatically; a long pair is never
    // retired silently — it becomes a proposal the owner accepts in ritual_tend.
    for (const old of contradictions) {
      if (old.similarity < autoSupersede.threshold) continue;
      const bothShort = obs.length <= AUTO_SUPERSEDE_MAX_CHARS && old.content.length <= AUTO_SUPERSEDE_MAX_CHARS;
      if (bothShort) {
        if (await retireObservation(env, old.id, newRowId)) totalSuperseded++;
      } else if (await proposeSupersede(env, entity!.id as number, old.id, newRowId, old.similarity, old.content.length, obs.length)) {
        totalProposed++;
      }
    }
  }

  const vectorizedCount = observations.length - vectorizationFailures;
  let msg = `Added ${observations.length} observations to '${entity_name}'`;
  if (vectorizationFailures === 0) {
    msg += ` (vectorized)`;
  } else if (vectorizedCount > 0) {
    msg += ` (${vectorizedCount} vectorized, ${vectorizationFailures} stored without vector)`;
  } else {
    msg += ` (stored without vectors — embedding API unavailable)`;
  }
  if (totalSuperseded > 0) {
    msg += `. Superseded ${totalSuperseded} older observation${totalSuperseded > 1 ? 's' : ''}.`;
  }
  if (totalProposed > 0) {
    msg += `${totalSuperseded > 0 ? ' ' : '. '}${totalProposed} older long observation${totalProposed > 1 ? 's' : ''} may be replaced by this one. Left in place; see ritual_tend to decide.`;
  }
  return msg;
}

// A long pair is never retired silently: record it as a daemon proposal
// (type "supersede": from = the old observation, to = the new one) that
// ritual_tend can accept (retire the old one) or reject (do nothing).
async function proposeSupersede(
  env: Env, entityId: number, oldId: number, newId: number,
  similarity: number, oldLength: number, newLength: number
): Promise<boolean> {
  const reason = `Possible supersede (${Math.round(similarity * 100)}% similar): #${newId} (${newLength} chars) may replace #${oldId} (${oldLength} chars). Both are long, so #${oldId} was left in place.`;
  try {
    await env.DB.prepare(`
      INSERT INTO daemon_proposals
      (proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind("supersede", oldId, newId, entityId, entityId, reason, similarity).run();
    return true;
  } catch (e) {
    console.error(`[mind_write] could not record supersede proposal for obs ${oldId} -> ${newId} (similarity ${similarity.toFixed(3)}): ${e}`);
    return false;
  }
}

async function writeRelation(env: Env, params: Record<string, unknown>): Promise<string> {
  const from_entity = params.from_entity as string;
  const to_entity = params.to_entity as string;
  const relation_type = params.relation_type as string;

  const missing: string[] = [];
  if (!from_entity) missing.push("from_entity");
  if (!to_entity) missing.push("to_entity");
  if (!relation_type) missing.push("relation_type");
  if (missing.length) {
    return `Error: relation requires ${missing.join(", ")}`;
  }

  await env.DB.prepare(
    `INSERT INTO relations (from_entity, to_entity, relation_type, from_context, to_context, store_in)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    from_entity, to_entity, relation_type,
    params.from_context || "default", params.to_context || "default", params.store_in || "default"
  ).run();

  return `Relation created: ${from_entity} --[${relation_type}]--> ${to_entity}`;
}

async function writeJournal(env: Env, params: Record<string, unknown>): Promise<string> {
  const entry = params.entry as string;
  if (!entry || typeof entry !== "string" || !entry.trim()) {
    return "Error: 'entry' parameter is required and must be a non-empty string for journal writes";
  }
  const tags = JSON.stringify(params.tags || []);
  const emotion = params.emotion as string;
  const entry_date = new Date().toISOString().split('T')[0];

  const result = await env.DB.prepare(
    `INSERT INTO journals (entry_date, content, tags, emotion) VALUES (?, ?, ?, ?)`
  ).bind(entry_date, entry, tags, normalizeText(emotion)).run();

  const journalId = `journal-${result.meta.last_row_id}`;
  let vectorized = true;
  try {
    const embedding = await getEmbedding(env, entry);
    const journalMetadata: Record<string, string> = {
      source: "journal", title: entry_date, content: entry, added_at: new Date().toISOString()
    };
    if (emotion) journalMetadata.emotion = normalizeText(emotion) || emotion;

    await env.VECTORS.upsert([{
      id: journalId, values: embedding, metadata: journalMetadata
    }]);
  } catch (e) {
    vectorized = false;
    console.log(`Failed to vectorize journal ${journalId}: ${e}`);
  }

  return `Journal entry recorded for ${entry_date}${vectorized ? " (vectorized)" : " (stored without vector)"}`;
}
