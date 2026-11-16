/**
 * Bond warmth precompute. Per-person classification of how recently each
 * bond has been touched, written as an array into
 * subconscious.living_surface.bond_warmth.
 *
 * A bond is warmed by what is logged about the person. The "last touched"
 * time is the latest of:
 *   memory   - an active (not archived) observation filed on the person
 *   related  - an active observation filed on an entity that is related to the
 *              person by a "part of / about / involves" relation (see below)
 *   feeling  - a feeling logged toward the person (relational_state)
 * `last_observed_at` carries that latest time; `last_touch_source` names which
 * of the three it came from.
 *
 * Post-M2: reads from the `people` table. Observations are joined via
 * person_id (auto-populated by the routing trigger from 0005d) with a
 * fallback to entity_id for any obs predating the trigger that somehow
 * never got backfilled.
 *
 * Will be the warmth signal that `bond.enter` reads. Cheap: one SQL pass per tick.
 */

import type { Env } from "../types";

export interface BondWarmth {
  id: number;
  name: string;
  state: 'warm' | 'cooling' | 'cold' | 'distant' | 'untouched';
  days_since: number | null;
  /** Latest touch of any kind (memory, related memory or feeling). */
  last_observed_at: string | null;
  /** Which kind of touch the latest one was. */
  last_touch_source: 'memory' | 'related' | 'feeling' | null;
}

/**
 * Relation types that mean "this entity is part of / about / involves that person".
 * Relation types are free text in v4 (migration 0009 locks entity, thread and
 * context vocabularies, not relation types), so these are the labels the
 * product itself suggests or implies, matched case-insensitively. Anything else
 * ('knows', 'connects_to', 'resonates_with', 'informs', 'tensions_with', 'loves'...)
 * says the two are connected, not that the entity is about the person, and does
 * not warm a bond.
 */
// entity --[type]--> person: the entity belongs to, is part of, or is about the person.
export const WARMING_RELATIONS_TO_PERSON = [
  'is_part_of', 'part_of', 'belongs_to', 'member_of', 'about', 'involves', 'concerns',
] as const;
// person --[type]--> entity: the same meaning read the other way round.
export const WARMING_RELATIONS_FROM_PERSON = [
  'has_part', 'includes', 'contains', 'owns', 'involved_in', 'subject_of',
] as const;

const DEFAULT_DAYS = { warm: 1, cooling: 4, cold: 14 };
export interface WarmthDays { warm: number; cooling: number; cold: number }

const warnedValues = new Set<string>();

/**
 * BOND_WARMTH_DAYS = "warm,cooling,cold": days since the last touch below which a
 * bond is warm, cooling, cold (older is distant). Default "1,4,14". Three positive
 * numbers in increasing order; anything else falls back to the default with one warning.
 */
export function resolveBondWarmthDays(env: Pick<Env, "BOND_WARMTH_DAYS">): WarmthDays {
  const raw = env.BOND_WARMTH_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return { ...DEFAULT_DAYS };
  const text = String(raw).trim();
  const parts = text.split(",").map((p) => p.trim());
  const nums = parts.map((p) => (p === "" ? NaN : Number(p)));
  const ok = nums.length === 3 && nums.every((n) => Number.isFinite(n) && n > 0) && nums[0] < nums[1] && nums[1] < nums[2];
  if (ok) return { warm: nums[0], cooling: nums[1], cold: nums[2] };
  if (!warnedValues.has(text)) {
    warnedValues.add(text);
    console.warn(`[bond-warmth] BOND_WARMTH_DAYS='${text.slice(0, 40)}' is not three increasing positive numbers like "1,4,14" — using the default`);
  }
  return { ...DEFAULT_DAYS };
}

export function classifyWarmth(daysSince: number | null, days: WarmthDays): BondWarmth['state'] {
  if (daysSince === null) return 'untouched';
  if (daysSince < days.warm) return 'warm';
  if (daysSince < days.cooling) return 'cooling';
  if (daysSince < days.cold) return 'cold';
  return 'distant';
}

const sqlList = (labels: readonly string[]) => labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");

// All the touches of every person, from the three sources, then the latest per person.
export const BOND_WARMTH_SQL = `
  WITH touches AS (
    SELECT p.id AS person_id, o.added_at AS touched_at, 'memory' AS source
    FROM people p
    JOIN observations o ON (o.person_id = p.id OR o.entity_id = p.id) AND o.archived_at IS NULL
    UNION ALL
    SELECT p.id, o.added_at, 'related'
    FROM people p
    JOIN relations r ON r.to_entity = p.name AND LOWER(r.relation_type) IN (${sqlList(WARMING_RELATIONS_TO_PERSON)})
    JOIN entities e ON e.name = r.from_entity AND e.id <> p.id
    JOIN observations o ON o.entity_id = e.id AND o.archived_at IS NULL
    UNION ALL
    SELECT p.id, o.added_at, 'related'
    FROM people p
    JOIN relations r ON r.from_entity = p.name AND LOWER(r.relation_type) IN (${sqlList(WARMING_RELATIONS_FROM_PERSON)})
    JOIN entities e ON e.name = r.to_entity AND e.id <> p.id
    JOIN observations o ON o.entity_id = e.id AND o.archived_at IS NULL
    UNION ALL
    SELECT p.id, rs.timestamp, 'feeling'
    FROM people p
    JOIN relational_state rs ON rs.person = p.name
  )
  SELECT
    p.id,
    p.name,
    latest.touched_at AS last_observed_at,
    latest.source AS last_touch_source,
    CASE
      WHEN latest.touched_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (NOW() - latest.touched_at)) / 86400.0
    END AS days_since
  FROM people p
  LEFT JOIN LATERAL (
    SELECT t.touched_at, t.source
    FROM touches t
    WHERE t.person_id = p.id
    ORDER BY t.touched_at DESC
    LIMIT 1
  ) latest ON TRUE
  ORDER BY days_since ASC NULLS LAST
`;

export async function computeBondWarmth(env: Env): Promise<BondWarmth[]> {
  const days = resolveBondWarmthDays(env);
  const rows = await env.DB.prepare(BOND_WARMTH_SQL).all();

  return (rows.results || []).map((r: any) => {
    const daysSince = r.days_since !== null && r.days_since !== undefined ? Number(r.days_since) : null;
    const touched = r.last_observed_at;
    return {
      id: r.id as number,
      name: r.name as string,
      state: classifyWarmth(daysSince, days),
      days_since: daysSince === null ? null : Math.round(daysSince * 10) / 10,
      last_observed_at: touched == null ? null : touched instanceof Date ? touched.toISOString() : String(touched),
      last_touch_source: (r.last_touch_source ?? null) as BondWarmth['last_touch_source'],
    };
  });
}
