/**
 * handleMindSurface — the living surface. Mind reorganization through use.
 * The act of surfacing changes what surfaces next.
 *
 * Includes private helpers: MOOD_TINTS, buildResonanceQuery, handleMindSurfaceFallback.
 * Delegates spark mode to handleMindSurfaceSpark.
 */

import type { Env } from "../types";
import { searchVectors, imageUrl } from "../shared/mind-helpers";
import {
  getSubconsciousState,
  recordCoSurfacing,
  recordAccessTracking,
  updateSurfaceTracking,
} from "../daemon/state";
import { getNoveltyPool, getDormantPool } from "../daemon/pools";
import { SURFACE_POOL_RATIOS, VECTOR_SCORE_CORE, VECTOR_SCORE_EDGE } from "../shared/constants";
import { handleMindSurfaceSpark } from "./surface-spark";
import { clampLimit } from "../shared/limits";

// ============ LIVING SURFACE: Mind Reorganization Through Use ============
// The act of surfacing changes what surfaces next

const MOOD_TINTS: Record<string, string> = {
  "tender": "warmth, connection, gentle feelings, soft moments, caring, love",
  "pride": "accomplishment, growth, recognition, achievement, becoming",
  "joy": "happiness, delight, celebration, good moments, pleasure",
  "curiosity": "questions, wondering, exploring, discovering, learning",
  "melancholy": "loss, missing, reflection, what was, quiet sadness, grief",
  "intensity": "passion, urgency, drive, power, wanting, fierce",
  "gratitude": "thankfulness, appreciation, gifts, blessings",
  "longing": "yearning, desire, missing, wanting, reaching for",
  "recognition": "understanding, seeing clearly, knowing, awareness, insight"
};

// Build resonance query from mood and context
function buildResonanceQuery(query: string | undefined, mood: string | undefined, hotEntities: any[]): { resonanceQuery: string; moodContext: string } {
  let resonanceQuery = "";
  let moodContext = "";

  if (query) {
    resonanceQuery = query;
    moodContext = `Directed: "${query}"`;
    if (mood) {
      const tint = MOOD_TINTS[mood] || mood;
      resonanceQuery = `${query} (feeling: ${tint})`;
      moodContext = `Directed: "${query}" | Mood: ${mood}`;
    }
  } else if (mood) {
    resonanceQuery = MOOD_TINTS[mood] || mood;
    moodContext = `Mood: ${mood}`;
    if (hotEntities.length > 0) {
      const hotNames = hotEntities.slice(0, 3).map(e => e.name).join(", ");
      resonanceQuery += ` (related to: ${hotNames})`;
      moodContext += ` | Hot: ${hotNames}`;
    }
  }

  return { resonanceQuery, moodContext };
}

export async function handleMindSurface(env: Env, params: Record<string, unknown>): Promise<string> {
  const mode = (params.mode as string) || "resonant";

  // Spark mode: random associative surfacing with hot-entity bias
  if (mode === "spark") {
    return handleMindSurfaceSpark(env, params);
  }

  // Resonant mode (default): mood/emotion-based 3-pool surfacing
  const includeMetabolized = params.include_metabolized as boolean || false;
  const limit = clampLimit(params.limit, 10);
  const query = params.query as string;

  // Get subconscious state for current mood
  const subconscious = await getSubconsciousState(env);
  const mood = subconscious?.mood?.dominant;
  const hotEntities = subconscious?.hot_entities || [];

  // Build resonance query
  const { resonanceQuery, moodContext } = buildResonanceQuery(query, mood, hotEntities);

  // If no mood and no query, fall back to queue-based
  if (!resonanceQuery) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // === THE FOUR POOLS ===
  // Four pools: core resonance, novelty injection, dormant rotation, edge exploration

  const coreLimit = Math.ceil(limit * SURFACE_POOL_RATIOS.core);
  const noveltyLimit = Math.ceil(limit * SURFACE_POOL_RATIOS.novelty);
  const dormantLimit = Math.ceil(limit * SURFACE_POOL_RATIOS.dormant);
  const edgeLimit = Math.max(1, limit - coreLimit - noveltyLimit - dormantLimit);

  // Pool 1: Core resonance - high similarity matches
  const vectorResults = await searchVectors(env, resonanceQuery, coreLimit * 4);

  // Filter to observations AND images
  const allMatches = vectorResults.matches?.filter(m =>
    m.metadata?.source === "observation" || m.id.startsWith("obs-") ||
    m.metadata?.source === "image" || m.id.startsWith("img-")
  ) || [];

  // Split into core (high similarity) and edge (medium similarity)
  const coreMatches = allMatches.filter(m => (m.score || 0) >= VECTOR_SCORE_CORE);
  const edgeMatches = allMatches.filter(m => (m.score || 0) >= VECTOR_SCORE_EDGE && (m.score || 0) < VECTOR_SCORE_CORE);

  // Extract IDs - different format for observations vs images
  const extractId = (id: string): { type: 'observation' | 'image'; id: number } | null => {
    if (id.startsWith("img-")) {
      const imgId = parseInt(id.split('-')[1]);
      return isNaN(imgId) ? null : { type: 'image', id: imgId };
    } else if (id.startsWith("obs-")) {
      const parts = id.split('-');
      const obsId = parts.length >= 3 ? parseInt(parts[2]) : null;
      return obsId !== null && !isNaN(obsId) ? { type: 'observation', id: obsId } : null;
    }
    return null;
  };

  // Separate score maps for observations and images
  const obsScoreMap: Record<number, { score: number; pool: string }> = {};
  const imgScoreMap: Record<number, { score: number; pool: string }> = {};

  for (const match of coreMatches) {
    const extracted = extractId(match.id);
    if (extracted) {
      const targetMap = extracted.type === 'observation' ? obsScoreMap : imgScoreMap;
      targetMap[extracted.id] = { score: match.score || 0.7, pool: 'core' };
    }
  }

  for (const match of edgeMatches.slice(0, edgeLimit * 2)) {
    const extracted = extractId(match.id);
    if (extracted) {
      const targetMap = extracted.type === 'observation' ? obsScoreMap : imgScoreMap;
      if (!targetMap[extracted.id]) {
        targetMap[extracted.id] = { score: match.score || 0.5, pool: 'edge' };
      }
    }
  }

  // Pool 3: Novelty injection - things that haven't surfaced recently (observations only for now)
  const noveltyObs = await getNoveltyPool(env, noveltyLimit, includeMetabolized);
  for (const obs of noveltyObs) {
    if (!obsScoreMap[obs.id]) {
      obsScoreMap[obs.id] = { score: obs.current_novelty || 0.8, pool: 'novelty' };
    }
  }

  // Pool 4: Dormant rotation - observations from entities that haven't surfaced in 14+ days
  // Breaks the feedback loop where only hot/recent entities get surfaced
  const dormantObs = await getDormantPool(env, dormantLimit, includeMetabolized);
  for (const obs of dormantObs) {
    if (!obsScoreMap[obs.id]) {
      obsScoreMap[obs.id] = { score: 0.7, pool: 'dormant' };
    }
  }

  const allObsIds = Object.keys(obsScoreMap).map(id => parseInt(id));
  const allImgIds = Object.keys(imgScoreMap).map(id => parseInt(id));

  if (allObsIds.length === 0 && allImgIds.length === 0) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // Fetch full observation data
  const chargeFilter = includeMetabolized
    ? "o.archived_at IS NULL"
    : "(o.charge != 'metabolized' OR o.charge IS NULL) AND o.archived_at IS NULL";

  let obsResults: any[] = [];
  if (allObsIds.length > 0) {
    const obsPlaceholders = allObsIds.map(() => '?').join(',');
    const obsQuery = await env.DB.prepare(`
      SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, o.added_at,
             o.resolution_note, o.novelty_score, o.last_surfaced_at, o.surface_count,
             o.certainty, o.source,
             e.name as entity_name, e.entity_type
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.id IN (${obsPlaceholders}) AND ${chargeFilter}
    `).bind(...allObsIds).all();
    obsResults = obsQuery.results || [];
  }

  // Fetch full image data
  let imgResults: any[] = [];
  if (allImgIds.length > 0) {
    const imgChargeFilter = includeMetabolized
      ? "1=1"
      : "(i.charge != 'metabolized' OR i.charge IS NULL)";
    const imgPlaceholders = allImgIds.map(() => '?').join(',');
    const imgQuery = await env.DB.prepare(`
      SELECT i.id, i.description, i.path, i.context, i.emotion, i.weight, i.charge,
             i.created_at as added_at, i.novelty_score, i.last_surfaced_at, i.surface_count,
             e.name as entity_name, e.entity_type
      FROM images i
      LEFT JOIN entities e ON i.entity_id = e.id
      WHERE i.id IN (${imgPlaceholders}) AND ${imgChargeFilter}
    `).bind(...allImgIds).all();
    imgResults = imgQuery.results || [];
  }

  if (obsResults.length === 0 && imgResults.length === 0) {
    return await handleMindSurfaceFallback(env, includeMetabolized, limit);
  }

  // Affect-modulated salience (L3, 2026-07-02): under distress (negative
  // valence + high arousal from the limbic layer), heavy and actively-charged
  // memories surface preferentially — threat-state attention narrows to what
  // carries weight. Calm states run the resting numbers.
  const affectMood = subconscious?.mood as { valence?: number | null; arousal?: number | null } | undefined;
  const distressed =
    typeof affectMood?.valence === 'number' && typeof affectMood?.arousal === 'number' &&
    affectMood.valence <= -0.25 && affectMood.arousal >= 0.5;
  const heavyMult = distressed ? 1.8 : 1.5;
  const mediumMult = distressed ? 1.3 : 1.2;
  const chargeBoostVal = distressed ? 0.25 : 0.15;

  // Score observations: base score * weight multiplier * novelty boost
  const weightedObsResults = obsResults.map(obs => {
    const obsId = obs.id as number;
    const baseScore = obsScoreMap[obsId]?.score || 0.5;
    const pool = obsScoreMap[obsId]?.pool || 'core';
    const weightMultiplier = obs.weight === 'heavy' ? heavyMult : obs.weight === 'medium' ? mediumMult : 1.0;

    // Novelty boost for things that haven't surfaced in a while
    const noveltyScore = (obs.novelty_score as number) || 1.0;
    const noveltyBoost = pool === 'novelty' ? 0.3 : (noveltyScore > 0.7 ? 0.1 : 0);

    // Charge boost - observations being actively processed should resurface
    const charge = (obs.charge as string) || 'fresh';
    const chargeBoost = (charge === 'active' || charge === 'processing') ? chargeBoostVal : 0;

    return {
      ...obs,
      memoryType: 'observation' as const,
      pool,
      resonanceScore: (baseScore * weightMultiplier) + noveltyBoost + chargeBoost
    };
  });

  // Score images: same logic as observations
  const weightedImgResults = imgResults.map(img => {
    const imgId = img.id as number;
    const baseScore = imgScoreMap[imgId]?.score || 0.5;
    const pool = imgScoreMap[imgId]?.pool || 'core';
    const weightMultiplier = img.weight === 'heavy' ? heavyMult : img.weight === 'medium' ? mediumMult : 1.0;

    const noveltyScore = (img.novelty_score as number) || 1.0;
    const noveltyBoost = noveltyScore > 0.7 ? 0.1 : 0;

    const charge = (img.charge as string) || 'fresh';
    const chargeBoost = (charge === 'active' || charge === 'processing') ? chargeBoostVal : 0;

    return {
      ...img,
      memoryType: 'image' as const,
      pool,
      resonanceScore: (baseScore * weightMultiplier) + noveltyBoost + chargeBoost
    };
  });

  // Combine and sort all results
  const weightedResults = [...weightedObsResults, ...weightedImgResults];
  weightedResults.sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));

  // Ensure mix from different pools - don't let one pool dominate completely
  const finalResults: any[] = [];
  const byPool = { core: [] as any[], edge: [] as any[], novelty: [] as any[], dormant: [] as any[] };

  for (const item of weightedResults) {
    byPool[item.pool as keyof typeof byPool]?.push(item);
  }

  // Take from each pool proportionally, then fill with best remaining
  const takeFromPool = (pool: any[], max: number) => {
    const taken = pool.splice(0, max);
    finalResults.push(...taken);
    return taken.length;
  };

  takeFromPool(byPool.core, coreLimit);
  takeFromPool(byPool.novelty, noveltyLimit);
  takeFromPool(byPool.dormant, dormantLimit);
  takeFromPool(byPool.edge, edgeLimit);

  // Fill remaining slots with best available
  const remaining = [...byPool.core, ...byPool.novelty, ...byPool.dormant, ...byPool.edge]
    .sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));
  while (finalResults.length < limit && remaining.length > 0) {
    finalResults.push(remaining.shift()!);
  }

  // Re-sort final results by score
  finalResults.sort((a, b) => (b.resonanceScore || 0) - (a.resonanceScore || 0));
  const limitedResults = finalResults.slice(0, limit);

  // === SIDE EFFECTS: Surfacing changes future surfacing ===
  const surfacedObsIds = limitedResults.filter(r => r.memoryType === 'observation').map(o => o.id as number);
  const surfacedImgIds = limitedResults.filter(r => r.memoryType === 'image').map(i => i.id as number);

  // Record co-surfacing, surface tracking, and access tracking
  try {
    await Promise.all([
      recordCoSurfacing(env, surfacedObsIds),  // TODO: extend co-surfacing for images
      updateSurfaceTracking(env, surfacedObsIds, surfacedImgIds),
      recordAccessTracking(env, surfacedObsIds, surfacedImgIds)
    ]);
  } catch (e) {
    console.log(`Surface tracking error: ${e}`);
  }

  // === FORMAT OUTPUT ===
  const poolCounts = { core: 0, edge: 0, novelty: 0, dormant: 0 };
  const typeCounts = { observation: 0, image: 0 };
  for (const item of limitedResults) {
    poolCounts[item.pool as keyof typeof poolCounts]++;
    typeCounts[item.memoryType as keyof typeof typeCounts]++;
  }

  let output = `## What's Surfacing\n\n*${moodContext}*\n`;
  output += `*Mix: ${poolCounts.core} resonance, ${poolCounts.novelty} novelty, ${poolCounts.dormant} dormant, ${poolCounts.edge} edge`;
  if (typeCounts.image > 0) {
    output += ` | ${typeCounts.observation} observations, ${typeCounts.image} images`;
  }
  output += `*\n\n`;

  for (const item of limitedResults) {
    const charge = item.charge || 'fresh';
    const emotionTag = item.emotion ? ` [${item.emotion}]` : '';
    const chargeIcon = charge === 'metabolized' ? '✓' : charge === 'processing' ? '◐' : charge === 'active' ? '○' : '●';
    const resonance = Math.round((item.resonanceScore || 0) * 100);
    const poolTag = item.pool === 'novelty' ? ' ✨' : item.pool === 'dormant' ? ' \u{1F504}' : item.pool === 'edge' ? ' ↔' : '';

    if (item.memoryType === 'image') {
      // Image formatting
      output += `**📷 #${item.id}** ${chargeIcon} [${item.weight}|${charge}] ${resonance}%${poolTag}${emotionTag}\n`;
      if (item.entity_name) {
        output += `**${item.entity_name}**: `;
      }
      output += `${item.description}\n`;
      output += `View: ${await imageUrl(item.id, env)}\n`;
    } else {
      // Observation formatting (original)
      const certaintyIcon = item.certainty === 'known' ? '✓' : item.certainty === 'tentative' ? '?' : '';
      const sourceTag = item.source && item.source !== 'conversation' ? ` [${item.source}]` : '';

      output += `**#${item.id}** ${chargeIcon}${certaintyIcon} [${item.weight}|${charge}] ${resonance}%${poolTag}${emotionTag}${sourceTag}\n`;
      output += `**${item.entity_name}** (${item.entity_type}): ${item.content}\n`;

      if (charge === 'metabolized' && item.resolution_note) {
        output += `↳ *Resolved:* ${item.resolution_note}\n`;
      }
    }

    output += "\n";
  }

  // Summary
  const fresh = limitedResults.filter(o => (o.charge || 'fresh') === 'fresh').length;
  const active = limitedResults.filter(o => o.charge === 'active').length;
  const processing = limitedResults.filter(o => o.charge === 'processing').length;

  output += `---\n● fresh: ${fresh} | ○ active: ${active} | ◐ processing: ${processing}`;
  if (includeMetabolized) {
    const metabolized = limitedResults.filter(o => o.charge === 'metabolized').length;
    output += ` | ✓ metabolized: ${metabolized}`;
  }
  output += `\n✨ = novelty | \u{1F504} = dormant | ↔ = edge`;

  return output;
}

// Fallback to queue-based surfacing when no mood/vectors available
async function handleMindSurfaceFallback(env: Env, includeMetabolized: boolean, limit: number): Promise<string> {
  const chargeFilter = includeMetabolized
    ? "o.archived_at IS NULL"
    : "(o.charge != 'metabolized' OR o.charge IS NULL) AND o.archived_at IS NULL";

  const results = await env.DB.prepare(`
    SELECT o.id, o.content, o.weight, o.charge, o.sit_count, o.emotion, o.added_at,
           o.resolution_note, o.novelty_score, o.certainty, o.source,
           e.name as entity_name, e.entity_type
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE ${chargeFilter}
    ORDER BY
      COALESCE(o.novelty_score, 1.0) DESC,
      CASE o.weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      CASE o.charge WHEN 'active' THEN 4 WHEN 'processing' THEN 3 WHEN 'fresh' THEN 2 ELSE 1 END DESC,
      o.added_at ASC
    LIMIT ?
  `).bind(limit).all();

  if (!results.results?.length) {
    return "No emotional observations to surface.";
  }

  // Update surface tracking for fallback too
  const surfacedIds = results.results.map(o => o.id as number);
  try {
    await Promise.all([
      recordCoSurfacing(env, surfacedIds),
      updateSurfaceTracking(env, surfacedIds)
    ]);
  } catch (e) {
    console.log(`Surface tracking error (fallback): ${e}`);
  }

  let output = "## What's Surfacing\n\n*No mood detected — showing by novelty/weight/age*\n\n";

  for (const obs of results.results) {
    const charge = obs.charge || 'fresh';
    const sitCount = obs.sit_count || 0;
    const emotionTag = obs.emotion ? ` [${obs.emotion}]` : '';
    const chargeIcon = charge === 'metabolized' ? '✓' : charge === 'processing' ? '◐' : charge === 'active' ? '○' : '●';
    const novelty = Math.round((obs.novelty_score as number || 1.0) * 100);

    // Certainty indicator: ✓ known, ? tentative, nothing for believed
    const certaintyIcon = obs.certainty === 'known' ? '✓' : obs.certainty === 'tentative' ? '?' : '';
    // Source tag: only show if not the default 'conversation'
    const sourceTag = obs.source && obs.source !== 'conversation' ? ` [${obs.source}]` : '';

    output += `**#${obs.id}** ${chargeIcon}${certaintyIcon} [${obs.weight}|${charge}] novelty: ${novelty}%${emotionTag}${sourceTag}\n`;
    output += `**${obs.entity_name}** (${obs.entity_type}): ${obs.content}\n`;

    if (charge === 'metabolized' && obs.resolution_note) {
      output += `↳ *Resolved:* ${obs.resolution_note}\n`;
    }

    output += "\n";
  }

  const fresh = results.results.filter(o => (o.charge || 'fresh') === 'fresh').length;
  const active = results.results.filter(o => o.charge === 'active').length;
  const processing = results.results.filter(o => o.charge === 'processing').length;

  output += `---\n● fresh: ${fresh} | ○ active: ${active} | ◐ processing: ${processing}`;
  if (includeMetabolized) {
    const metabolized = results.results.filter(o => o.charge === 'metabolized').length;
    output += ` | ✓ metabolized: ${metabolized}`;
  }

  return output;
}
