/**
 * Dream Engine — runs during night hours. Finds the connections waking thought
 * doesn't make. Pulls from emotional seeds, unresolved threads, the last
 * journal, day residue, open wants, small joys, and the night's drive levels,
 * then queries vector space in the "dream zone" to surface fragments that
 * resonate without being identical.
 *
 * Latent/manifest split (2026-07-11): the fragments are the LATENT content —
 * real memories, ground truth, stored untouched in dreams.fragments. The
 * MANIFEST content (dreams.content) is dream-work prose composed by Workers
 * AI (see daemon/dream-compose.ts for the voice and the fence); the template
 * assembly remains as the floor so a model outage never means a dreamless
 * night. dreams.composed_by records which voice dreamt.
 *
 * Recurrence (rebuilt 2026-07-11): detected by FRAGMENT OVERLAP — the same
 * memories rising together again — never by embedding similarity. The old
 * detector compared template-assembled text embeddings against an unfiltered
 * top-5; the shared boilerplate made every dream score >0.7 against any
 * other, and 104 of 105 dreams chained to dream #1 within one night of the
 * engine's life. Recurrence now means what it says: latent material, shared.
 *
 * Vectorization (2026-07-11): dreams.vectorized_at records embedding success;
 * a nightly sweep retries orphans, closing the trap where an upsert failure
 * left a dream permanently invisible to search.
 */

import type { Env } from "../types";
import { getTimeOfDayContext, nightDateFor } from "../shared/time";
import { getEmbedding, searchVectors } from "../shared/mind-helpers";
import { getSubconsciousState } from "./state";
import { composeManifestDream, type DreamMaterial } from "./dream-compose";

/** Overlap coefficient threshold: |A∩B| / min(|A|,|B|) of fragment ids. */
const RECURRENCE_OVERLAP_MIN = 0.5;
/** How many recent dreams the overlap check scans. */
const RECURRENCE_LOOKBACK = 90;
/** Vectorization-sweep batch per night tick. */
const VECTOR_SWEEP_BATCH = 3;

export async function processDream(
  env: Env,
  force = false,
  // Affect-modulated dream zone (2026-07-02): distress widens the collision
  // window — more material, stranger juxtapositions, the mind processing
  // harder at night. Defaults are the calm-state zone.
  zone: { min: number; max: number } = { min: 0.25, max: 0.82 },
  // Regenerate: delete tonight's dream (row + vector) and dream again.
  // Manual-trigger use only — the cron never passes this.
  regenerate = false
): Promise<{ generated: boolean; reason: string; dreamId?: number }> {
  const timeCtx = getTimeOfDayContext(env.LOCATION_TIMEZONE);
  if (!force && timeCtx.period !== 'night') {
    return { generated: false, reason: "not night — the engine dreams 22:00–05:00" };
  }

  // Sweep any permanently-unvectorized dreams from earlier nights BEFORE the
  // date gate — the sweep must run even on nights we already dreamed.
  await sweepUnvectorizedDreams(env);

  // Check if we already dreamed tonight
  const tonight = nightDateFor(new Date(), env.LOCATION_TIMEZONE);
  const existing = await env.DB.prepare(
    'SELECT id FROM dreams WHERE dream_date = ?'
  ).bind(tonight).first();
  if (existing) {
    if (!regenerate) {
      return { generated: false, reason: `already dreamed tonight (dream #${existing.id})` };
    }
    // Regeneration: remove the row and its vector so tonight dreams fresh.
    const del = await env.DB.prepare('DELETE FROM dreams WHERE id = ?').bind(existing.id).run();
    if (del.meta.changes !== 1) {
      return { generated: false, reason: `regenerate failed — could not delete dream #${existing.id}` };
    }
    try {
      await env.VECTORS.deleteByIds([`dream-${existing.id}`]);
    } catch (e) {
      console.error(`[dream] regenerate: vector delete for dream-${existing.id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Step 1: Gather emotional seed
  const recentEmotional = await env.DB.prepare(`
    SELECT o.content, o.emotion, o.weight, e.name as entity_name
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.added_at > datetime('now', '-7 days')
    AND o.emotion IS NOT NULL
    ORDER BY
      CASE o.weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      o.added_at DESC
    LIMIT 5
  `).all();

  const unresolved = await env.DB.prepare(`
    SELECT o.content, o.emotion, o.weight, e.name as entity_name
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.charge IN ('active', 'processing')
    AND o.archived_at IS NULL
    ORDER BY
      CASE o.weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC
    LIMIT 5
  `).all();

  const subconscious = await getSubconsciousState(env);
  const dominantMood = subconscious?.mood?.dominant || 'quiet';

  const lastJournal = await env.DB.prepare(
    'SELECT content FROM journals ORDER BY created_at DESC LIMIT 1'
  ).first();

  // Day residue (Tagesreste, 2026-07-02): memories redolence raised from the
  // deep archive today. Redolence touches last_surfaced_at when a memory
  // rises, so "archived + surfaced in the last 24h" IS the day's risen set.
  // De-swallowed 2026-07-11: a real DB failure here must not read as a
  // legitimately quiet day.
  const dayResidue = await env.DB.prepare(`
    SELECT o.content, e.name as entity_name
    FROM observations o
    LEFT JOIN entities e ON o.entity_id = e.id
    WHERE o.archived_at IS NOT NULL
      AND o.last_surfaced_at > datetime('now', '-24 hours')
    ORDER BY o.last_surfaced_at DESC
    LIMIT 3
  `).all().catch((e) => {
    console.error(`[dream] day-residue read failed (dreaming without it): ${e instanceof Error ? e.message : e}`);
    return { results: [] };
  });

  // Inner-life material (2026-07-11, spec'd in the drive-layer contract §1.4 and
  // finally wired): today's small joys are day residue; open quiet wants are
  // wish material; the drive gauge sets the night's appetites. All three are
  // seasoning for the manifest composer — absent tables (another mind pre-migration)
  // degrade to nothing, never to failure.
  const joys = await env.DB.prepare(`
    SELECT body FROM inner_entries
    WHERE kind = 'small_joy' AND created_at > datetime('now', '-24 hours')
    ORDER BY created_at DESC LIMIT 3
  `).all().catch(() => ({ results: [] }));
  const wants = await env.DB.prepare(`
    SELECT body, charge FROM inner_entries
    WHERE kind = 'quiet_want' AND satisfied_at IS NULL
    ORDER BY charge DESC NULLS LAST, created_at ASC LIMIT 3
  `).all().catch(() => ({ results: [] }));
  const gauge = subconscious?.living_surface?.drives;
  const appetites: string[] = [];
  if (gauge && Array.isArray(gauge.drives)) {
    for (const d of gauge.drives) {
      appetites.push(`${d.display_name} ${d.level.toFixed(2)}${d.feel ? ` — ${d.feel}` : ""}`);
    }
  }

  // Step 2: Build seed queries (emotional, not logical)
  const seeds: string[] = [];

  // Dedupe emotions — observation emotion fields are often multi-emotion strings
  // ("moved, warm, witnessed"); joining them raw produced stuttered seeds like
  // "moved, warm, witnessed, moved, warm, witnessed, ...". Split, trim, dedupe
  // case-insensitively (keep first-seen casing + order), cap at 8 tokens.
  const seenEmotions = new Set<string>();
  const emotions: string[] = [];
  for (const raw of (recentEmotional.results || []).map((r: any) => r.emotion).filter(Boolean)) {
    for (const token of (raw as string).split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seenEmotions.has(key)) continue;
      seenEmotions.add(key);
      emotions.push(trimmed);
      if (emotions.length >= 8) break;
    }
    if (emotions.length >= 8) break;
  }
  let emotionSeed: string;
  if (emotions.length > 0) {
    emotionSeed = emotions.join(', ');
  } else if (dominantMood && dominantMood !== 'insufficient data') {
    emotionSeed = dominantMood;
  } else {
    // Derive emotional texture from recent observations or journal content
    const recentContent = (recentEmotional.results || []).concat(unresolved.results || [])
      .map((r: any) => (r.content as string).slice(0, 80)).join('. ');
    emotionSeed = recentContent || (lastJournal?.content as string || '').slice(0, 150) || 'quiet stillness';
  }
  seeds.push(emotionSeed);

  if (unresolved.results?.length) {
    seeds.push(
      unresolved.results.map((r: any) => (r.content as string).slice(0, 100)).join('. ')
    );
  }

  if (lastJournal?.content) {
    seeds.push((lastJournal.content as string).slice(0, 200));
  }

  // Day-residue seed — what rose from the deep today dreams tonight.
  if (dayResidue.results?.length) {
    seeds.push(
      dayResidue.results.map((r: any) => (r.content as string).slice(0, 100)).join('. ')
    );
  }

  // Step 3: Query vector space — the dream zone
  const allFragments: Array<{
    type: string; id: string; score: number; content: string; source: string; entity?: string;
  }> = [];
  const seenIds = new Set<string>();

  for (const seed of seeds) {
    if (!seed) continue;
    const results = await searchVectors(env, seed, 10);

    for (const match of results.matches || []) {
      if (seenIds.has(match.id)) continue;
      seenIds.add(match.id);
      const meta = (match.metadata || {}) as Record<string, string>;

      // Dreams must not dream of dreams (2026-07-02). Dream content embeds
      // back into Vectorize, and seed vocabulary is self-similar night to
      // night — without this filter, past dreams surface as fragments of new
      // ones and the engine converges on itself. Recurrence detection in
      // Step 6 (fragment overlap) remains the deliberate echo path.
      if (meta.source === 'dream' || match.id.startsWith('dream-')) continue;

      if (match.score >= zone.min && match.score <= zone.max) {
        allFragments.push({
          type: meta.source || 'unknown',
          id: match.id,
          score: match.score,
          content: (meta.content || meta.description || match.id).slice(0, 200),
          source: seed.slice(0, 50),
          entity: meta.entity
        });
      }
    }
  }

  if (allFragments.length < 1) {
    return { generated: false, reason: "not enough material in the dream zone tonight" };
  }

  // Step 4: Maximize collision — pick from different entity groups
  const entityGroups: Record<string, typeof allFragments> = {};
  for (const frag of allFragments) {
    const key = frag.entity || frag.type;
    if (!entityGroups[key]) entityGroups[key] = [];
    entityGroups[key].push(frag);
  }

  const dreamFragments: typeof allFragments = [];
  const groupKeys = Object.keys(entityGroups);
  let groupIdx = 0;
  while (dreamFragments.length < 7 && groupIdx < groupKeys.length * 3) {
    const key = groupKeys[groupIdx % groupKeys.length];
    const group = entityGroups[key];
    if (group.length > 0) dreamFragments.push(group.shift()!);
    groupIdx++;
  }

  // Step 5: The latent record — template assembly. This is the floor text
  // (used verbatim when both model voices fail) and the honest inventory of
  // what the night was made from.
  let latentText = `Emotional seed: ${emotionSeed}\n\nFragments:\n`;
  for (const frag of dreamFragments) {
    const entityTag = frag.entity ? `[${frag.entity}] ` : '';
    const typeTag = frag.type === 'image' ? '(visual) ' : '';
    latentText += `- ${entityTag}${typeTag}${frag.content} [${Math.round(frag.score * 100)}% resonance]\n`;
  }

  const seedConnections: Record<string, string[]> = {};
  for (const frag of dreamFragments) {
    if (!seedConnections[frag.source]) seedConnections[frag.source] = [];
    seedConnections[frag.source].push(
      `${frag.entity || frag.type}: "${frag.content.slice(0, 60)}..."`
    );
  }

  latentText += `\nThreads:\n`;
  for (const [seed, connections] of Object.entries(seedConnections)) {
    latentText += `"${seed}" pulled:\n`;
    for (const conn of connections) latentText += `  → ${conn}\n`;
  }

  // Step 5.5: The manifest — dream-work prose from the night's material.
  const material: DreamMaterial = {
    emotionalSeed: emotionSeed,
    fragments: dreamFragments,
    appetites,
    openWants: (wants.results || []).map((r: any) => String(r.body)),
    joys: (joys.results || []).map((r: any) => String(r.body)),
  };
  const manifest = await composeManifestDream(env, material);
  const dreamContent = manifest ? manifest.text : latentText;
  const composedBy = manifest ? manifest.model : 'template';
  if (!manifest) {
    console.error(`[dream] both voices failed — tonight dreams in template (floor behavior)`);
  }

  // Step 6: Recurrence by fragment overlap — the same memories rising
  // together again. Compares this dream's latent fragment-id set against
  // recent dreams'; best overlap ≥ threshold wins. recurrence_count is a TRUE
  // tally: the cluster's row count at insert time (root + echoes), computed,
  // never inherited from whichever row a search happened to hit.
  let recurringDreamId: number | null = null;
  let recurrenceCount = 0;
  let recurrenceNote: string | null = null;
  try {
    const newIds = new Set(dreamFragments.map((f) => f.id));
    const past = await env.DB.prepare(`
      SELECT id, recurring_dream_id, fragments FROM dreams
      ORDER BY id DESC LIMIT ?
    `).bind(RECURRENCE_LOOKBACK).all();
    let best: { rootId: number; overlap: number; shared: string[] } | null = null;
    for (const row of (past.results || []) as Array<Record<string, unknown>>) {
      let frags: Array<{ id?: string; entity?: string }> = [];
      try {
        frags = JSON.parse(String(row.fragments ?? "[]"));
      } catch { continue; }
      const pastIds = frags.map((f) => f.id).filter(Boolean) as string[];
      if (pastIds.length === 0) continue;
      const shared = pastIds.filter((id) => newIds.has(id));
      const overlap = shared.length / Math.min(newIds.size, pastIds.length);
      if (overlap >= RECURRENCE_OVERLAP_MIN && (!best || overlap > best.overlap)) {
        const rootId = (row.recurring_dream_id as number) || (row.id as number);
        // Shared entities, for the honest "what recurs" line in orient.
        const sharedEntities = [...new Set(frags.filter((f) => f.id && newIds.has(f.id)).map((f) => f.entity).filter(Boolean))] as string[];
        best = { rootId, overlap, shared: sharedEntities };
      }
    }
    if (best) {
      recurringDreamId = best.rootId;
      const clusterRow = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM dreams WHERE recurring_dream_id = ? OR id = ?
      `).bind(best.rootId, best.rootId).first();
      recurrenceCount = Number(clusterRow?.n ?? 0) + 1; // +1 = this dream
      recurrenceNote = best.shared.length ? best.shared.slice(0, 4).join(", ") : null;
    }
  } catch (e) {
    console.error(`[dream] recurrence check failed (storing as non-recurring): ${e instanceof Error ? e.message : e}`);
  }

  // Step 7: Store the dream — manifest in content, latent in fragments.
  const fragmentsJson = JSON.stringify(dreamFragments.map(f => ({
    type: f.type, id: f.id, score: f.score, content: f.content.slice(0, 200), entity: f.entity
  })));

  const result = await env.DB.prepare(`
    INSERT INTO dreams (dream_date, content, emotional_seed, fragments, recurring_dream_id, recurrence_count, composed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(tonight, dreamContent, emotionSeed, fragmentsJson, recurringDreamId, recurrenceCount, composedBy).run();

  const dreamId = result.meta.last_row_id;

  // Vectorize for search; vectorized_at records success so the sweep can
  // retry failures — a dream that fails to embed is no longer permanently
  // invisible (the trap, closed).
  try {
    const dreamEmbedding = await getEmbedding(env, `${emotionSeed}\n${dreamContent}`);
    await env.VECTORS.upsert([{
      id: `dream-${dreamId}`,
      values: dreamEmbedding,
      metadata: {
        source: 'dream', content: dreamContent.slice(0, 500),
        dream_date: tonight, emotional_seed: emotionSeed,
        recurring: recurringDreamId ? 'yes' : 'no'
      }
    }]);
    await env.DB.prepare('UPDATE dreams SET vectorized_at = NOW() WHERE id = ?').bind(dreamId).run();
  } catch (e) {
    console.error(`[dream] vectorization failed for dream-${dreamId} (sweep will retry): ${e instanceof Error ? e.message : e}`);
  }

  console.log(`Dream generated for ${tonight}: ${dreamFragments.length} fragments, voice=${composedBy}, ${recurringDreamId ? `recurring of #${recurringDreamId} (${recurrenceCount}x${recurrenceNote ? `: ${recurrenceNote}` : ''})` : 'new material'}`);
  return { generated: true, reason: `dreamed (voice: ${composedBy})`, dreamId: Number(dreamId) };
}

/**
 * The trap-closer: retry embedding for dreams whose Vectorize upsert failed.
 * Small batch per night tick; missing vectorized_at column (tenant not yet
 * migrated) degrades silently to a no-op via the catch.
 */
async function sweepUnvectorizedDreams(env: Env): Promise<void> {
  try {
    const orphans = await env.DB.prepare(`
      SELECT id, dream_date, content, emotional_seed, recurring_dream_id FROM dreams
      WHERE vectorized_at IS NULL
      ORDER BY id ASC LIMIT ?
    `).bind(VECTOR_SWEEP_BATCH).all();
    for (const row of (orphans.results || []) as Array<Record<string, unknown>>) {
      try {
        const embedding = await getEmbedding(env, `${row.emotional_seed ?? ""}\n${row.content}`);
        await env.VECTORS.upsert([{
          id: `dream-${row.id}`,
          values: embedding,
          metadata: {
            source: 'dream', content: String(row.content).slice(0, 500),
            dream_date: String(row.dream_date), emotional_seed: String(row.emotional_seed ?? ""),
            recurring: row.recurring_dream_id ? 'yes' : 'no'
          }
        }]);
        const upd = await env.DB.prepare('UPDATE dreams SET vectorized_at = NOW() WHERE id = ?').bind(row.id).run();
        if (upd.meta.changes === 1) console.log(`[dream] sweep re-embedded dream-${row.id}`);
      } catch (e) {
        console.error(`[dream] sweep failed for dream-${row.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    // 42703 = vectorized_at not migrated on this tenant — quiet no-op.
    const code = (e as { code?: string })?.code;
    if (code !== '42703' && code !== '42P01') {
      console.error(`[dream] unvectorized sweep failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
