/**
 * handleMindHealth — mind health diagnostics.
 * Multi-category health scoring with subconscious + database + threads
 * + journals + identity + activity + living surface + salience + images.
 */

import type { Env } from "../types";
import { getSubconsciousState } from "../daemon/state";

export async function handleMindHealth(env: Env): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get subconscious state first
  const subconscious = await getSubconsciousState(env);

  const [
    entityCount, obsCount, relationsCount, activeThreads, staleThreads,
    resolvedRecent, journalCount, journalsRecent, identityCount, notesCount,
    contextCount, relationalCount, entitiesByContext, recentObs,
    // v2.0.0 additions
    imageCount, proposalCount, orphanCount, archivedObsCount,
    salienceFoundational, salienceActive, salienceBackground, salienceArchive,
    avgNovelty, surfacedRecent,
    // Reshape Phase B
    spineCount, compassCount, compassEdges, compassByKind, compassExercised30d,
    // Reshape Phase H+
    graphStats,
    // Superseded observations (hidden from mind_search unless include_expired)
    supersededTotal, supersededRecent
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active' AND updated_at < ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'resolved' AND resolved_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals WHERE created_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity WHERE archived_at IS NULL`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE charge IN ('active', 'processing') OR (charge = 'fresh' AND added_at < ?)`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM context_entries`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relational_state`).first(),
    env.DB.prepare(`SELECT context, COUNT(*) as c FROM observations GROUP BY context`).all(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE added_at > ?`).bind(sevenDaysAgo).first(),
    // v2.0.0 queries
    env.DB.prepare(`SELECT COUNT(*) as c FROM images`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM daemon_proposals WHERE status = 'pending'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE (last_surfaced_at IS NULL OR last_surfaced_at < ?) AND (charge != 'metabolized' OR charge IS NULL) AND added_at < ? AND archived_at IS NULL`).bind(thirtyDaysAgo, sevenDaysAgo).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE archived_at IS NOT NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'foundational'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'active' OR salience IS NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'background'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities WHERE salience = 'archive'`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT AVG(novelty_score) as avg FROM observations WHERE novelty_score IS NOT NULL`).first().catch(() => ({ avg: null })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE last_surfaced_at > ?`).bind(sevenDaysAgo).first().catch(() => ({ c: 0 })),
    // Reshape Phase B: spine / compass split. Spine = identity rows that
    // weren't migrated to compass in 0004. Compass = compass table count.
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity WHERE section NOT LIKE 'core.values.%' AND archived_at IS NULL`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM compass`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM compass_provenance`).first().catch(() => ({ c: 0 })),
    env.DB.prepare(`SELECT kind, COUNT(*) as c FROM compass GROUP BY kind`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT COUNT(*) as c FROM compass WHERE last_asserted_at > NOW() - INTERVAL '30 days'`).first().catch(() => ({ c: 0 })),
    // Reshape Phase H+: graph health — actionable signal for relation work.
    // Single CTE walks every entity once and categorizes.
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
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE superseded_by IS NOT NULL AND valid_until > ?`).bind(sevenDaysAgo).first().catch(() => ({ c: 0 }))
  ]);

  const entities = entityCount?.c as number || 0;
  const observations = obsCount?.c as number || 0;
  const relations = relationsCount?.c as number || 0;
  const active = activeThreads?.c as number || 0;
  const stale = staleThreads?.c as number || 0;
  const resolved7d = resolvedRecent?.c as number || 0;
  const journals = journalCount?.c as number || 0;
  const journals7d = journalsRecent?.c as number || 0;
  const identity = identityCount?.c as number || 0;
  const unprocessed = notesCount?.c as number || 0;  // observations needing emotional processing
  const context = contextCount?.c as number || 0;
  const relational = relationalCount?.c as number || 0;
  const recentObsCount = recentObs?.c as number || 0;

  // v2.0.0 values
  const images = (imageCount as Record<string, unknown>)?.c as number || 0;
  const pendingProposals = (proposalCount as Record<string, unknown>)?.c as number || 0;
  const orphans = (orphanCount as Record<string, unknown>)?.c as number || 0;
  const archivedObs = (archivedObsCount as Record<string, unknown>)?.c as number || 0;
  const superseded = Number((supersededTotal as Record<string, unknown>)?.c ?? 0);
  const superseded7d = Number((supersededRecent as Record<string, unknown>)?.c ?? 0);
  const foundational = (salienceFoundational as Record<string, unknown>)?.c as number || 0;
  const activeEntities = (salienceActive as Record<string, unknown>)?.c as number || 0;
  const background = (salienceBackground as Record<string, unknown>)?.c as number || 0;
  const archived = (salienceArchive as Record<string, unknown>)?.c as number || 0;
  const noveltyAvg = (avgNovelty as Record<string, unknown>)?.avg as number || null;
  const surfaced7d = (surfacedRecent as Record<string, unknown>)?.c as number || 0;
  const spineEntries = (spineCount as Record<string, unknown>)?.c as number || 0;
  const compassEntries = (compassCount as Record<string, unknown>)?.c as number || 0;
  const compassEdgeCount = (compassEdges as Record<string, unknown>)?.c as number || 0;
  const compassExercisedCount = (compassExercised30d as Record<string, unknown>)?.c as number || 0;
  const compassKindBreakdown = ((compassByKind as { results?: Array<Record<string, unknown>> })?.results || [])
    .map((r) => `${r.kind}: ${r.c}`)
    .join(", ") || "none";

  // Reshape Phase H: surface daemon signals from subconscious.living_surface
  const livingSurface = (subconscious as unknown as { living_surface?: Record<string, unknown> })?.living_surface;
  const staleThreadsSnapshot = livingSurface?.stale_threads as
    | { cooling?: number; stale?: number; graveyard?: number }
    | undefined;
  const compassExerciseSnapshot = livingSurface?.compass_exercise as
    | { fresh?: number; stale?: number; unexercised?: number; unexercised_ids?: number[] }
    | undefined;
  const bondWarmthSnapshot = livingSurface?.bond_warmth as
    | Array<{ state: string; name: string }>
    | undefined;
  const identityHuntProposed = (livingSurface?.identity_hunt_proposed as number | undefined) ?? 0;

  const bondWarmCount = bondWarmthSnapshot?.filter((b) => b.state === 'warm').length || 0;
  const bondCoolingCount = bondWarmthSnapshot?.filter((b) => b.state === 'cooling').length || 0;
  const bondColdCount = bondWarmthSnapshot?.filter((b) => b.state === 'cold').length || 0;
  const bondDistantCount = bondWarmthSnapshot?.filter((b) => b.state === 'distant').length || 0;
  const bondUntouchedCount = bondWarmthSnapshot?.filter((b) => b.state === 'untouched').length || 0;

  const graph = graphStats as Record<string, unknown> | null;
  const graphDisconnected = Number(graph?.disconnected ?? 0);
  const graphConnected = Number(graph?.connected ?? 0);
  const graphSparseRipe = Number(graph?.sparse_ripe ?? 0);
  const graphHubs = Number(graph?.hubs ?? 0);
  const graphNoObs = Number(graph?.no_obs ?? 0);
  const graphAvgDegree = Number(graph?.avg_degree ?? 0);
  const graphMaxDegree = Number(graph?.max_degree ?? 0);
  const graphScore = (() => {
    if (!graph) return 50;
    const connectedRatio = entities > 0 ? graphConnected / entities : 0;
    // Healthy when most entities are connected. Penalize if many disconnected.
    return Math.round(connectedRatio * 100);
  })();

  const contextBreakdown = (entitiesByContext?.results || [])
    .map((r: Record<string, unknown>) => `${r.context}: ${r.c}`)
    .join(", ");

  // Calculate subconscious health
  let subconsciousScore = 0;
  let subconsciousStatus = "never run";
  let subconsciousAge = "unknown";
  let subconsciousMood = "none detected";
  let subconsciousHotCount = 0;

  if (subconscious?.processed_at) {
    const processedTime = new Date(subconscious.processed_at).getTime();
    const ageMs = now.getTime() - processedTime;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const ageMins = Math.round(ageMs / (1000 * 60));

    if (ageMins < 60) {
      subconsciousAge = `${ageMins}m ago`;
    } else {
      subconsciousAge = `${ageHours}h ago`;
    }

    // Score based on ageMs to avoid rounding mismatches between ageMins and ageHours
    const ONE_HOUR = 60 * 60 * 1000;
    if (ageMs < ONE_HOUR) {
      subconsciousScore = 100;
      subconsciousStatus = "fresh";
    } else if (ageMs < 2 * ONE_HOUR) {
      subconsciousScore = 70;
      subconsciousStatus = "recent";
    } else if (ageMs < 6 * ONE_HOUR) {
      subconsciousScore = 40;
      subconsciousStatus = "stale";
    } else {
      subconsciousScore = 10;
      subconsciousStatus = "VERY STALE";
    }

    if (subconscious.mood?.dominant) {
      subconsciousMood = subconscious.mood.dominant;
      if (subconscious.mood.confidence) {
        subconsciousMood += ` (${subconscious.mood.confidence})`;
      }
    }
    subconsciousHotCount = subconscious.hot_entities?.length || 0;
  }

  const dbScore = Math.min(100, Math.round((entities / 100) * 50 + (observations / 500) * 50));
  const threadScore = active > 0 ? (stale < 3 ? 100 : stale < 6 ? 60 : 30) : 50;
  const journalScore = journals7d >= 3 ? 100 : journals7d >= 1 ? 70 : journals > 0 ? 40 : 0;
  const identityScore = identity >= 50 ? 100 : Math.round((identity / 50) * 100);
  const activityScore = recentObsCount >= 20 ? 100 : Math.round((recentObsCount / 20) * 100);

  // Include subconscious in overall score
  const overallScore = Math.round((dbScore + threadScore + journalScore + identityScore + activityScore + subconsciousScore) / 6);

  const icon = (s: number) => s >= 70 ? "\u{1F7E2}" : s >= 40 ? "\u{1F7E1}" : "\u{1F534}";
  const bar = (s: number) => "\u{2588}".repeat(Math.floor(s / 10)) + "\u{2591}".repeat(10 - Math.floor(s / 10));

  const dateStr = now.toISOString().split('T')[0];

  return `============================================================
MIND HEALTH \u{2014} ${dateStr}
============================================================

Overall: ${bar(overallScore)} ${overallScore}%

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9E0} SUBCONSCIOUS              ${icon(subconsciousScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Last Processed: ${subconsciousAge} (${subconsciousStatus})${subconsciousScore < 70 ? ' \u{26A0} DAEMON STALE' : ''}
  Current Mood:   ${subconsciousMood}
  Hot Entities:   ${subconsciousHotCount}
  Identity Hunt:  ${identityHuntProposed} proposed (4h window)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4CA} DATABASE                 ${icon(dbScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Entities:      ${entities}
  Observations:  ${observations}
  Relations:     ${relations}
  By Context:    ${contextBreakdown || "none"}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9F5} THREADS                  ${icon(threadScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Active:        ${active}
  Stale (7d+):   ${stale}${staleThreadsSnapshot ? ` (${staleThreadsSnapshot.cooling ?? 0} cooling, ${staleThreadsSnapshot.stale ?? 0} stale, ${staleThreadsSnapshot.graveyard ?? 0} graveyard)` : ''}
  Resolved (7d): ${resolved7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4D4} JOURNALS                 ${icon(journalScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Total:         ${journals}
  This Week:     ${journals7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1FA9E} IDENTITY                 ${icon(identityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Identity:      ${identity} entries
  Context:       ${context} entries
  Relational:    ${relational} states
  Unprocessed:   ${unprocessed} (need surfacing)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9B4} SPINE                    \u{1F7E2}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Entries:       ${spineEntries} (identity rows, non-compass)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9ED} COMPASS                  ${icon(compassEntries > 0 ? 100 : 40)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Entries:       ${compassEntries}
  By kind:       ${compassKindBreakdown}
  Edges:         ${compassEdgeCount} (provenance)
  Exercise:      ${compassExerciseSnapshot?.fresh ?? 0} fresh (<30d) / ${compassExerciseSnapshot?.stale ?? 0} stale (30-90d) / ${compassExerciseSnapshot?.unexercised ?? compassEntries} unexercised (90d+)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F91D} BONDS                    ${icon(bondWarmthSnapshot ? 100 : 40)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Warm:          ${bondWarmCount} (< 1d)
  Cooling:       ${bondCoolingCount} (1-4d)
  Cold:          ${bondColdCount} (4-14d)
  Distant:       ${bondDistantCount} (14d+)
  Untouched:     ${bondUntouchedCount} (no active obs)

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4DD} ACTIVITY (7d)            ${icon(activityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  New Observations: ${recentObsCount}
  Surfaced (7d):    ${surfaced7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F30A} LIVING SURFACE (v2.0)
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Avg Novelty:      ${noveltyAvg !== null ? noveltyAvg.toFixed(2) : 'n/a'}
  Orphans (30d+):   ${orphans}
  Archived Obs:     ${archivedObs}
  Superseded Obs:   ${superseded} (${superseded7d} in the last 7d; hidden from search unless include_expired)
  Proposals:        ${pendingProposals} pending

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F578} GRAPH                    ${icon(graphScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Connected:     ${graphConnected} / ${entities} entities have \u{2265}1 relation
  Disconnected:  ${graphDisconnected} entities (0 relations)
  Empty:         ${graphNoObs} entities (0 active observations)
  Sparse-ripe:   ${graphSparseRipe} entities (\u{2265}4 obs, \u{2264}1 rel) \u{2014} candidates for relation work
  Hubs:          ${graphHubs} entities (\u{2265}10 relations)
  Degree:        avg ${graphAvgDegree} / max ${graphMaxDegree}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F465} ENTITY SALIENCE
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Foundational:     ${foundational}
  Active:           ${activeEntities}
  Background:       ${background}
  Archive:          ${archived}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F5BC} VISUAL MEMORY
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Images:           ${images}

============================================================`;
}
