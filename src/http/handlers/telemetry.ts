// HTTP handler for /api/telemetry — full structured mind_health diagnostics.
// Same queries as handleMindHealth, returns JSON for the dashboard's /health page.
import { jsonResponse } from "../response";
import { getSubconsciousState } from "../../daemon/state";
import type { Env } from "../../types";

export async function handleApiTelemetry(_request: Request, env: Env): Promise<Response> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const subconscious = await getSubconsciousState(env);

  const [
    entityCount, obsCount, relationsCount, activeThreads, staleThreads,
    resolvedRecent, journalCount, journalsRecent, identityCount, unprocessedObs,
    contextCount, relationalCount, entitiesByContext, recentObs,
    imageCount, proposalCount, orphanCount, archivedObsCount,
    salienceFoundational, salienceActive, salienceBackground, salienceArchive,
    avgNovelty, surfacedRecent,
    spineCount, compassCount, compassEdges, compassByKind,
    graphStats,
    supersededTotal, supersededRecent,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active' AND updated_at < $1`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'resolved' AND resolved_at > $1`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals WHERE created_at > $1`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity WHERE archived_at IS NULL`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE charge IN ('active', 'processing') OR (charge = 'fresh' AND added_at < $1)`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM context_entries`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relational_state`).first(),
    env.DB.prepare(`SELECT context, COUNT(*) as c FROM observations GROUP BY context`).all(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE added_at > $1`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM images`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM daemon_proposals WHERE status = 'pending'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE (last_surfaced_at IS NULL OR last_surfaced_at < $1) AND (charge != 'metabolized' OR charge IS NULL) AND added_at < $2 AND archived_at IS NULL`).bind(thirtyDaysAgo, sevenDaysAgo).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE archived_at IS NOT NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'foundational'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'active' OR salience IS NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'background'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'archive'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT AVG(novelty_score) as avg FROM observations WHERE novelty_score IS NOT NULL`).first().catch(() => ({ avg: null })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE last_surfaced_at > $1`).bind(sevenDaysAgo).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity WHERE section NOT LIKE 'core.values.%' AND archived_at IS NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM compass`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM compass_provenance`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT kind, COUNT(*) as c FROM compass GROUP BY kind`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`
      WITH entity_stats AS (
        SELECT e.id, e.name,
          (SELECT COUNT(*) FROM relations r WHERE r.from_entity = e.name OR r.to_entity = e.name) AS rel_count,
          (SELECT COUNT(*) FROM observations o
             WHERE (o.person_id = e.id OR o.node_id = e.id OR o.entity_id = e.id)
               AND o.archived_at IS NULL) AS obs_count
        FROM entities e
      )
      SELECT
        SUM(CASE WHEN rel_count = 0 THEN 1 ELSE 0 END) AS disconnected,
        SUM(CASE WHEN rel_count >= 1 THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN obs_count >= 4 AND rel_count <= 1 THEN 1 ELSE 0 END) AS sparse_ripe,
        SUM(CASE WHEN rel_count >= 10 THEN 1 ELSE 0 END) AS hubs,
        SUM(CASE WHEN obs_count = 0 THEN 1 ELSE 0 END) AS no_obs,
        ROUND(AVG(rel_count)::numeric, 2) AS avg_degree,
        MAX(rel_count) AS max_degree
      FROM entity_stats
    `).first().catch(() => null),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE superseded_by IS NOT NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE superseded_by IS NOT NULL AND valid_until > $1`).bind(sevenDaysAgo).first().catch(() => ({ c: 0 })),
  ]);

  const n = (r: unknown, key = 'c'): number =>
    Number((r as Record<string, unknown> | null)?.[key] ?? 0);

  const entities = n(entityCount);
  const observations = n(obsCount);

  // Subconscious age
  let subconsciousScore = 0;
  let subconsciousAge: string | null = null;
  let subconsciousStatus = 'never run';
  if (subconscious?.processed_at) {
    const ageMs = now.getTime() - new Date(subconscious.processed_at).getTime();
    const ageMins = Math.round(ageMs / 60000);
    const ageHours = Math.round(ageMs / 3_600_000);
    subconsciousAge = ageMins < 60 ? `${ageMins}m ago` : `${ageHours}h ago`;
    if (ageMs < 3_600_000) { subconsciousScore = 100; subconsciousStatus = 'fresh'; }
    else if (ageMs < 7_200_000) { subconsciousScore = 70; subconsciousStatus = 'recent'; }
    else if (ageMs < 21_600_000) { subconsciousScore = 40; subconsciousStatus = 'stale'; }
    else { subconsciousScore = 10; subconsciousStatus = 'very stale'; }
  }

  // Daemon snapshots
  const livingSurface = (subconscious as unknown as { living_surface?: Record<string, unknown> })?.living_surface;
  const staleThreadsSnapshot = livingSurface?.stale_threads as
    | { cooling?: number; stale?: number; graveyard?: number }
    | undefined;
  const compassExerciseSnapshot = livingSurface?.compass_exercise as
    | { fresh?: number; stale?: number; unexercised?: number }
    | undefined;
  const bondWarmthSnapshot = livingSurface?.bond_warmth as
    | Array<{ state: string; name: string }>
    | undefined;
  const identityHuntProposed = (livingSurface?.identity_hunt_proposed as number | undefined) ?? 0;

  const bondCounts = {
    warm:      bondWarmthSnapshot?.filter((b) => b.state === 'warm').length ?? 0,
    cooling:   bondWarmthSnapshot?.filter((b) => b.state === 'cooling').length ?? 0,
    cold:      bondWarmthSnapshot?.filter((b) => b.state === 'cold').length ?? 0,
    distant:   bondWarmthSnapshot?.filter((b) => b.state === 'distant').length ?? 0,
    untouched: bondWarmthSnapshot?.filter((b) => b.state === 'untouched').length ?? 0,
  };

  // Graph
  const graph = graphStats as Record<string, unknown> | null;
  const graphConnected = Number(graph?.connected ?? 0);
  const graphScore = entities > 0 ? Math.round((graphConnected / entities) * 100) : 50;

  // Scores
  const dbScore = Math.min(100, Math.round((entities / 100) * 50 + (observations / 500) * 50));
  const threadScore = n(activeThreads) > 0 ? (n(staleThreads) < 3 ? 100 : n(staleThreads) < 6 ? 60 : 30) : 50;
  const journalScore = n(journalsRecent) >= 3 ? 100 : n(journalsRecent) >= 1 ? 70 : n(journalCount) > 0 ? 40 : 0;
  const identityScore = n(identityCount) >= 50 ? 100 : Math.round((n(identityCount) / 50) * 100);
  const activityScore = n(recentObs) >= 20 ? 100 : Math.round((n(recentObs) / 20) * 100);
  const overall = Math.round((dbScore + threadScore + journalScore + identityScore + activityScore + subconsciousScore) / 6);

  return jsonResponse({
    overall,
    timestamp: now.toISOString(),
    subconscious: {
      score: subconsciousScore,
      status: subconsciousStatus,
      age: subconsciousAge,
      processed_at: subconscious?.processed_at ?? null,
      mood: subconscious?.mood ?? null,
      hot_entities_count: subconscious?.hot_entities?.length ?? 0,
      identity_hunt_proposed: identityHuntProposed,
    },
    database: {
      score: dbScore,
      entities,
      observations,
      relations: n(relationsCount),
      by_context: (((entitiesByContext as unknown) as { results?: Array<{ context: string; c: number }> })?.results || [])
        .map((r) => ({ context: r.context, count: Number(r.c) })),
    },
    threads: {
      score: threadScore,
      active: n(activeThreads),
      stale_total: n(staleThreads),
      resolved_7d: n(resolvedRecent),
      cooling: staleThreadsSnapshot?.cooling ?? 0,
      stale: staleThreadsSnapshot?.stale ?? 0,
      graveyard: staleThreadsSnapshot?.graveyard ?? 0,
    },
    journals: {
      score: journalScore,
      total: n(journalCount),
      this_week: n(journalsRecent),
    },
    identity: {
      score: identityScore,
      entries: n(identityCount),
      context_entries: n(contextCount),
      relational_states: n(relationalCount),
      unprocessed: n(unprocessedObs),
    },
    spine: {
      entries: n(spineCount),
    },
    compass: {
      entries: n(compassCount),
      by_kind: (((compassByKind as unknown) as { results?: Array<{ kind: string; c: number }> })?.results || [])
        .map((r) => ({ kind: r.kind, count: Number(r.c) })),
      edges: n(compassEdges),
      fresh: compassExerciseSnapshot?.fresh ?? 0,
      stale: compassExerciseSnapshot?.stale ?? 0,
      unexercised: compassExerciseSnapshot?.unexercised ?? n(compassCount),
    },
    bonds: bondCounts,
    activity: {
      score: activityScore,
      new_observations_7d: n(recentObs),
      surfaced_7d: n(surfacedRecent),
    },
    living_surface: {
      avg_novelty: (avgNovelty as { avg?: number | null })?.avg ?? null,
      orphans_30d: n(orphanCount),
      archived_obs: n(archivedObsCount),
      superseded_obs: n(supersededTotal),
      superseded_obs_7d: n(supersededRecent),
      pending_proposals: n(proposalCount),
    },
    graph: {
      score: graphScore,
      connected: graphConnected,
      disconnected: Number(graph?.disconnected ?? 0),
      empty: Number(graph?.no_obs ?? 0),
      sparse_ripe: Number(graph?.sparse_ripe ?? 0),
      hubs: Number(graph?.hubs ?? 0),
      avg_degree: Number(graph?.avg_degree ?? 0),
      max_degree: Number(graph?.max_degree ?? 0),
      total_entities: entities,
    },
    entity_salience: {
      foundational: n(salienceFoundational),
      active: n(salienceActive),
      background: n(salienceBackground),
      archive: n(salienceArchive),
    },
    visual_memory: {
      images: n(imageCount),
    },
  });
}
