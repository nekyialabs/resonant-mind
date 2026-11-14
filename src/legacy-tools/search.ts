/**
 * handleMindSearch — vector + text search across the mind.
 * Mood tinting, filters, multi-factor composite scoring, access tracking.
 *
 * the shared-engine audit E-3: this reads as a pure query in name and registry
 * description, but it has a hidden write side-effect — access-tracking
 * (`access_count`/`last_accessed_at`) is bumped for surfaced observations via
 * recordAccessTracking. Not a collision (no second tool claims this write),
 * but a future "make search read-only for safety" assumption would be wrong.
 */

import type { Env } from "../types";
import { getEmbedding, searchVectors, imageUrl } from "../shared/mind-helpers";
import { getSubconsciousState, recordAccessTracking } from "../daemon/state";
import { SEARCH_SCORING, RECENCY_DECAY_RATE, ACCESS_GROWTH_RATE } from "../shared/constants";
import { clampLimit } from "../shared/limits";
import { escapeLike } from "../shared/text";

export async function handleMindSearch(env: Env, params: Record<string, unknown>): Promise<string> {
  const query = params.query as string;
  const n_results = clampLimit(params.n_results, 10);

  // Filter parameters
  const filterKeyword = params.keyword as string | undefined;
  const filterSource = params.source as string | undefined;
  const filterEntity = params.entity as string | undefined;
  const filterWeight = params.weight as string | undefined;
  const filterDateFrom = params.date_from as string | undefined;
  const filterDateTo = params.date_to as string | undefined;
  const filterType = params.type as string | undefined;
  const hasFilters = filterKeyword || filterSource || filterEntity || filterWeight || filterDateFrom || filterDateTo || filterType;

  // Get subconscious mood for tinting
  const subconscious = await getSubconsciousState(env);
  const mood = subconscious?.mood?.dominant;

  // Mood tinting - augment query with emotional context
  let tintedQuery = query;
  let moodNote = "";
  if (mood && subconscious?.mood?.confidence !== "low") {
    const moodTints: Record<string, string> = {
      "tender": "warm, gentle, caring, soft",
      "pride": "accomplishment, growth, achievement, recognition",
      "joy": "happiness, delight, pleasure, celebration",
      "curiosity": "wondering, exploring, investigating, discovering",
      "melancholy": "reflective, wistful, quiet, contemplative",
      "intensity": "passionate, urgent, fierce, powerful",
      "gratitude": "thankful, appreciative, blessed, fortunate",
      "longing": "yearning, missing, wanting, desire"
    };
    const tint = moodTints[mood] || mood;
    tintedQuery = `${query} (context: ${tint})`;
    moodNote = `*Search tinted by current mood: ${mood}*

`;
  }

  // Search with tinted query — fetch more when filtering by type
  const searchLimit = filterType ? n_results * 10 : n_results;
  const vectorResults = await searchVectors(env, tintedQuery, searchLimit);

  if (!vectorResults.matches?.length) {
    // Fall back to text search
    const textResults = await env.DB.prepare(
      `SELECT 'entity' as source, name as title, content
       FROM entities e JOIN observations o ON e.id = o.entity_id
       WHERE o.content LIKE ? ESCAPE '\\'
       UNION ALL
       SELECT 'journal' as source, entry_date as title, content
       FROM journals WHERE content LIKE ? ESCAPE '\\'
       LIMIT ?`
    ).bind(`%${escapeLike(query)}%`, `%${escapeLike(query)}%`, n_results).all();

    if (!textResults.results?.length) {
      return "No results found.";
    }

    let output = `## Search Results (text match)\n\n` + moodNote;
    for (const r of textResults.results) {
      output += `**[${r.source}] ${r.title}**
${String(r.content).slice(0, 300)}...

`;
    }
    return output;
  }

  // Separate entities, observations, and images for display
  const entityMatches: typeof vectorResults.matches = [];
  const obsMatches: typeof vectorResults.matches = [];
  const imageMatches: typeof vectorResults.matches = [];

  for (const match of vectorResults.matches) {
    const meta = match.metadata as Record<string, string>;
    const matchType = meta?.source === 'entity' ? 'entity'
      : (meta?.source === 'image' || match.id.startsWith('img-')) ? 'image'
      : match.id.startsWith('journal-') ? 'journal'
      : 'observation';

    // Apply type filter if set
    if (filterType && matchType !== filterType) continue;

    if (matchType === 'entity') {
      entityMatches.push(match);
    } else if (matchType === 'image') {
      imageMatches.push(match);
    } else {
      obsMatches.push(match);
    }
  }

  let output = `## Search Results\n\n` + moodNote;

  // Show highly relevant entities first
  const relevantEntities = entityMatches.filter(m => m.score > 0.7);
  if (relevantEntities.length > 0) {
    output += `**Entities:**\n`;
    for (const match of relevantEntities.slice(0, 5)) {
      const meta = match.metadata as Record<string, string>;
      output += `- **${meta?.name}** (${meta?.entity_type}) [${(match.score * 100).toFixed(0)}%]\n`;
    }
    output += "\n";
  }

  // Show observations - check archive status from database
  if (obsMatches.length > 0) {
    // Extract observation IDs to check archive status
    const obsIds: number[] = [];
    for (const match of obsMatches) {
      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        if (parts.length >= 3) {
          obsIds.push(parseInt(parts[2]));
        }
      }
    }

    // Get observation details from D1 for filtering and display
    let obsDetails = new Map<number, {
      source: string | null;
      entity_name: string;
      weight: string | null;
      source_date: string | null;
      archived_at: string | null;
      content: string;
      access_count: number;
      added_at: string | null;
      emotion: string | null;
      valid_until: string | null;
      superseded_by: number | null;
    }>();

    if (obsIds.length > 0) {
      try {
        const placeholders = obsIds.map(() => '?').join(',');
        const obsData = await env.DB.prepare(`
          SELECT o.id, o.source, o.weight, o.source_date, o.archived_at, o.content, e.name as entity_name,
                 COALESCE(o.access_count, 0) as access_count, o.added_at, o.emotion,
                 o.valid_until, o.superseded_by
          FROM observations o
          JOIN entities e ON o.entity_id = e.id
          WHERE o.id IN (${placeholders})
        `).bind(...obsIds).all();

        for (const o of (obsData.results || [])) {
          obsDetails.set(o.id as number, {
            source: o.source as string | null,
            entity_name: o.entity_name as string,
            weight: o.weight as string | null,
            source_date: o.source_date as string | null,
            archived_at: o.archived_at as string | null,
            content: o.content as string,
            access_count: (o.access_count as number) || 0,
            added_at: o.added_at as string | null,
            emotion: o.emotion as string | null,
            valid_until: o.valid_until as string | null,
            superseded_by: o.superseded_by as number | null,
          });
        }
      } catch (e) {
        // Fallback if query fails
      }
    }

    // Apply filters if any
    let filteredMatches = obsMatches;
    if (hasFilters && obsDetails.size > 0) {
      filteredMatches = obsMatches.filter(match => {
        if (!match.id.startsWith('obs-')) return true;
        const parts = match.id.split('-');
        if (parts.length < 3) return true;
        const obsId = parseInt(parts[2]);
        const details = obsDetails.get(obsId);
        if (!details) return true;

        // Apply filters
        if (filterKeyword && !details.content.toLowerCase().includes(filterKeyword.toLowerCase())) return false;
        if (filterSource && details.source !== filterSource) return false;
        if (filterEntity && details.entity_name.toLowerCase() !== filterEntity.toLowerCase()) return false;
        if (filterWeight && details.weight !== filterWeight) return false;
        if (filterDateFrom && (!details.source_date || details.source_date < filterDateFrom)) return false;
        if (filterDateTo && (!details.source_date || details.source_date > filterDateTo)) return false;

        return true;
      });
    }

    // Phase 2: Filter out superseded/expired observations by default
    const includeExpired = params.include_expired as boolean;
    if (!includeExpired && obsDetails.size > 0) {
      filteredMatches = filteredMatches.filter(match => {
        if (!match.id.startsWith('obs-')) return true;
        const parts = match.id.split('-');
        if (parts.length < 3) return true;
        const obsId = parseInt(parts[2]);
        const details = obsDetails.get(obsId);
        if (!details) return true;
        if (details.valid_until && new Date(details.valid_until) < new Date()) return false;
        if (details.superseded_by) return false;
        return true;
      });
    }

    // Phase 1: Multi-factor composite scoring
    const now = Date.now();
    const importanceMap: Record<string, number> = { heavy: 1.0, medium: 0.6, light: 0.3 };

    const scoredMatches = filteredMatches.map(match => {
      const similarity = match.score;
      let compositeScore = similarity; // fallback if no details

      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        if (parts.length >= 3) {
          const obsId = parseInt(parts[2]);
          const details = obsDetails.get(obsId);
          if (details) {
            const addedAt = details.added_at ? new Date(details.added_at).getTime() : now;
            const daysSince = Math.max(0, (now - addedAt) / 86400000);
            const recencyScore = Math.exp(-RECENCY_DECAY_RATE * daysSince);
            const importanceScore = importanceMap[details.weight || 'medium'] || 0.6;
            const accessScore = 1.0 - Math.exp(-ACCESS_GROWTH_RATE * (details.access_count || 0));
            const emotionBoost = (mood && details.emotion === mood) ? 0.1 : 0;

            compositeScore =
              SEARCH_SCORING.alpha * similarity +
              SEARCH_SCORING.beta * recencyScore +
              SEARCH_SCORING.gamma * importanceScore +
              SEARCH_SCORING.delta * accessScore +
              emotionBoost;
          }
        }
      }

      return { ...match, compositeScore };
    });

    scoredMatches.sort((a, b) => b.compositeScore - a.compositeScore);

    // Track access for returned observation IDs
    const accessedObsIds: number[] = [];
    const accessedImgIds: number[] = [];
    for (const match of scoredMatches.slice(0, n_results)) {
      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        if (parts.length >= 3) accessedObsIds.push(parseInt(parts[2]));
      }
    }
    for (const match of imageMatches) {
      const imgId = parseInt(match.id.replace('img-', ''));
      if (!isNaN(imgId)) accessedImgIds.push(imgId);
    }
    recordAccessTracking(env, accessedObsIds, accessedImgIds).catch(() => {});

    // Build filter description
    let filterDesc = "";
    if (hasFilters) {
      const parts: string[] = [];
      if (filterKeyword) parts.push(`keyword="${filterKeyword}"`);
      if (filterSource) parts.push(`source=${filterSource}`);
      if (filterEntity) parts.push(`entity=${filterEntity}`);
      if (filterWeight) parts.push(`weight=${filterWeight}`);
      if (filterDateFrom) parts.push(`from=${filterDateFrom}`);
      if (filterDateTo) parts.push(`to=${filterDateTo}`);
      filterDesc = `\n*Filters: ${parts.join(', ')}*\n`;
    }

    output += `**Observations:**${filterDesc}\n`;
    for (const match of scoredMatches.slice(0, n_results)) {
      const meta = match.metadata as Record<string, string>;
      const label = meta?.entity || meta?.entity_name || meta?.title || match.id;
      const sourceType = meta?.source || 'unknown';
      const context = meta?.context ? ` [${meta.context}]` : '';

      // Get details from D1 if available
      let obsId: number | null = null;
      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        if (parts.length >= 3) obsId = parseInt(parts[2]);
      }
      const details = obsId ? obsDetails.get(obsId) : null;
      const isArchived = details?.archived_at != null;
      const archivedTag = isArchived ? ' [archived]' : '';
      const supersededTag = details?.superseded_by ? ' [superseded]' : '';
      const sourceTag = details?.source ? ` (${details.source})` : '';
      const dateTag = details?.source_date ? ` [${details.source_date}]` : '';
      const displayScore = ((match as any).compositeScore * 100).toFixed(1);

      output += `**[${sourceType}]${context} ${label}**${archivedTag}${supersededTag}${sourceTag}${dateTag} (${displayScore}%)\n`;
      output += `${meta?.content?.slice(0, 300) || ''}...\n\n`;
    }
  }

  // Show image matches with viewable URLs
  if (imageMatches.length > 0) {
    output += `**Images:**\n`;
    for (const match of imageMatches) {
      const meta = match.metadata as Record<string, string>;
      const score = (match.score * 100).toFixed(1);
      const imgId = match.id.replace("img-", "");
      const entityTag = meta?.entity ? ` -> ${meta.entity}` : "";
      const emotionTag = meta?.emotion ? ` [${meta.emotion}]` : "";
      output += `**${match.id}** (${score}%)${entityTag}${emotionTag}\n`;
      output += `${meta?.description || "No description"}\n`;
      output += `View: ${await imageUrl(imgId, env)}\n\n`;
    }
  }

  // Show dream matches
  const dreamMatches = vectorResults.matches?.filter(m => m.id.startsWith('dream-')) || [];
  if (dreamMatches.length > 0) {
    output += `**Dreams:**\n`;
    for (const match of dreamMatches) {
      const meta = match.metadata as Record<string, string>;
      const score = (match.score * 100).toFixed(1);
      const dreamDate = meta?.dream_date || 'unknown';
      const recurring = meta?.recurring === 'yes' ? ' [recurring]' : '';
      output += `**dream ${dreamDate}**${recurring} (${score}%)\n`;
      output += `${meta?.content?.slice(0, 300) || ''}...\n\n`;
    }
  }

  return output;
}
