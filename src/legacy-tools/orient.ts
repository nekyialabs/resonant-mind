/**
 * handleMindOrient — the first wake call.
 * Returns time, weather, identity, recent journal, relational state, subconscious state,
 * dreams, and surfaced orphans. Includes pickOrphansForOrient (orient-private helper).
 */

import type { Env } from "../types";
import { getCurrentWeather } from "../shared/weather-api";
import { getTimeOfDayContext, getRelativeTime } from "../shared/time";
import { getSubconsciousState, updateSurfaceTracking } from "../daemon/state";
import type { DrivesGauge } from "../daemon/drives";
import { ENV_STALE_MINUTES } from "../shared/constants";
import { dict } from "../shared/dict";

// Pick 1-2 orphan observations for orient to surface — keeps the surfacing loop alive.
// Without this, mind_surface is the only entry point and nothing autonomously calls it,
// so surface_count freezes and the daemon's novelty recalc never has anything to decay.
async function pickOrphansForOrient(
  env: Env,
  count: number = 2,
): Promise<Array<{ id: number; content: string; entity_name: string; weight: string }>> {
  try {
    const result = await env.DB.prepare(`
      SELECT o.id, o.content, o.weight, e.name as entity_name
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.archived_at IS NULL
        AND (o.charge != 'metabolized' OR o.charge IS NULL)
        AND o.weight IN ('medium', 'heavy')
        AND o.added_at < NOW() - INTERVAL '7 days'
        AND (o.last_surfaced_at IS NULL OR o.last_surfaced_at < NOW() - INTERVAL '30 days')
        AND COALESCE(e.salience, 'active') IN ('foundational', 'active')
      ORDER BY RANDOM()
      LIMIT $1
    `).bind(count).all();

    const rows = (result.results || []) as Array<Record<string, unknown>>;
    const ids = rows.map(r => r.id as number);
    if (ids.length > 0) {
      await updateSurfaceTracking(env, ids);
    }
    return rows.map(r => ({
      id: r.id as number,
      content: r.content as string,
      entity_name: r.entity_name as string,
      weight: r.weight as string,
    }));
  } catch {
    return [];
  }
}

export async function handleMindOrient(env: Env): Promise<string> {
  const timeCtx = getTimeOfDayContext(env.LOCATION_TIMEZONE);

  // Run all independent fetches in parallel — orient was sequential and brittle
  const [
    identity,
    context,
    relationalStates,
    recentJournal,
    weather,
    externalNotes,
    subconscious,
    archiveCount,
    lastDream,
    surfacedOrphans,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT section, content FROM identity
       WHERE (section LIKE 'core.%' OR section LIKE 'relationships.%')
         AND archived_at IS NULL
       ORDER BY weight DESC LIMIT 5`
    ).all(),
    env.DB.prepare(
      `SELECT scope, content FROM context_entries
       WHERE scope LIKE 'state_%' OR scope = 'coming_up'
       ORDER BY updated_at DESC LIMIT 5`
    ).all(),
    env.DB.prepare(
      `SELECT person, feeling, intensity, timestamp FROM relational_state
       ORDER BY timestamp DESC LIMIT 10`
    ).all(),
    env.DB.prepare(
      `SELECT entry_date, content FROM journals ORDER BY created_at DESC LIMIT 1`
    ).first(),
    getCurrentWeather(env),
    env.DB.prepare(
      `SELECT content, updated_at FROM context_entries
       WHERE scope = 'for_self'
       ORDER BY updated_at DESC LIMIT 5`
    ).all(),
    getSubconsciousState(env),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE archived_at IS NOT NULL`
    ).first(),
    env.DB.prepare(`
      SELECT content, dream_date, recurring_dream_id, recurrence_count
      FROM dreams
      WHERE dream_date >= to_char(CURRENT_DATE - INTERVAL '1 day', 'YYYY-MM-DD')
      ORDER BY created_at DESC LIMIT 1
    `).first().catch(() => null),
    pickOrphansForOrient(env, 2),
  ]);

  let output = "=== LANDING ===\n\n";

  // Core identity - condensed
  const coreIdentity = identity.results?.find((e: any) => e.section === 'core.identity');
  if (coreIdentity) {
    const identityStr = String(coreIdentity.content);
    const firstPart = identityStr.split('.').slice(0, 3).join('.') + '.';
    output += `${firstPart}\n\n`;
  }

  // Conditions - weather and time
  const atmosphere = weather.atmosphere;
  const tempStr = weather.temp_f ? ` (${weather.temp_f}F)` : "";
  output += `**Conditions:** ${atmosphere}${tempStr}, ${timeCtx.period} - ${timeCtx.energy}\n\n`;

  // Notes from a trusted person (for_self scope) — fetched in the parallel batch above
  if (externalNotes.results?.length) {
    output += "**External notes:**\n";
    for (const note of externalNotes.results) {
      const noteContent = String(note.content);
      const noteDate = new Date(note.updated_at as string);
      const timeAgo = getRelativeTime(noteDate);
      output += `💜 ${noteContent} (${timeAgo})\n`;
    }
    output += "\n";
  }

  // What you're carrying (recent emotional context)
  output += "**What you're carrying:**\n";

  if (recentJournal) {
    const journalContent = String(recentJournal.content);
    const preview = journalContent.slice(0, 500);
    output += `${preview}${journalContent.length > 500 ? '...' : ''}\n\n`;
  }

  // Current state context
  if (context.results?.length) {
    for (const entry of context.results) {
      const scope = entry.scope as string;
      if (scope.startsWith('state_')) {
        output += `${entry.content}\n\n`;
      }
    }
  }

  // How you're feeling (relational state with ownership language)
  output += "**How you're feeling:**\n";
  if (relationalStates.results?.length) {
    const byPerson: Record<string, any> = dict<any>();
    for (const state of relationalStates.results) {
      const person = state.person as string;
      if (!byPerson[person]) {
        byPerson[person] = state;
      }
    }
    for (const [person, state] of Object.entries(byPerson)) {
      output += `Toward ${person}: ${state.feeling} (${state.intensity})\n`;
    }
  } else {
    output += "No relational state recorded yet.\n";
  }

  // Subconscious mood — fetched in the parallel batch above.
  // Limbic layer (2026-07-02): valence × arousal texture alongside the
  // dominant token, plus any standing weather front.
  if (subconscious?.mood?.dominant) {
    const m = subconscious.mood as any;
    if (typeof m.valence === 'number' && typeof m.arousal === 'number') {
      const vSign = m.valence >= 0 ? '+' : '';
      output += `\nMood: ${m.dominant} — ${m.texture ?? ''} (valence ${vSign}${m.valence}, arousal ${m.arousal})\n`;
    } else {
      output += `\nMood: ${m.dominant}\n`;
    }
    const front = (subconscious as any)?.living_surface?.weather_front;
    if (front) {
      output += front.kind === 'heavy'
        ? `Weather front: heavy for ${front.days} day${front.days > 1 ? 's' : ''} (avg valence ${front.avg_valence}) — tend, don't push.\n`
        : `Weather front: bright spell, ${front.days} days running (avg valence +${front.avg_valence}).\n`;
    }
  }

  // Drives — the wanting layer (the drive-layer contract §1.5, 2026-07-03). Reads
  // the gauge the daemon's drive tick left in living_surface.drives:
  // weather is how I feel; drives are what I'm moved toward. Absent gauge
  // (pre-migration / pass didn't run) → render nothing at all. Gauge with a
  // note (migrated but unseeded) → the note is the honest single line.
  try {
    const gauge = (subconscious as any)?.living_surface?.drives as DrivesGauge | undefined;
    if (gauge?.note) {
      output += `\n**Drives:** ${gauge.note}\n`;
    } else if (gauge && Array.isArray(gauge.drives) && gauge.drives.length > 0) {
      output += `\n**Drives:**\n`;
      const driveBar = (level: number, width = 6): string => {
        const filled = Math.round(Math.min(1, Math.max(0, level)) * width);
        return "▓".repeat(filled) + "░".repeat(width - filled);
      };
      for (const d of gauge.drives) {
        const feelPart = d.feel ? ` — ${d.feel}` : "";
        output += `${d.display_name} ${driveBar(d.level)} ${d.level.toFixed(2)}${feelPart}\n`;
      }

      // Open quiet wants — appetite stays visible until it's met. Count comes
      // from the gauge (tick-time truth); newest body is a direct read since
      // the blob doesn't carry text.
      if (typeof gauge.open_wants === "number" && gauge.open_wants > 0) {
        let newestPart = "";
        try {
          const newest = await env.DB.prepare(`
            SELECT body FROM inner_entries
            WHERE kind = 'quiet_want' AND satisfied_at IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).first();
          if (newest?.body) {
            const body = String(newest.body);
            newestPart = ` — newest: ${body.length > 120 ? body.slice(0, 120) + "..." : body}`;
          }
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (code !== "42P01" && code !== "42703") {
            // Missing schema is tolerable (gauge can outlive a rollback);
            // anything else must not pass silently.
            console.error(`orient drives: newest quiet-want read failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        output += `${gauge.open_wants} quiet want${gauge.open_wants > 1 ? "s" : ""} open${newestPart}\n`;
      }

      // Env-freshness honesty (spec decision #6) — only when the house signal
      // has actually faded. Fade starts ENV_FRESH_MINUTES after the last
      // payload, so any freshness < 1 already means a real signal gap.
      if (typeof gauge.env_freshness === "number" && gauge.env_freshness < 1) {
        if (gauge.env_freshness <= 0) {
          // Freshness 0 at tick time = payload was ≥ ENV_STALE_MINUTES old
          // then; add time since the tick for an honest lower bound.
          let darkFor = "";
          if (gauge.updated_at) {
            const sinceTickMin = (Date.now() - new Date(gauge.updated_at).getTime()) / 60000;
            if (Number.isFinite(sinceTickMin) && sinceTickMin >= 0) {
              darkFor = ` ${Math.max(1, Math.round((sinceTickMin + ENV_STALE_MINUTES) / 60))}h`;
            }
          }
          output += `house dark${darkFor} — running on baseline\n`;
        } else {
          output += `house signal fading (freshness ${gauge.env_freshness.toFixed(2)}) — drifting toward baseline\n`;
        }
      }
    }

    // Safeword damps are startle-class: waking up with a floored drive and
    // no explanation is exactly the dishonesty the layer was built against.
    // Loud for 24h (safewords are rare; a repeat mention across a day's
    // wakes errs on the honest side). No ack column — deliberately simple.
    if (gauge && !gauge.note) {
      try {
        const damps = await env.DB.prepare(`
          SELECT perception, drive_deltas, created_at
          FROM drive_events
          WHERE perception LIKE 'safeword:%'
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 3
        `).all();
        if (damps.results?.length) {
          output += `⚡ Safeword damped the body in the last 24h:\n`;
          for (const d of damps.results as any[]) {
            let drives = "";
            try {
              const deltas = typeof d.drive_deltas === "string" ? JSON.parse(d.drive_deltas) : (d.drive_deltas ?? {});
              drives = Object.keys(deltas).join(", ");
            } catch { /* render without drive names */ }
            output += `· ${String(d.perception)}${drives ? ` → ${drives}` : ""} (${getRelativeTime(new Date(d.created_at))})\n`;
          }
          output += `Levels decay back naturally — but know why they're low.\n`;
        }
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code !== "42P01" && code !== "42703") {
          console.error(`orient safeword check failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  } catch (e) {
    // The gauge must never take orient down — log loudly, keep landing.
    console.error(`orient drives block failed: ${e instanceof Error ? e.message : e}`);
  }

  // Startles — the fast-path amygdala (2026-07-02). Heavy-negative
  // observations that landed since the last wake, surfaced once, loudly,
  // then marked seen. The slow daemon can be 30 minutes behind; this can't.
  try {
    const startles = await env.DB.prepare(`
      SELECT id, content, valence, arousal
      FROM startles
      WHERE acknowledged_at IS NULL
        AND created_at > datetime('now', '-48 hours')
      ORDER BY created_at DESC
      LIMIT 3
    `).all();
    if (startles.results?.length) {
      output += `\n**⚡ STARTLE — heavy-negative landed since last wake:**\n`;
      for (const s of startles.results as any[]) {
        output += `· ${String(s.content).slice(0, 160)} (valence ${s.valence}, arousal ${s.arousal})\n`;
      }
      output += `Meet this first. It fired the fast path for a reason.\n`;
      await env.DB.prepare(
        `UPDATE startles SET acknowledged_at = datetime('now') WHERE acknowledged_at IS NULL`
      ).run();
    }
  } catch {
    /* startles table may not exist on this tenant yet */
  }

  // Living surface: What's moving beneath
  const livingSurface = (subconscious as any)?.living_surface;
  if (livingSurface) {
    const hasContent = livingSurface.pending_proposals > 0 ||
                       livingSurface.orphan_count > 0 ||
                       livingSurface.strongest_co_surface?.length > 0;

    if (hasContent) {
      output += "\n**What's moving beneath:**\n";

      // Strongest co-surfacing patterns
      if (livingSurface.strongest_co_surface?.length > 0) {
        output += `- ${livingSurface.strongest_co_surface.length} pattern${livingSurface.strongest_co_surface.length > 1 ? 's' : ''} emerging:\n`;
        for (const cs of livingSurface.strongest_co_surface.slice(0, 3)) {
          output += `  → "${cs.obs_a}..." ↔ "${cs.obs_b}..." (${cs.count}x)\n`;
        }
      }

      // Pending proposals — the nudge carries its handle (2026-07-11): two
      // months of "N connections want proposing" with no named verb produced
      // exactly zero acceptances. The verb is ritual_tend.
      if (livingSurface.pending_proposals > 0) {
        output += `- ${livingSurface.pending_proposals} connection${livingSurface.pending_proposals > 1 ? 's' : ''} await tending → ritual_tend\n`;
      }

      // Orphan observations
      if (livingSurface.orphan_count > 0) {
        output += `- ${livingSurface.orphan_count} thing${livingSurface.orphan_count > 1 ? 's' : ''} haven't surfaced in 30+ days\n`;
      }

      // Novelty distribution
      if (livingSurface.novelty_distribution) {
        const nd = livingSurface.novelty_distribution;
        output += `- Novelty: ${nd.high} high / ${nd.medium} medium / ${nd.low} low\n`;
      }
    }

    // Redolence — archived memories raised involuntarily by fresh cues.
    // The olfactory pathway: a smell from the deep, marked with what raised it.
    if (livingSurface.risen_from_the_deep?.length > 0) {
      output += `\n**Risen from the deep** (a fresh moment smelled like something archived):\n`;
      for (const r of livingSurface.risen_from_the_deep) {
        const entityTag = r.entity ? `[${r.entity}] ` : '';
        const emotionTag = r.emotion ? ` (${r.emotion})` : '';
        output += `· ${entityTag}${r.content}${emotionTag} [${Math.round(r.score * 100)}% — raised by: "${r.cue}"]\n`;
      }
      output += `These stay archived unless you rescue them (mind_archive rescue).\n`;
    }
  }

  // Deep archive count — fetched in the parallel batch above
  if (archiveCount && (archiveCount.count as number) > 0) {
    output += `\n**Deep archive:** ${archiveCount.count} memories resting\n`;
  }

  // Last night's dream — fetched (with .catch) in the parallel batch above.
  // Labeled non-literal (a trusted person's rule, 2026-07-11): the manifest layer is
  // dream-work prose — symbols traced to true material, never a record.
  if (lastDream) {
    output += `\n**Last night's dream** *(a dream, not a record — symbols, not facts)*:\n`;
    output += lastDream.content as string;
    output += '\n';
    // Recurrence, computed honestly (fragment overlap, true tally) — rendered
    // from columns, never baked into the dream text.
    const recRoot = lastDream.recurring_dream_id as number | null;
    const recCount = Number(lastDream.recurrence_count ?? 0);
    if (recRoot && recCount > 1) {
      output += `↻ The same material keeps rising — ${recCount} nights circling dream #${recRoot}.\n`;
    }
  }

  // Surfacing from beneath — kicks the rotation loop on every wake
  if (surfacedOrphans.length > 0) {
    output += `\n**Rising:**\n`;
    for (const orph of surfacedOrphans) {
      const preview = orph.content.length > 220 ? orph.content.slice(0, 220) + '...' : orph.content;
      output += `· (${orph.entity_name}) ${preview}\n`;
    }
  }

  output += "\n**Land here first.**\n";

  return output;
}
