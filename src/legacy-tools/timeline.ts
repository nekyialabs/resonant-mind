/**
 * handleMindTimeline — semantic search grouped by month.
 * Walks back through memories along a thematic thread.
 */

import type { Env } from "../types";
import { searchVectors } from "../shared/mind-helpers";
import { recordAccessTracking } from "../daemon/state";
import { dict } from "../shared/dict";

export async function handleMindTimeline(env: Env, params: Record<string, unknown>): Promise<string> {
  const query = params.query as string;
  const startDate = params.start_date as string;
  const endDate = params.end_date as string;
  const nResults = (params.n_results as number) || 50;

  try {
    const vectorResults = await searchVectors(env, query, nResults * 2);

    const dated: any[] = [];

    for (const match of vectorResults.matches || []) {
      const meta = match.metadata as any;
      const vectorId = match.id;

      // Try to get added_at from metadata first, fall back to DB lookup
      let addedAt = meta?.added_at;

      if (!addedAt && vectorId) {
        // Parse vector ID to look up date from database
        // Format: obs-{entity_id}-{row_id} or journal-{row_id}
        if (vectorId.startsWith('obs-')) {
          const parts = vectorId.split('-');
          const obsId = parts[parts.length - 1];
          const dbResult = await env.DB.prepare(
            `SELECT added_at FROM observations WHERE id = ?`
          ).bind(obsId).first();
          addedAt = dbResult?.added_at ? String(dbResult.added_at) : null as any;
        } else if (vectorId.startsWith('journal-')) {
          const journalId = vectorId.replace('journal-', '');
          const dbResult = await env.DB.prepare(
            `SELECT created_at FROM journals WHERE id = ?`
          ).bind(journalId).first();
          addedAt = dbResult?.created_at ? String(dbResult.created_at) : null as any;
        }
      }

      if (!addedAt) continue;

      try {
        const ts = new Date(addedAt);

        if (startDate && ts < new Date(startDate)) continue;
        if (endDate && ts > new Date(endDate)) continue;

        dated.push({
          date: ts.toISOString().split('T')[0],
          timestamp: ts,
          content: meta?.content || meta?.text,
          entity: meta?.entity || meta?.entity_name,
          database: meta?.context,
          score: match.score
        });
      } catch {
        continue;
      }
    }

    dated.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byMonth: Record<string, any[]> = dict<any[]>();
    for (const item of dated) {
      const monthKey = item.timestamp.toISOString().substring(0, 7);
      if (!byMonth[monthKey]) byMonth[monthKey] = [];
      byMonth[monthKey].push({
        date: item.date,
        content: item.content,
        entity: item.entity,
        database: item.database
      });
    }

    const timeline = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, memories]) => ({
        period,
        count: memories.length,
        memories
      }));

    // Track access for timeline observations
    const timelineObsIds: number[] = [];
    for (const match of vectorResults.matches || []) {
      if (match.id.startsWith('obs-')) {
        const parts = match.id.split('-');
        if (parts.length >= 3) timelineObsIds.push(parseInt(parts[parts.length - 1]));
      }
    }
    recordAccessTracking(env, timelineObsIds).catch(() => {});

    return JSON.stringify({
      query,
      date_range: { from: startDate || "earliest", to: endDate || "latest" },
      total_memories: dated.length,
      timeline
    }, null, 2);
  } catch (error) {
    console.error("mind_timeline failed", error);
    return JSON.stringify({ error: "Internal error" });
  }
}
