/**
 * handleMindPatterns — text view: mood, what's alive, emotional weight, activity,
 * salience distribution, foundational core.
 */

import type { Env } from "../types";
import { getSubconsciousState } from "../daemon/state";
import { clampLimit } from "../shared/limits";

export async function handleMindPatterns(env: Env, params: Record<string, unknown>): Promise<string> {
  const days = clampLimit(params.days, 7);
  const includeAllTime = (params.include_all_time as boolean) !== false;

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Get subconscious state for mood and hot entities
    const subconscious = await getSubconsciousState(env);
    const hotEntities = subconscious?.hot_entities || [];
    const hotMap = new Map(hotEntities.map((e: any) => [e.name, e.warmth]));

    const activity = await env.DB.prepare(
      `SELECT e.name, COUNT(o.id) as obs_count
       FROM entities e
       LEFT JOIN observations o ON e.id = o.entity_id AND o.added_at > ?
       GROUP BY e.id, e.name
       HAVING COUNT(o.id) > 0
       ORDER BY COUNT(o.id) DESC
       LIMIT 15`
    ).bind(cutoff).all();

    // Blend activity with warmth
    const blendedFocus: Array<{entity: string; observations: number; warmth?: number}> = [];
    for (const item of activity.results || []) {
      const name = item.name as string;
      const warmth = hotMap.get(name);
      blendedFocus.push({
        entity: name,
        observations: item.obs_count as number,
        warmth: warmth as number | undefined
      });
    }
    // Sort by warmth first, then observations
    blendedFocus.sort((a, b) => {
      const warmthA = a.warmth || 0;
      const warmthB = b.warmth || 0;
      if (warmthA !== warmthB) return warmthB - warmthA;
      return b.observations - a.observations;
    });

    const salience = await env.DB.prepare(
      `SELECT salience, COUNT(*) as count FROM observations GROUP BY salience`
    ).all();

    const salienceMap: Record<string, number> = {};
    for (const row of salience.results || []) {
      salienceMap[row.salience as string || 'unset'] = row.count as number;
    }

    const weights = await env.DB.prepare(
      `SELECT weight, COUNT(*) as count FROM observations WHERE added_at > ? GROUP BY weight`
    ).bind(cutoff).all();

    // Get total observations for activity summary
    const totalObs = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE added_at > ?`
    ).bind(cutoff).first() as {count: number} | null;
    const totalRecent = totalObs?.count || 0;
    const dailyAvg = Math.round((totalRecent / days) * 10) / 10;

    const output: string[] = [];
    output.push("=".repeat(60));
    output.push(`PATTERNS — Last ${days} days`);
    output.push("=".repeat(60));

    // ═══════════════════════════════════════════════════════════
    // MOOD - from subconscious
    // ═══════════════════════════════════════════════════════════
    const mood = subconscious?.mood;
    if (mood && mood.dominant && mood.dominant !== "neutral") {
      output.push("");
      output.push("-".repeat(60));
      output.push("MOOD");
      output.push("-".repeat(60));
      output.push(`  Current: ${mood.dominant}`);
      if (mood.undercurrent) {
        output.push(`  Undercurrent: ${mood.undercurrent}`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // WHAT'S ALIVE - blended with warmth
    // ═══════════════════════════════════════════════════════════
    output.push("");
    output.push("-".repeat(60));
    output.push("WHAT'S ALIVE");
    output.push("-".repeat(60));

    if (blendedFocus.length) {
      for (const item of blendedFocus.slice(0, 10)) {
        if (item.warmth) {
          output.push(`  - ${item.entity} (${item.observations} obs, warmth: ${item.warmth.toFixed(1)})`);
        } else {
          output.push(`  - ${item.entity} (${item.observations} obs)`);
        }
      }
    } else {
      output.push("  (no recent activity)");
    }

    // ═══════════════════════════════════════════════════════════
    // EMOTIONAL WEIGHT
    // ═══════════════════════════════════════════════════════════
    output.push("");
    output.push("-".repeat(60));
    output.push("EMOTIONAL WEIGHT");
    output.push("-".repeat(60));
    for (const row of weights.results || []) {
      output.push(`  ${row.weight || 'unset'}: ${row.count}`);
    }

    // ═══════════════════════════════════════════════════════════
    // ACTIVITY SUMMARY
    // ═══════════════════════════════════════════════════════════
    output.push("");
    output.push("-".repeat(60));
    output.push("ACTIVITY");
    output.push("-".repeat(60));
    output.push(`  Total observations: ${totalRecent}`);
    output.push(`  Daily average: ${dailyAvg}`);

    // ═══════════════════════════════════════════════════════════
    // SALIENCE DISTRIBUTION
    // ═══════════════════════════════════════════════════════════
    output.push("");
    output.push("-".repeat(60));
    output.push("SALIENCE DISTRIBUTION");
    output.push("-".repeat(60));
    for (const [key, count] of Object.entries(salienceMap)) {
      output.push(`  ${key}: ${count}`);
    }

    // ═══════════════════════════════════════════════════════════
    // FOUNDATIONAL CORE
    // ═══════════════════════════════════════════════════════════
    if (includeAllTime) {
      const foundational = await env.DB.prepare(
        `SELECT name, entity_type, primary_context FROM entities WHERE salience = 'foundational'`
      ).all();

      if (foundational.results?.length) {
        output.push("");
        output.push("-".repeat(60));
        output.push("FOUNDATIONAL CORE");
        output.push("-".repeat(60));
        // Group by primary context
        const byContext: Record<string, string[]> = {};
        for (const entity of foundational.results) {
          const ctx = (entity.primary_context as string) || 'default';
          if (!byContext[ctx]) byContext[ctx] = [];
          byContext[ctx].push(entity.name as string);
        }
        for (const [ctx, names] of Object.entries(byContext)) {
          output.push(`  ${ctx}: ${names.slice(0, 5).join(', ')}`);
          if (names.length > 5) {
            output.push(`    ... and ${names.length - 5} more`);
          }
        }
      }
    }

    output.push("");
    output.push("=".repeat(60));

    return output.join("\n");
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}
