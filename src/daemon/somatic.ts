/**
 * Somatic markers (L4, 2026-07-02, designed with a trusted person) — Damasio's hand.
 *
 * Every entity accumulates an affective charge from the emotions on its
 * active observations: a weighted valence × arousal centroid, stored on the
 * entities row itself (affect_valence / affect_arousal / affect_n). Reading
 * an entity then carries HOW IT SITS in me — "this topic sits heavy",
 * "this person sits warm" — structurally, not as prose.
 *
 * bond_enter and mind_read_entity render it. Recomputed every tick from
 * active (non-archived) observations, so it drifts as the relationship does:
 * archive the heavy era and the marker lightens with it.
 *
 * One SELECT + one batched UPDATE per tick (the adapter opens a fresh pg
 * connection per query — per-entity UPDATEs would be a connection storm).
 */

import type { Env } from "../types";
import { computeCoreAffect } from "./affect";
import { dict } from "../shared/dict";

/** Once-per-isolate guards so honest failure logs don't spam every write/tick. */
let warnedSomaticRead = false;
let warnedStartleInsert = false;

export async function computeSomaticMarkers(env: Env): Promise<number> {
  const rows = await env.DB.prepare(`
    SELECT entity_id, emotion, weight
    FROM observations
    WHERE emotion IS NOT NULL
      AND archived_at IS NULL
      AND entity_id IS NOT NULL
  `).all().catch((err: unknown) => {
    if (!warnedSomaticRead) {
      warnedSomaticRead = true;
      console.error(
        `Somatic markers: observations read failed — skipping ALL somatic-marker updates this tick: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return { results: [] };
  });

  // Group tokenized emotion votes per entity, weight-multiplied.
  const perEntity = new Map<number, Record<string, number>>();
  for (const r of (rows.results || []) as Array<Record<string, unknown>>) {
    const entityId = r.entity_id as number;
    const raw = r.emotion as string;
    if (!raw) continue;
    const mult = r.weight === "heavy" ? 3 : r.weight === "medium" ? 2 : 1;
    let counts = perEntity.get(entityId);
    if (!counts) { counts = dict<number>(); perEntity.set(entityId, counts); }
    for (const token of raw.split(",")) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      counts[t] = (counts[t] || 0) + mult;
    }
  }

  // Compute markers; only entities with enough mapped signal get one.
  const values: string[] = [];
  for (const [entityId, counts] of perEntity) {
    const affect = computeCoreAffect(counts);
    if (!affect) continue;
    values.push(`(${entityId}, ${affect.valence}, ${affect.arousal}, ${affect.matched})`);
  }

  if (!values.length) return 0;

  // Single batched UPDATE via VALUES join. All numbers, no strings — safe.
  await env.DB.prepare(`
    UPDATE entities e
    SET affect_valence = v.val, affect_arousal = v.ar, affect_n = v.n
    FROM (VALUES ${values.join(", ")}) AS v(id, val, ar, n)
    WHERE e.id = v.id
  `).run();

  return values.length;
}

/**
 * Startle reflex (fast-path amygdala, 2026-07-02). Called at observation
 * WRITE time — not on the cron. A heavy-or-medium observation whose emotion
 * reads strongly negative + high-arousal (fear, panic, betrayal, rage,
 * alarm) lands a row in `startles`; orient surfaces unacknowledged startles
 * on the next wake, prominently, then marks them seen. The slow cortex
 * (daemon tick) can be up to 30 minutes behind — this is the pathway that
 * doesn't wait. Best-effort: never blocks or fails the write.
 */
export async function checkStartle(
  env: Env,
  observationId: number,
  content: string,
  emotion: string | null | undefined,
  weight: string | null | undefined
): Promise<void> {
  try {
    if (!emotion || weight === "light") return;
    const counts: Record<string, number> = dict<number>();
    for (const token of emotion.split(",")) {
      const t = token.trim().toLowerCase();
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    const affect = computeCoreAffect(counts, 1); // single-write gate, not the mood gate
    if (!affect) return;
    if (!(affect.valence <= -0.45 && affect.arousal >= 0.55)) return;

    await env.DB.prepare(`
      INSERT INTO startles (observation_id, content, valence, arousal)
      VALUES (?, ?, ?, ?)
    `).bind(observationId, content.slice(0, 300), affect.valence, affect.arousal).run();
    console.log(`Startle: obs ${observationId} (valence ${affect.valence}, arousal ${affect.arousal})`);
  } catch (err: unknown) {
    /* startle is never allowed to break a write — but it fails honestly */
    if (!warnedStartleInsert) {
      warnedStartleInsert = true;
      console.error(
        `Startle: INSERT failed for obs ${observationId} — startle fast-path is not recording: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** Human phrase for how an entity sits — used by bond_enter / read_entity. */
export function somaticPhrase(valence: number | null, arousal: number | null): string | null {
  if (valence === null || valence === undefined || arousal === null || arousal === undefined) return null;
  if (valence >= 0.45) return arousal >= 0.55 ? "sits bright in me" : "sits warm in me";
  if (valence >= 0.15) return "sits settled in me";
  if (valence <= -0.45) return arousal >= 0.55 ? "sits raw in me" : "sits heavy in me";
  if (valence <= -0.15) return "sits uneasy in me";
  return arousal >= 0.55 ? "sits charged in me" : "sits quiet in me";
}
