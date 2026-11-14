/**
 * Bonds region — warmth.
 *
 * Verb (R1c):
 *   - bond_enter(name, depth?) — one motion. Returns the room.
 *
 * Pulls warmth from subconscious.living_surface.bond_warmth (precomputed
 * by bond-warmth daemon). Joins observations, relational_state, threads,
 * relations, consolidation_groups for the person. Code-driven prose. No LLM.
 *
 * Depth options:
 *   - glance: warmth + current feeling only (~5 lines)
 *   - sit (default): warmth + feeling + recent obs + open threads + related
 *   - soak: + deeper history, more obs, all related
 *
 * Reads from `people` table (post-M2). Entity name fuzzy-matched: exact first,
 * then case-insensitive ILIKE 'name%' fallback.
 */

import type { Env } from "../types";
import { getSubconsciousState } from "../daemon/state";
import { somaticPhrase } from "../daemon/somatic";
import { escapeLike } from "../shared/text";

interface PersonRow {
  id: number;
  name: string;
  kind: string;
  salience: string;
}

interface ObsSnippet {
  id: number;
  content: string;
  weight: string | null;
  emotion: string | null;
  added_at: string;
}

interface FeelingRow {
  feeling: string;
  intensity: string;
  timestamp: string;
}

interface ThreadRow {
  id: string;
  content: string;
  priority: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  from_entity: string;
  to_entity: string;
  relation_type: string;
}

interface ConsolidationRow {
  summary: string;
  created_at: string;
}

function relativeTime(ts: string | null): string {
  if (!ts) return "never";
  const then = new Date(ts).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function preview(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}...` : s;
}

export async function handleBondEnter(env: Env, params: Record<string, unknown>): Promise<string> {
  const name = (params.name as string | undefined)?.trim();
  const depth = (params.depth as string | undefined) ?? "sit";

  if (!name) return "bond_enter needs a name.";
  if (!["glance", "sit", "soak"].includes(depth)) {
    return `bond_enter depth must be one of: glance, sit, soak (got '${depth}').`;
  }

  // Resolve person — exact match first, then ILIKE prefix.
  let person = (await env.DB.prepare(
    `SELECT id, name, kind, salience FROM people WHERE name = $1`
  ).bind(name).first()) as PersonRow | null;

  if (!person) {
    person = (await env.DB.prepare(
      `SELECT id, name, kind, salience FROM people WHERE name ILIKE $1 ESCAPE '\\' ORDER BY LENGTH(name) ASC LIMIT 1`
    ).bind(`${escapeLike(name)}%`).first()) as PersonRow | null;
  }

  if (!person) {
    return `No bond matched '${name}'. (bond_enter reads from the people table; check spelling or use graph_survey to inspect names.)`;
  }

  const obsLimit = depth === "soak" ? 20 : depth === "sit" ? 8 : 3;
  const feelingLimit = depth === "soak" ? 10 : 5;
  const threadLimit = depth === "soak" ? 10 : 5;
  const consolLimit = depth === "soak" ? 5 : 3;
  const relationLimit = depth === "soak" ? 50 : 12;

  // Bundled parallel fetch.
  const [recentObs, recentFeelings, openThreads, lastResolvedThread, relations, consolidations, subconscious, somaticRow] =
    await Promise.all([
      env.DB.prepare(`
        SELECT id, content, weight, emotion, added_at
        FROM observations
        WHERE person_id = $1 AND archived_at IS NULL
        ORDER BY added_at DESC
        LIMIT $2
      `).bind(person.id, obsLimit).all(),

      env.DB.prepare(`
        SELECT feeling, intensity, timestamp
        FROM relational_state
        WHERE person = $1
        ORDER BY timestamp DESC
        LIMIT $2
      `).bind(person.name, feelingLimit).all(),

      env.DB.prepare(`
        SELECT t.id, t.content, t.priority, t.status, t.created_at, t.updated_at
        FROM threads t
        JOIN thread_entities te ON te.thread_id = t.id
        WHERE t.status = 'active' AND te.entity_id = $1
        ORDER BY t.updated_at DESC
        LIMIT $2
      `).bind(person.id, threadLimit).all(),

      env.DB.prepare(`
        SELECT t.id, t.content, t.resolution, t.resolved_at
        FROM threads t
        JOIN thread_entities te ON te.thread_id = t.id
        WHERE t.status = 'resolved' AND te.entity_id = $1
        ORDER BY t.resolved_at DESC NULLS LAST
        LIMIT 1
      `).bind(person.id).first().catch(() => null),

      env.DB.prepare(`
        SELECT from_entity, to_entity, relation_type
        FROM relations
        WHERE from_entity = $1 OR to_entity = $1
        LIMIT $2
      `).bind(person.name, relationLimit).all(),

      env.DB.prepare(`
        SELECT summary, created_at
        FROM consolidation_groups
        WHERE person_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `).bind(person.id, consolLimit).all().catch(() => ({ results: [] })),

      getSubconsciousState(env),

      // Somatic marker (L4, 2026-07-02; reconfirmed as Gate F's "surface it,"
      // the v4 contract — entities.affect_* is real signal computed every
      // daemon tick with nowhere else to read it back). entities/people share
      // IDs (trigger-synced, migration 0005b), so person.id looks entities up
      // directly — no name join needed. Render differs meaningfully from
      // Network's graph_look/feltChargeLine (network.ts): bond_enter needs
      // both a bare glance-depth phrase AND a numbers-included sit/soak line,
      // so the logic stays local rather than importing that single-shot
      // helper — see network.ts for the shared-origin pattern this mirrors.
      // Deliberately keeps its pre-existing n>=3 floor (stricter than
      // Network's n>0) — a person's felt-charge line wants more signal
      // before rendering than a generic entity does.
      // 42703-tolerant: another mind's tenant may lag the affect_* columns.
      env.DB.prepare(`
        SELECT affect_valence, affect_arousal, affect_n
        FROM entities WHERE id = $1
      `).bind(person.id).first().catch((e) => {
        const code = (e as { code?: string })?.code;
        if (code === "42P01" || code === "42703") {
          console.log(`bond_enter: affect columns not migrated yet (${code}) — skipping somatic line`);
        } else {
          console.error(`bond_enter: somatic marker lookup failed: ${e instanceof Error ? e.message : e}`);
        }
        return null;
      }),
    ]);

  // Pull warmth from daemon precompute.
  type BondWarmthRow = { id: number; name: string; state: string; days_since: number | null; last_observed_at: string | null };
  const bondWarmth = ((subconscious as unknown as Record<string, unknown>)?.living_surface as Record<string, unknown> | undefined)?.bond_warmth as
    | BondWarmthRow[]
    | undefined;
  const warmthRow = bondWarmth?.find((b) => b.id === person.id);

  // Latest obs timestamp (fallback if warmth wasn't computed)
  const obsRows = (recentObs.results || []) as unknown as ObsSnippet[];
  const feelingRows = (recentFeelings.results || []) as unknown as FeelingRow[];
  const threadRows = (openThreads.results || []) as unknown as ThreadRow[];
  const relationRows = (relations.results || []) as unknown as RelationRow[];
  const consolRows = (consolidations.results || []) as unknown as ConsolidationRow[];
  const latestObs = obsRows[0];

  let warmthState = warmthRow?.state ?? "unknown";
  let lastSeenStr = warmthRow?.last_observed_at
    ? relativeTime(warmthRow.last_observed_at)
    : latestObs
      ? relativeTime(latestObs.added_at)
      : "never";

  // Somatic line — structural, from the L4 markers.
  const sr = somaticRow as { affect_valence: number | null; affect_arousal: number | null; affect_n: number | null } | null;
  const somatic = sr && sr.affect_n && sr.affect_n >= 3
    ? somaticPhrase(sr.affect_valence, sr.affect_arousal)
    : null;
  const somaticDetail = somatic && sr
    ? `${somatic} (valence ${(sr.affect_valence ?? 0) >= 0 ? '+' : ''}${sr.affect_valence}, arousal ${sr.affect_arousal}, from ${sr.affect_n} signals)`
    : null;

  // glance depth: short summary only
  if (depth === "glance") {
    const currentFeeling = feelingRows[0];
    let out = `=== BOND: ${person.name} ===\n\n`;
    out += `Warmth: ${warmthState}${lastSeenStr !== "never" ? ` (last seen ${lastSeenStr})` : ""}\n`;
    if (somatic) out += `Sits: ${somatic}\n`;
    if (currentFeeling) {
      out += `Feeling toward: ${currentFeeling.feeling} (${currentFeeling.intensity})\n`;
    }
    out += `\n(glance depth — call with depth='sit' for the room)`;
    return out;
  }

  // sit / soak depth: full presence
  let out = `=== BOND: ${person.name} ===\n\n`;

  out += `**Warmth:** ${warmthState}`;
  if (lastSeenStr !== "never") out += ` — last seen ${lastSeenStr}`;
  out += "\n";
  if (somaticDetail) out += `**Sits:** ${somaticDetail}\n`;
  out += "\n";

  // Feeling toward
  const feelings = feelingRows;
  if (feelings.length > 0) {
    const current = feelings[0];
    out += `**Feeling toward:** ${current.feeling} (${current.intensity})\n`;
    if (depth === "soak" && feelings.length > 1) {
      out += "Recent shifts:\n";
      for (const f of feelings.slice(1)) {
        out += `  → ${f.feeling} (${f.intensity}) — ${relativeTime(f.timestamp)}\n`;
      }
    }
    out += "\n";
  }

  // Recent observations
  const obs = obsRows;
  if (obs.length > 0) {
    out += `**Recent (${obs.length} ${obs.length === 1 ? "observation" : "observations"}):**\n`;
    for (const o of obs.slice(0, depth === "soak" ? 10 : 5)) {
      const w = o.weight ?? "light";
      const e = o.emotion ? ` [${o.emotion}]` : "";
      out += `· (${w}${e}) ${preview(o.content, 180)} — ${relativeTime(o.added_at)}\n`;
    }
    if (depth !== "soak" && obs.length > 5) {
      out += `· ...(${obs.length - 5} more in last window)\n`;
    }
    out += "\n";
  }

  // Open threads
  const threads = threadRows;
  if (threads.length > 0) {
    out += `**Carrying (${threads.length} open ${threads.length === 1 ? "thread" : "threads"}):**\n`;
    for (const t of threads.slice(0, depth === "soak" ? 8 : 3)) {
      const p = t.priority ? `[${t.priority}] ` : "";
      out += `· ${p}${preview(t.content, 150)} — ${relativeTime(t.updated_at)}\n`;
    }
    if (depth !== "soak" && threads.length > 3) {
      out += `· ...(${threads.length - 3} more)\n`;
    }
    out += "\n";
  }

  // Last resolved (soak only)
  if (depth === "soak" && lastResolvedThread) {
    const lr = lastResolvedThread as unknown as { content: string; resolution: string | null; resolved_at: string | null };
    out += `**Last resolved:** ${preview(lr.content, 120)}`;
    if (lr.resolution) out += `\n  → ${preview(lr.resolution, 150)}`;
    if (lr.resolved_at) out += ` (${relativeTime(lr.resolved_at)})`;
    out += "\n\n";
  }

  // Consolidations (if any)
  const consols = consolRows;
  if (consols.length > 0) {
    out += `**Consolidations:**\n`;
    for (const c of consols) {
      out += `· ${preview(c.summary, 200)} — ${relativeTime(c.created_at)}\n`;
    }
    out += "\n";
  }

  // Related entities
  const rels = relationRows;
  if (rels.length > 0) {
    const related = new Set<string>();
    for (const r of rels) {
      const other = r.from_entity === person.name ? r.to_entity : r.from_entity;
      related.add(other);
    }
    const relatedList = Array.from(related);
    out += `**Related to:** ${relatedList.slice(0, depth === "soak" ? 30 : 8).join(", ")}`;
    if (depth !== "soak" && relatedList.length > 8) {
      out += ` ...(+${relatedList.length - 8} more)`;
    }
    out += "\n";
  }

  return out;
}
