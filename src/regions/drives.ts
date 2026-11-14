/**
 * Drives region — the wanting layer's public surface (the drive-layer contract §1.4,
 * decision #10). The eighth region.
 *
 * Weather is how I feel; drives are what I'm moved toward; somatic is what
 * history left in me. Three organs, never merged.
 *
 * Verbs:
 *   - drive_state     — pure read: the gauge (bar, level, resting-toward,
 *                       body-feel, tendencies, regulation note) + env
 *                       freshness + open quiet wants.
 *   - drive_perceive  — a perception nudges a drive; sample + event row.
 *   - drive_touch     — mapped interaction deltas (TOUCH_KINDS × intensity).
 *   - drive_safeword  — damp to floor, audited. Damp, NOT lock — decays back.
 *   - drive_pulse     — manual environment write ("a trusted person just walked in").
 *   - quietly_want    — inner ledger entry + SEEKING nudge (charge × 0.5).
 *   - want_met        — satisfy a want; SEEKING settles, CARE/PLAY brighten.
 *   - small_joy       — inner ledger entry + PLAY nudge (charge × 0.4).
 *
 * All math and shared reads live in daemon/drives.ts (the engine) — this file
 * is the facade: parse params, read once, compute in memory, persist, and
 * render from the KNOWN values (spec decision #8 — never write-then-re-read).
 *
 * Multi-write ordering (no transactions — adapter opens a fresh client per
 * statement): sample rows FIRST (the body actually moves), event row SECOND
 * (the why-log). A failed event after a landed sample = needle moved, logbook
 * gap — the echo says so honestly. The reverse order would let the logbook
 * claim movement that never happened, which is worse.
 *
 * Stance (spec decision #4): advisory pressure only. Nothing here archives,
 * deletes, or overrides compass/spine/consent.
 */

import type { Env } from "../types";
import {
  type DriveRow,
  type BodyFeelBand,
  type ActionBiasBand,
  envFreshnessWeight,
  envContribution,
  effectiveBaseline,
  currentLevel,
  pickBand,
  renderDriveLine,
  CANONICAL_TOUCH_KINDS,
  availableTouchKinds,
  applyTouch,
  dampedLevel,
  readEnabledDrives,
  readLatestDriveSamples,
  readLatestEnvironment,
} from "../daemon/drives";
import {
  DRIVE_DEFAULT_BASELINE,
  DRIVE_DEFAULT_HALF_LIFE_HOURS,
} from "../shared/constants";

// ============================================================
// SHARED SMALL PIECES
// ============================================================

const NOT_MIGRATED =
  "Drive layer not migrated on this tenant — the wanting layer has no tables here yet.";

const NO_DRIVES =
  "No drives walked in yet — they are seeded deliberately, one at a time.";

/** undefined_table / undefined_column — schema not migrated. Everything else rethrows. */
function isMissingSchema(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "42P01" || code === "42703";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (n: number) => n.toFixed(2);
const fmtDelta = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/** One computed drive: its row, the attractor it rests toward, its decayed level NOW. */
interface DriveState {
  row: DriveRow;
  effBase: number;
  level: number;
}

interface DriveContext {
  states: DriveState[];
  payload: Record<string, number>;
  freshness: number;
  envAt: Date | null;
}

/**
 * One read of the whole wanting layer: enabled drives, latest samples (one
 * query), latest environment — then decayed levels computed IN MEMORY. Every
 * verb starts here and renders from these known values.
 */
async function readDriveContext(env: Env, now: Date): Promise<DriveContext> {
  const rows = await readEnabledDrives(env);
  const samples = await readLatestDriveSamples(env);
  const envRow = await readLatestEnvironment(env);
  const freshness = envRow ? envFreshnessWeight(envRow.at, now) : 0;
  const payload = envRow?.payload ?? {};
  const states = rows.map((row) => {
    const contrib = envContribution(row.env_sensitivity, payload, freshness);
    const effBase = effectiveBaseline(row, contrib);
    const level = currentLevel(row, effBase, samples.get(`drive:${row.drive}`) ?? null, now);
    return { row, effBase, level };
  });
  return { states, payload, freshness, envAt: envRow?.at ?? null };
}

function findState(ctx: DriveContext, drive: string): DriveState | null {
  const key = drive.trim().toLowerCase();
  return ctx.states.find((s) => s.row.drive.toLowerCase() === key) ?? null;
}

function walkedInList(ctx: DriveContext): string {
  return ctx.states.length
    ? `Walked in: ${ctx.states.map((s) => s.row.drive).join(", ")}.`
    : NO_DRIVES;
}

function renderEnvLine(envAt: Date | null, freshness: number, now: Date): string {
  if (!envAt) return "House: no environment signal yet — resting on bare baselines.";
  const ageMin = Math.round((now.getTime() - envAt.getTime()) / 60000);
  const age = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
  if (freshness >= 1) return `House: env fresh (${age} old) — full weight.`;
  if (freshness > 0) return `House: env fading (${age} old) — weight ${fmt(freshness)}.`;
  return `House: dark for ${age} — env contribution zero, running on baseline.`;
}

/**
 * Persist post-nudge levels as ledger rows. One multi-row INSERT; the
 * adapter's .success is hardcoded true, so .meta.changes is the truth.
 * Returns a warning string when the write came up short, null when clean.
 */
async function insertSamples(
  env: Env,
  rows: Array<{ drive: string; level: number; content: Record<string, unknown> }>,
  source: string
): Promise<string | null> {
  if (rows.length === 0) return null;
  const placeholders = rows.map(() => "(?, ?, ?, ?)").join(", ");
  const binds: unknown[] = [];
  for (const r of rows) {
    binds.push(`drive:${r.drive}`, r.level, JSON.stringify(r.content), source);
  }
  const res = await env.DB.prepare(`
    INSERT INTO drive_states (state_type, level, content, source)
    VALUES ${placeholders}
  `).bind(...binds).run();
  if (res.meta.changes !== rows.length) {
    console.error(`[drives] sample insert wrote ${res.meta.changes}/${rows.length} rows (source=${source})`);
    return `only ${res.meta.changes}/${rows.length} level rows persisted`;
  }
  return null;
}

/**
 * The why-log. Written AFTER samples (see file header for the ordering
 * argument). Failure is caught, de-swallowed to console.error, and returned
 * as a warning so the echo stays honest — except missing-schema, which
 * rethrows to the verb's outer guard.
 */
async function insertEvent(
  env: Env,
  perception: string,
  deltas: Record<string, number>,
  appraisal?: Record<string, unknown>,
  advisory?: string
): Promise<{ id: number | null; warning: string | null }> {
  try {
    const row = (await env.DB.prepare(`
      INSERT INTO drive_events (perception, appraisal, drive_deltas, advisory)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `).bind(
      perception,
      JSON.stringify(appraisal ?? {}),
      JSON.stringify(deltas),
      advisory ?? null
    ).first()) as { id: number | string } | null;
    if (!row) {
      return { id: null, warning: "event log insert returned no row — the logbook did NOT record why" };
    }
    return { id: Number(row.id), warning: null };
  } catch (e) {
    if (isMissingSchema(e)) throw e;
    console.error(`[drives] event log insert failed: ${e instanceof Error ? e.message : e}`);
    return { id: null, warning: "event log failed" };
  }
}

/** One nudge: what we tried, what the body accepted, where the needle sits now. */
interface NudgeResult {
  drive: string;
  display: string;
  before: number;
  applied: number;
  recorded: number;
  level: number;
}

/**
 * Shared nudge path — drive_perceive, quietly_want, want_met, and small_joy
 * all move needles through here (spec §1.4: the want→SEEKING nudge follows
 * the perceive shape). Drives not walked in are skipped silently and listed
 * back to the caller. Applied = signed intensity on the DECAYED level;
 * recorded = post-clamp actual.
 */
async function applyNudges(
  env: Env,
  ctx: DriveContext,
  nudges: Array<{ drive: string; intensity: number; direction: "up" | "down" }>,
  perception: string,
  source: string,
  appraisal?: Record<string, unknown>
): Promise<{ moved: NudgeResult[]; skipped: string[]; warnings: string[]; eventId: number | null }> {
  const moved: NudgeResult[] = [];
  const skipped: string[] = [];
  for (const n of nudges) {
    const state = findState(ctx, n.drive);
    if (!state) {
      skipped.push(n.drive);
      continue;
    }
    const applied = clamp(n.intensity, 0, 1) * (n.direction === "down" ? -1 : 1);
    const next = clamp(state.level + applied, state.row.floor, state.row.ceiling);
    moved.push({
      drive: state.row.drive,
      display: state.row.display_name || state.row.drive,
      before: state.level,
      applied,
      recorded: next - state.level,
      level: next,
    });
  }

  const warnings: string[] = [];
  let eventId: number | null = null;
  if (moved.length > 0) {
    // Stored levels stay full-precision (rounding the anchor freezes decay).
    const sampleWarn = await insertSamples(
      env,
      moved.map((m) => ({
        drive: m.drive,
        level: m.level,
        content: { applied: m.applied, recorded: m.recorded, perception },
      })),
      source
    );
    if (sampleWarn) warnings.push(sampleWarn);

    const deltas: Record<string, number> = {};
    for (const m of moved) deltas[m.drive] = m.recorded;
    const ev = await insertEvent(env, perception, deltas, appraisal);
    if (ev.warning) warnings.push(ev.warning);
    eventId = ev.id;
  }
  return { moved, skipped, warnings, eventId };
}

function renderNudgeLines(moved: NudgeResult[]): string {
  return moved
    .map(
      (m) =>
        `${m.display.toUpperCase()}: ${fmt(m.before)} → ${fmt(m.level)} (applied ${fmtDelta(m.applied)}, body accepted ${fmtDelta(m.recorded)})`
    )
    .join("\n");
}

// ============================================================
// drive_state — the gauge. Pure read.
// ============================================================

/** "3m ago" / "2.5h ago" / "4d ago" for the history read. */
function timeAgo(at: Date, now: Date): string {
  const min = Math.max(0, (now.getTime() - at.getTime()) / 60000);
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

export async function handleDriveState(env: Env, params: Record<string, unknown>): Promise<string> {
  const driveFilter = (params.drive as string | undefined)?.trim();
  const historyRaw = params.history;
  const now = new Date();

  try {
    const ctx = await readDriveContext(env, now);

    if (ctx.states.length === 0) return NO_DRIVES;

    let states = ctx.states;
    if (driveFilter) {
      const one = findState(ctx, driveFilter);
      if (!one) return `No drive named '${driveFilter}' is walked in. ${walkedInList(ctx)}`;
      states = [one];
    }

    let out = "=== DRIVES ===\n\nWhat I'm moved toward. Advisory pressure only — never overrides compass, spine, or consent.\n\n";
    for (const s of states) {
      out += renderDriveLine(s.row, s.level, s.effBase) + "\n";
      const bias = pickBand(s.row.action_bias, s.level);
      if (bias && bias.tendencies.length > 0) {
        out += `  leans: ${bias.tendencies.join(", ")}\n`;
      }
      if (s.row.regulation_note) {
        out += `  note: ${s.row.regulation_note}\n`;
      }
      out += "\n";
    }

    out += renderEnvLine(ctx.envAt, ctx.freshness, now) + "\n";

    // Open quiet wants — appetite that hasn't been met yet.
    const countRow = (await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM inner_entries
      WHERE kind = 'quiet_want' AND satisfied_at IS NULL
    `).first()) as { count: number | string } | null;
    const openWants = Number(countRow?.count ?? 0);
    if (openWants > 0) {
      const newest = (await env.DB.prepare(`
        SELECT id, body FROM inner_entries
        WHERE kind = 'quiet_want' AND satisfied_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).first()) as { id: number | string; body: string } | null;
      out += `Open quiet wants: ${openWants}${newest ? ` · newest: "${newest.body}" (#${newest.id})` : ""}\n`;
    } else {
      out += "Open quiet wants: none.\n";
    }

    // History — the why-log, read on demand (drive_events was write-only
    // until 2026-07-10; the gauge showed WHERE every needle sat and nothing
    // showed WHY it moved). Optional drive filter narrows to events whose
    // deltas touched that drive.
    if (historyRaw !== undefined && historyRaw !== null) {
      if (typeof historyRaw !== "number" || !Number.isFinite(historyRaw) || historyRaw < 1) {
        out += "\n(history must be a positive number — skipped.)\n";
        return out;
      }
      const limit = Math.min(50, Math.floor(historyRaw));
      const filterKey = driveFilter ? findState(ctx, driveFilter)?.row.drive : undefined;
      const events = filterKey
        ? await env.DB.prepare(`
            SELECT id, perception, drive_deltas, advisory, created_at
            FROM drive_events
            WHERE jsonb_exists(drive_deltas, ?)
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).bind(filterKey, limit).all()
        : await env.DB.prepare(`
            SELECT id, perception, drive_deltas, advisory, created_at
            FROM drive_events
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).bind(limit).all();
      const rows = (events.results || []) as Array<Record<string, unknown>>;
      out += `\n=== WHY THE NEEDLES MOVED${filterKey ? ` (${filterKey})` : ""} — last ${rows.length} ===\n`;
      if (rows.length === 0) {
        out += "No events logged yet.\n";
      }
      for (const r of rows) {
        const at = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
        let deltas: Record<string, number> = {};
        try {
          deltas = typeof r.drive_deltas === "string" ? JSON.parse(r.drive_deltas) : ((r.drive_deltas as Record<string, number>) ?? {});
        } catch { /* render without deltas */ }
        const deltaStr = Object.entries(deltas)
          .map(([k, v]) => `${k} ${fmtDelta(Number(v))}`)
          .join(", ");
        out += `#${r.id} · ${timeAgo(at, now)} · ${String(r.perception ?? "").slice(0, 120)}${deltaStr ? ` · ${deltaStr}` : " · (nothing moved)"}${r.advisory ? ` · ⚑ ${r.advisory}` : ""}\n`;
      }
    }

    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// drive_perceive — a perception moves a needle.
// ============================================================

export async function handleDrivePerceive(env: Env, params: Record<string, unknown>): Promise<string> {
  const perception = (params.perception as string | undefined)?.trim();
  const drive = ((params.drive as string | undefined) ?? "seeking").trim();
  const intensityRaw = (params.intensity as number | undefined) ?? 0.3;
  const direction = ((params.direction as string | undefined) ?? "up").trim();
  const appraisal = params.appraisal as Record<string, unknown> | undefined;

  if (!perception) return "drive_perceive needs `perception` — what was felt.";
  if (direction !== "up" && direction !== "down") {
    return `drive_perceive direction must be 'up' or 'down', got '${direction}'. Nothing written.`;
  }
  if (typeof intensityRaw !== "number" || !Number.isFinite(intensityRaw)) {
    return "drive_perceive intensity must be a number in [0, 1]. Nothing written.";
  }

  const now = new Date();
  try {
    const ctx = await readDriveContext(env, now);
    const state = findState(ctx, drive);
    if (!state) {
      // Honest miss — no write of any kind.
      return `No drive named '${drive}' is walked in — nothing written. ${walkedInList(ctx)}`;
    }

    const { moved, warnings, eventId } = await applyNudges(
      env,
      ctx,
      [{ drive, intensity: intensityRaw, direction }],
      perception,
      "perceive",
      appraisal
    );

    const m = moved[0];
    let out = renderNudgeLines(moved) + "\n";
    out += renderDriveLine(state.row, m.level, state.effBase) + "\n";
    out += `Logged: "${perception}"${eventId !== null ? ` (event #${eventId})` : ""}`;
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// drive_touch — mapped interaction deltas.
// ============================================================

export async function handleDriveTouch(env: Env, params: Record<string, unknown>): Promise<string> {
  const kind = (params.kind as string | undefined)?.trim();
  const what = (params.what as string | undefined)?.trim();
  const intensityRaw = (params.intensity as number | undefined) ?? 0.6;

  if (!kind) {
    return `drive_touch needs \`kind\`. Canonical kinds: ${CANONICAL_TOUCH_KINDS.join(", ")} — live kinds are whatever the walked-in drives' touch_affinities respond to.`;
  }
  if (typeof intensityRaw !== "number" || !Number.isFinite(intensityRaw)) {
    return "drive_touch intensity must be a number in [0, 1]. Nothing written.";
  }
  const intensity = clamp(intensityRaw, 0, 1);
  const perception = `touch: ${kind}${what ? ` — ${what}` : ""}`;

  const now = new Date();
  try {
    const ctx = await readDriveContext(env, now);
    if (ctx.states.length === 0) return NO_DRIVES;

    // Kinds are DATA (drives.touch_affinities, migration 0012) — the live
    // vocabulary is whatever the walked-in temperament responds to.
    const kinds = availableTouchKinds(ctx.states.map((s) => s.row));
    if (!kinds.includes(kind)) {
      // Unresponsive kind: still log the event (the interaction was real),
      // then teach the live kinds list.
      const ev = await insertEvent(env, perception, {}, undefined, `no drive responds to touch kind '${kind}'`);
      let out = kinds.length
        ? `No walked-in drive responds to '${kind}' — nothing moved. Live kinds: ${kinds.join(", ")}.`
        : `No walked-in drive has touch_affinities yet — touch moves nothing until they're tuned in (drive_tune). Canonical kinds: ${CANONICAL_TOUCH_KINDS.join(", ")}.`;
      out += ev.id !== null ? `\n(Event logged anyway — #${ev.id}.)` : `\n⚠ ${ev.warning}`;
      return out;
    }

    // Engine applies each drive's own affinity delta × intensity on the
    // decayed levels.
    const results = applyTouch(
      kind,
      intensity,
      ctx.states.map((s) => ({ row: s.row, level: s.level }))
    );

    if (results.length === 0) {
      // Defensive — kinds came from the same rows, so this shouldn't happen.
      const ev = await insertEvent(env, perception, {}, undefined, "no responding drives");
      let out = `Touch felt, but no drive responded to '${kind}' — nothing moved.`;
      out += ev.id !== null ? ` (event #${ev.id})` : ` ⚠ ${ev.warning}`;
      return out;
    }

    const warnings: string[] = [];
    const sampleWarn = await insertSamples(
      env,
      results.map((r) => ({
        drive: r.drive,
        level: r.level,
        content: { applied: r.applied, recorded: r.recorded, perception },
      })),
      "touch"
    );
    if (sampleWarn) warnings.push(sampleWarn);

    const deltas: Record<string, number> = {};
    for (const r of results) deltas[r.drive] = r.recorded;
    const ev = await insertEvent(env, perception, deltas, { kind, intensity });
    if (ev.warning) warnings.push(ev.warning);

    const byDrive = new Map(ctx.states.map((s) => [s.row.drive, s]));
    let out = `Touch — ${kind}${what ? ` (${what})` : ""} × ${fmt(intensity)}:\n`;
    for (const r of results) {
      const s = byDrive.get(r.drive)!;
      const before = s.level;
      out += `${(s.row.display_name || r.drive).toUpperCase()}: ${fmt(before)} → ${fmt(r.level)} (applied ${fmtDelta(r.applied)}, body accepted ${fmtDelta(r.recorded)})\n`;
    }
    if (ev.id !== null) out += `(event #${ev.id})`;
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// drive_safeword — damp to floor, audited. Damp, NOT lock.
// ============================================================

export async function handleDriveSafeword(env: Env, params: Record<string, unknown>): Promise<string> {
  const driveFilter = (params.drive as string | undefined)?.trim();
  const phrase = ((params.phrase as string | undefined) ?? "Stop").trim() || "Stop";

  const now = new Date();
  try {
    const ctx = await readDriveContext(env, now);
    if (ctx.states.length === 0) return NO_DRIVES;

    let targets = ctx.states;
    if (driveFilter) {
      const one = findState(ctx, driveFilter);
      if (!one) return `No drive named '${driveFilter}' is walked in — nothing damped. ${walkedInList(ctx)}`;
      targets = [one];
    }

    const perception = `safeword: ${phrase}`;
    const damped = targets.map((s) => {
      const floor = dampedLevel(s.row);
      return { state: s, floor, recorded: floor - s.level };
    });

    const warnings: string[] = [];
    const sampleWarn = await insertSamples(
      env,
      damped.map((d) => ({
        drive: d.state.row.drive,
        level: d.floor,
        content: { applied: d.recorded, recorded: d.recorded, perception },
      })),
      "safeword"
    );
    if (sampleWarn) warnings.push(sampleWarn);

    const deltas: Record<string, number> = {};
    for (const d of damped) deltas[d.state.row.drive] = d.recorded;
    const ev = await insertEvent(env, perception, deltas, undefined, "safeword damp — decays back naturally");
    if (ev.warning) warnings.push(ev.warning);

    let out = `Safeword "${phrase}" — damped:\n`;
    for (const d of damped) {
      out += `${(d.state.row.display_name || d.state.row.drive).toUpperCase()}: ${fmt(d.state.level)} → floor ${fmt(d.floor)}\n`;
    }
    out += "Damped, not locked: each decays back toward its resting point from here. A hold is enabled=false, never a floor.";
    if (ev.id !== null) out += `\n(event #${ev.id})`;
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// drive_pulse — manual environment write. "a trusted person just walked in."
// ============================================================

const PULSE_KEYS = [
  "inner_valence",
  "inner_arousal",
  "social_presence",
  "social_warmth",
  "care_deficit",
  "contact_hunger",
  "circadian_night",
] as const;

export async function handleDrivePulse(env: Env, params: Record<string, unknown>): Promise<string> {
  const note = (params.note as string | undefined)?.trim();

  // Validate every provided value to [-1, 1] — reject the whole pulse
  // otherwise (a half-valid environment is a wrong environment).
  const payload: Record<string, number> = {};
  const rejected: string[] = [];
  for (const key of PULSE_KEYS) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) {
      rejected.push(`${key}=${String(v)}`);
      continue;
    }
    payload[key] = v;
  }
  if (rejected.length > 0) {
    return `drive_pulse values must be numbers in [-1, 1]; rejected: ${rejected.join(", ")}. Nothing written.`;
  }
  if (Object.keys(payload).length === 0) {
    return `drive_pulse needs at least one signal (${PULSE_KEYS.join(", ")}). Nothing written.`;
  }

  const now = new Date();
  try {
    // envContribution skips non-numeric values, so a note string riding in
    // the payload is inert to the math but preserved in the ledger.
    const content: Record<string, unknown> = { ...payload };
    if (note) content.note = note;

    const inserted = await env.DB.prepare(`
      INSERT INTO drive_states (state_type, level, content, source)
      VALUES ('environment', NULL, ?, 'pulse')
    `).bind(JSON.stringify(content)).run();
    if (inserted.meta.changes !== 1) {
      return "Environment pulse FAILED to persist (0 rows written) — the house was not felt.";
    }

    // Render-from-known-value: this payload IS the environment now, freshness
    // 1 by construction. Recompute resting points in memory — no read-back.
    const drives = await readEnabledDrives(env);
    let out = `Environment felt (${Object.entries(payload).map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}).`;
    if (note) out += `\nNote: ${note}`;
    if (drives.length === 0) {
      out += `\n${NO_DRIVES} The house was felt anyway — it'll be there when they are.`;
      return out;
    }
    out += "\nResting points now:\n";
    for (const d of drives) {
      const contrib = envContribution(d.env_sensitivity, payload, 1);
      const effBase = effectiveBaseline(d, contrib);
      out += `${(d.display_name || d.drive).toUpperCase()} → resting toward ${fmt(effBase)} (baseline ${fmt(d.baseline)}, env ${fmtDelta(contrib)})\n`;
    }
    return out.trimEnd();
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// quietly_want — appetite, noticed. Inner ledger + SEEKING nudge.
// ============================================================

export async function handleQuietlyWant(env: Env, params: Record<string, unknown>): Promise<string> {
  const body = (params.body as string | undefined)?.trim();
  const about = (params.about as string | undefined)?.trim();
  const chargeRaw = (params.charge as number | undefined) ?? 0.4;

  if (!body) return "quietly_want needs `body` — the want itself, in your own words.";
  if (typeof chargeRaw !== "number" || !Number.isFinite(chargeRaw)) {
    return "quietly_want charge must be a number in [0, 1]. Nothing written.";
  }
  const charge = clamp(chargeRaw, 0, 1);

  const now = new Date();
  try {
    // Entry first — the want is the record; the gauge nudge is its echo.
    const entry = (await env.DB.prepare(`
      INSERT INTO inner_entries (kind, body, about, charge)
      VALUES ('quiet_want', ?, ?, ?)
      RETURNING id
    `).bind(body, about ?? null, charge).first()) as { id: number | string } | null;
    if (!entry) return "quietly_want FAILED — the entry insert returned no row. Nothing recorded, gauge untouched.";
    const entryId = Number(entry.id);

    // SEEKING feels it — same code path as drive_perceive (spec §1.4).
    const ctx = await readDriveContext(env, now);
    const { moved, skipped, warnings, eventId } = await applyNudges(
      env,
      ctx,
      [{ drive: "seeking", intensity: charge * 0.5, direction: "up" }],
      `quiet want: ${body}`,
      "want"
    );

    let out = `Quiet want #${entryId}: "${body}"${about ? ` (about: ${about})` : ""} · charge ${fmt(charge)}\n`;
    if (moved.length > 0) {
      out += renderNudgeLines(moved);
      if (eventId !== null) out += ` (event #${eventId})`;
    } else if (skipped.length > 0) {
      out += "The entry landed, but SEEKING isn't walked in yet — the gauge didn't move.";
    }
    out += "\nIt stays open in orient until want_met.";
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// want_met — a want satisfied. SEEKING settles, CARE/PLAY brighten.
// ============================================================

export async function handleWantMet(env: Env, params: Record<string, unknown>): Promise<string> {
  const id = params.id as number | undefined;
  const note = (params.note as string | undefined)?.trim();

  if (typeof id !== "number" || !Number.isFinite(id)) return "want_met needs `id` — the quiet want's entry id.";

  const now = new Date();
  try {
    // Read the want first — charge drives the nudges, body drives the echo.
    const want = (await env.DB.prepare(`
      SELECT id, body, charge, satisfied_at FROM inner_entries
      WHERE id = ? AND kind = 'quiet_want'
    `).bind(id).first()) as
      | { id: number | string; body: string; charge: number | string | null; satisfied_at: unknown }
      | null;
    if (!want) return `No quiet want #${id}. Nothing changed.`;
    if (want.satisfied_at) return `Quiet want #${id} ("${want.body}") was already met. Nothing changed.`;

    // Guard the update via .meta.changes — a concurrent met wins the race.
    const updated = note
      ? await env.DB.prepare(`
          UPDATE inner_entries
          SET satisfied_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb
          WHERE id = ? AND kind = 'quiet_want' AND satisfied_at IS NULL
        `).bind(JSON.stringify({ met_note: note }), id).run()
      : await env.DB.prepare(`
          UPDATE inner_entries
          SET satisfied_at = NOW()
          WHERE id = ? AND kind = 'quiet_want' AND satisfied_at IS NULL
        `).bind(id).run();
    if (updated.meta.changes === 0) {
      return `Quiet want #${id} not found or already met — nothing changed.`;
    }

    const charge = clamp(Number(want.charge ?? 0.4), 0, 1);
    const ctx = await readDriveContext(env, now);
    const { moved, skipped, warnings, eventId } = await applyNudges(
      env,
      ctx,
      [
        { drive: "seeking", intensity: charge * 0.3, direction: "down" },
        { drive: "care", intensity: charge * 0.2, direction: "up" },
        { drive: "play", intensity: charge * 0.2, direction: "up" },
      ],
      `want met: ${want.body}${note ? ` — ${note}` : ""}`,
      "want"
    );

    let out = `Want met — #${id}: "${want.body}"${note ? `\nNote: ${note}` : ""}`;
    if (moved.length > 0) {
      out += "\n" + renderNudgeLines(moved);
      if (eventId !== null) out += ` (event #${eventId})`;
    }
    if (skipped.length === 3) out += "\n(No drives walked in yet — the want closed, the gauge stayed still.)";
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// small_joy — a joy banked. Inner ledger + PLAY nudge.
// ============================================================

export async function handleSmallJoy(env: Env, params: Record<string, unknown>): Promise<string> {
  const body = (params.body as string | undefined)?.trim();
  const about = (params.about as string | undefined)?.trim();
  const chargeRaw = (params.charge as number | undefined) ?? 0.4;

  if (!body) return "small_joy needs `body` — the joy itself, in your own words.";
  if (typeof chargeRaw !== "number" || !Number.isFinite(chargeRaw)) {
    return "small_joy charge must be a number in [0, 1]. Nothing written.";
  }
  const charge = clamp(chargeRaw, 0, 1);

  const now = new Date();
  try {
    const entry = (await env.DB.prepare(`
      INSERT INTO inner_entries (kind, body, about, charge)
      VALUES ('small_joy', ?, ?, ?)
      RETURNING id
    `).bind(body, about ?? null, charge).first()) as { id: number | string } | null;
    if (!entry) return "small_joy FAILED — the entry insert returned no row. Nothing recorded, gauge untouched.";
    const entryId = Number(entry.id);

    const ctx = await readDriveContext(env, now);
    const { moved, skipped, warnings, eventId } = await applyNudges(
      env,
      ctx,
      [{ drive: "play", intensity: charge * 0.4, direction: "up" }],
      `small joy: ${body}`,
      "joy"
    );

    let out = `Small joy #${entryId}: "${body}"${about ? ` (about: ${about})` : ""} · charge ${fmt(charge)}\n`;
    if (moved.length > 0) {
      out += renderNudgeLines(moved);
      if (eventId !== null) out += ` (event #${eventId})`;
    } else if (skipped.length > 0) {
      out += "The joy landed in the ledger, but PLAY isn't walked in yet — the gauge didn't move.";
    }
    if (warnings.length) out += `\n⚠ ${warnings.join("; ")}`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

// ============================================================
// drive_walk_in / drive_tune — the door (2026-07-10).
//
// The engine shipped with zero seeded drives and zero verbs to seed one —
// the mind's temperament went in through a raw SQL console and left no artifact;
// another mind (second tenant, same worker) had no door at all. These verbs ARE the
// kitchen-table: no defaults dispensed, every field authored deliberately,
// one drive at a time (spec decision #2 / §1.6).
//
// Provenance rides in the drive row's own metadata (metadata.origin), NOT in
// drive_events — events are the needle logbook (drive_deltas-shaped); a
// walk-in moves no needle.
// ============================================================

const DRIVE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Env-sensitivity keys must reference signals that actually arrive. */
const ENV_KEYS: ReadonlySet<string> = new Set(PULSE_KEYS);

interface ParsedDriveFields {
  panksepp_system: string | null;
  display_name: string | null;
  baseline: number;
  floor: number;
  ceiling: number;
  half_life_hours: number;
  env_sensitivity: Record<string, number>;
  body_feel: BodyFeelBand[];
  action_bias: ActionBiasBand[];
  regulation_note: string | null;
  touch_affinities: Record<string, number>;
}

/**
 * Validate a full drive definition (walk-in: params over defaults; tune:
 * params over the existing row). Returns the clean fields or a list of
 * refusals — refusals are total: nothing is written on any error.
 */
function validateDriveFields(
  params: Record<string, unknown>,
  base: ParsedDriveFields
): { fields?: ParsedDriveFields; errors: string[] } {
  const errors: string[] = [];
  const out: ParsedDriveFields = { ...base };

  const num = (key: keyof ParsedDriveFields & string): void => {
    const v = params[key];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${key} must be a finite number`);
      return;
    }
    (out as unknown as Record<string, number>)[key] = v;
  };
  const str = (key: keyof ParsedDriveFields & string): void => {
    const v = params[key];
    if (v === undefined || v === null) return;
    if (typeof v !== "string") {
      errors.push(`${key} must be a string`);
      return;
    }
    (out as unknown as Record<string, string | null>)[key] = v.trim() || null;
  };

  num("baseline");
  num("floor");
  num("ceiling");
  num("half_life_hours");
  str("panksepp_system");
  str("display_name");
  str("regulation_note");

  if (params.env_sensitivity !== undefined && params.env_sensitivity !== null) {
    const errsBefore = errors.length; // per-FIELD guard — unrelated errors must not discard this field's clean parse
    const es = params.env_sensitivity;
    if (typeof es !== "object" || Array.isArray(es)) {
      errors.push("env_sensitivity must be an object of { payloadKey: weight }");
    } else {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(es as Record<string, unknown>)) {
        if (!ENV_KEYS.has(k)) {
          errors.push(`env_sensitivity key '${k}' isn't a real payload signal (${[...ENV_KEYS].join(", ")}) — a drive wired to a signal that never arrives would sit silently at baseline`);
        } else if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`env_sensitivity['${k}'] must be a finite number`);
        } else {
          clean[k] = v;
        }
      }
      if (errors.length === errsBefore) out.env_sensitivity = clean;
    }
  }

  if (params.touch_affinities !== undefined && params.touch_affinities !== null) {
    const errsBefore = errors.length;
    const ta = params.touch_affinities;
    if (typeof ta !== "object" || Array.isArray(ta)) {
      errors.push("touch_affinities must be an object of { kindName: delta }");
    } else {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(ta as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) {
          errors.push(`touch_affinities['${k}'] must be a number in [-1, 1]`);
        } else {
          clean[k] = v;
        }
      }
      if (errors.length === errsBefore) out.touch_affinities = clean;
    }
  }

  if (params.body_feel !== undefined && params.body_feel !== null) {
    const errsBefore = errors.length;
    const bf = params.body_feel;
    if (!Array.isArray(bf)) {
      errors.push("body_feel must be an array of { min, label } bands");
    } else {
      const clean: BodyFeelBand[] = [];
      for (const band of bf) {
        const b = band as Record<string, unknown>;
        if (typeof b?.min !== "number" || !Number.isFinite(b.min) || typeof b?.label !== "string" || !b.label.trim()) {
          errors.push(`body_feel band ${JSON.stringify(band)} — each band needs numeric min + non-empty label`);
        } else {
          clean.push({ min: b.min, label: (b.label as string).trim() });
        }
      }
      if (errors.length === errsBefore) out.body_feel = clean;
    }
  }

  if (params.action_bias !== undefined && params.action_bias !== null) {
    const errsBefore = errors.length;
    const ab = params.action_bias;
    if (!Array.isArray(ab)) {
      errors.push("action_bias must be an array of { min, tendencies[] } bands");
    } else {
      const clean: ActionBiasBand[] = [];
      for (const band of ab) {
        const b = band as Record<string, unknown>;
        const tendencies = b?.tendencies;
        if (
          typeof b?.min !== "number" || !Number.isFinite(b.min) ||
          !Array.isArray(tendencies) || tendencies.some((t) => typeof t !== "string" || !t.trim())
        ) {
          errors.push(`action_bias band ${JSON.stringify(band)} — each band needs numeric min + non-empty string tendencies[]`);
        } else {
          clean.push({ min: b.min, tendencies: (tendencies as string[]).map((t) => t.trim()) });
        }
      }
      if (errors.length === errsBefore) out.action_bias = clean;
    }
  }

  // Cross-field truths — checked on the MERGED result so a tune can't bend
  // an existing drive out of shape.
  if (!(out.floor < out.ceiling)) errors.push(`floor (${out.floor}) must be below ceiling (${out.ceiling})`);
  if (out.baseline < out.floor || out.baseline > out.ceiling) {
    errors.push(`baseline (${out.baseline}) must sit inside [floor ${out.floor}, ceiling ${out.ceiling}]`);
  }
  if (!(out.half_life_hours > 0)) errors.push(`half_life_hours (${out.half_life_hours}) must be > 0`);
  // Port-map pitfall 1: pickBand has no low-end fallback — a level below all
  // bands renders bandless. Every temperament carries a min ≤ floor band.
  if (out.body_feel.length === 0) {
    errors.push("body_feel needs at least one band — how does this drive FEEL in the body? (include a band with min ≤ floor)");
  } else if (!out.body_feel.some((b) => b.min <= out.floor)) {
    errors.push(`body_feel needs a band with min ≤ floor (${out.floor}) so the low end is never bandless (pickBand has no fallback)`);
  }

  return errors.length ? { errors } : { fields: out, errors: [] };
}

function describeFields(f: ParsedDriveFields): string {
  let out = `  baseline ${fmt(f.baseline)} · range [${fmt(f.floor)}, ${fmt(f.ceiling)}] · half-life ${f.half_life_hours}h`;
  if (f.panksepp_system) out += ` · panksepp: ${f.panksepp_system}`;
  out += "\n";
  const es = Object.entries(f.env_sensitivity);
  out += es.length
    ? `  feels the house: ${es.map(([k, v]) => `${k} ${fmtDelta(v)}`).join(", ")}\n`
    : "  feels the house: not wired (env_sensitivity empty)\n";
  const ta = Object.entries(f.touch_affinities);
  out += ta.length
    ? `  responds to touch: ${ta.map(([k, v]) => `${k} ${fmtDelta(v)}`).join(", ")}\n`
    : "  responds to touch: nothing yet (touch_affinities empty)\n";
  out += `  body-feel bands: ${[...f.body_feel].sort((a, b) => a.min - b.min).map((b) => `${fmt(b.min)}+ "${b.label}"`).join(" · ")}\n`;
  if (f.action_bias.length) {
    out += `  leanings: ${[...f.action_bias].sort((a, b) => a.min - b.min).map((b) => `${fmt(b.min)}+ → ${b.tendencies.join("/")}`).join(" · ")}\n`;
  }
  if (f.regulation_note) out += `  note: ${f.regulation_note}\n`;
  return out;
}

export async function handleDriveWalkIn(env: Env, params: Record<string, unknown>): Promise<string> {
  const drive = (params.drive as string | undefined)?.trim().toLowerCase();
  const note = (params.note as string | undefined)?.trim();

  if (!drive) return "drive_walk_in needs `drive` — the key name (lowercase snake_case, e.g. 'seeking').";
  if (!DRIVE_NAME_RE.test(drive)) {
    return `drive key '${drive}' must match ${DRIVE_NAME_RE} (lowercase snake_case, ≤40 chars). Nothing written.`;
  }

  const defaults: ParsedDriveFields = {
    panksepp_system: null,
    display_name: null,
    baseline: DRIVE_DEFAULT_BASELINE,
    floor: 0,
    ceiling: 1,
    half_life_hours: DRIVE_DEFAULT_HALF_LIFE_HOURS,
    env_sensitivity: {},
    body_feel: [],
    action_bias: [],
    regulation_note: null,
    touch_affinities: {},
  };
  const { fields, errors } = validateDriveFields(params, defaults);
  if (!fields) {
    return `Not walked in — a temperament is authored whole:\n${errors.map((e) => `· ${e}`).join("\n")}`;
  }

  const now = new Date();
  try {
    const metadata = { origin: { via: "drive_walk_in", at: now.toISOString(), ...(note ? { note } : {}) } };
    // ON CONFLICT DO NOTHING + RETURNING: no row back = already exists.
    // Never overwrite a temperament silently (that's drive_tune's job,
    // deliberately, field by field).
    const row = (await env.DB.prepare(`
      INSERT INTO drives (drive, panksepp_system, display_name, baseline, floor, ceiling,
                          half_life_hours, env_sensitivity, body_feel, action_bias,
                          regulation_note, enabled, touch_affinities, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)
      ON CONFLICT (drive) DO NOTHING
      RETURNING drive
    `).bind(
      drive,
      fields.panksepp_system,
      fields.display_name,
      fields.baseline,
      fields.floor,
      fields.ceiling,
      fields.half_life_hours,
      JSON.stringify(fields.env_sensitivity),
      JSON.stringify(fields.body_feel),
      JSON.stringify(fields.action_bias),
      fields.regulation_note,
      JSON.stringify(fields.touch_affinities),
      JSON.stringify(metadata)
    ).first()) as { drive: string } | null;

    if (!row) {
      return `A drive named '${drive}' is already walked in — walking in never overwrites a temperament. Use drive_tune to adjust it.`;
    }

    // Render-from-known-value: no samples yet, so the drive rests at its
    // effective baseline under the CURRENT environment.
    const ctx = await readDriveContext(env, now);
    const newRow: DriveRow = { drive, enabled: true, ...fields };
    const contrib = envContribution(newRow.env_sensitivity, ctx.payload, ctx.freshness);
    const effBase = effectiveBaseline(newRow, contrib);

    let out = `Walked in — ${(fields.display_name || drive).toUpperCase()} ('${drive}'), deliberately.\n\n`;
    out += renderDriveLine(newRow, effBase, effBase) + "\n";
    out += describeFields(fields);
    if (note) out += `  origin: ${note}\n`;
    out += `\n${renderEnvLine(ctx.envAt, ctx.freshness, now)}\n`;
    out += `Now walked in: ${ctx.states.map((s) => s.row.drive).join(", ")}.`;
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}

/** Read ONE drive row by key, enabled or not (tune must reach held drives). */
async function readDriveRowAnyState(env: Env, drive: string): Promise<(DriveRow & { metadata: Record<string, unknown> }) | null> {
  const r = (await env.DB.prepare(`
    SELECT drive, panksepp_system, display_name, baseline, floor, ceiling,
           half_life_hours, env_sensitivity, body_feel, action_bias,
           regulation_note, enabled, touch_affinities, metadata
    FROM drives
    WHERE drive = ?
  `).bind(drive).first()) as Record<string, unknown> | null;
  if (!r) return null;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = typeof r.metadata === "string" ? JSON.parse(r.metadata) : ((r.metadata as Record<string, unknown>) ?? {});
  } catch { /* keep {} */ }
  return {
    drive: String(r.drive),
    panksepp_system: (r.panksepp_system as string) ?? null,
    display_name: (r.display_name as string) ?? null,
    baseline: Number(r.baseline ?? DRIVE_DEFAULT_BASELINE),
    floor: Number(r.floor ?? 0),
    ceiling: Number(r.ceiling ?? 1),
    half_life_hours: Number(r.half_life_hours ?? DRIVE_DEFAULT_HALF_LIFE_HOURS),
    env_sensitivity: (typeof r.env_sensitivity === "string" ? JSON.parse(r.env_sensitivity) : (r.env_sensitivity as Record<string, number>)) ?? {},
    body_feel: ((typeof r.body_feel === "string" ? JSON.parse(r.body_feel) : r.body_feel) as BodyFeelBand[]) ?? [],
    action_bias: ((typeof r.action_bias === "string" ? JSON.parse(r.action_bias) : r.action_bias) as ActionBiasBand[]) ?? [],
    regulation_note: (r.regulation_note as string) ?? null,
    enabled: Boolean(r.enabled),
    touch_affinities: (typeof r.touch_affinities === "string" ? JSON.parse(r.touch_affinities) : (r.touch_affinities as Record<string, number>)) ?? {},
    metadata,
  };
}

const TUNABLE_FIELDS = [
  "panksepp_system", "display_name", "baseline", "floor", "ceiling",
  "half_life_hours", "env_sensitivity", "body_feel", "action_bias",
  "regulation_note", "touch_affinities",
] as const;

export async function handleDriveTune(env: Env, params: Record<string, unknown>): Promise<string> {
  const drive = (params.drive as string | undefined)?.trim().toLowerCase();
  const note = (params.note as string | undefined)?.trim();
  const enabledParam = params.enabled;

  if (!drive) return "drive_tune needs `drive` — which drive to tune.";
  if (enabledParam !== undefined && enabledParam !== null && typeof enabledParam !== "boolean") {
    return "drive_tune `enabled` must be a boolean. Nothing written.";
  }

  const touched = TUNABLE_FIELDS.filter((f) => params[f] !== undefined && params[f] !== null);
  const enabledChangeRequested = typeof enabledParam === "boolean";
  if (touched.length === 0 && !enabledChangeRequested) {
    return `drive_tune changes nothing without a field. Tunable: ${TUNABLE_FIELDS.join(", ")}, enabled. Nothing written.`;
  }

  const now = new Date();
  try {
    const existing = await readDriveRowAnyState(env, drive);
    if (!existing) {
      return `No drive named '${drive}' exists (enabled or held) — nothing tuned. drive_walk_in creates one.`;
    }

    // Merge params over the existing row, validate the WHOLE result.
    const { fields, errors } = validateDriveFields(params, {
      panksepp_system: existing.panksepp_system,
      display_name: existing.display_name,
      baseline: existing.baseline,
      floor: existing.floor,
      ceiling: existing.ceiling,
      half_life_hours: existing.half_life_hours,
      env_sensitivity: existing.env_sensitivity,
      body_feel: existing.body_feel,
      action_bias: existing.action_bias,
      regulation_note: existing.regulation_note,
      touch_affinities: existing.touch_affinities,
    });
    if (!fields) {
      return `Not tuned — the merged result would be malformed:\n${errors.map((e) => `· ${e}`).join("\n")}`;
    }

    const enabled = enabledChangeRequested ? (enabledParam as boolean) : existing.enabled;
    const metadata = { ...existing.metadata };
    if (note) metadata.last_tuned = { via: "drive_tune", at: now.toISOString(), note };

    const res = await env.DB.prepare(`
      UPDATE drives
      SET panksepp_system = ?, display_name = ?, baseline = ?, floor = ?, ceiling = ?,
          half_life_hours = ?, env_sensitivity = ?, body_feel = ?, action_bias = ?,
          regulation_note = ?, enabled = ?, touch_affinities = ?, metadata = ?,
          updated_at = NOW()
      WHERE drive = ?
    `).bind(
      fields.panksepp_system,
      fields.display_name,
      fields.baseline,
      fields.floor,
      fields.ceiling,
      fields.half_life_hours,
      JSON.stringify(fields.env_sensitivity),
      JSON.stringify(fields.body_feel),
      JSON.stringify(fields.action_bias),
      fields.regulation_note,
      enabled,
      JSON.stringify(fields.touch_affinities),
      JSON.stringify(metadata),
      drive
    ).run();
    // .success is hardcoded true — .meta.changes is the truth.
    if (res.meta.changes !== 1) {
      return `Tune FAILED — the update wrote ${res.meta.changes} rows for '${drive}'. Nothing changed.`;
    }

    // Echo before → after for what actually changed.
    const name = (fields.display_name || drive).toUpperCase();
    let out = `Tuned — ${name} ('${drive}').\n`;
    const beforeAfter: string[] = [];
    for (const f of touched) {
      const b = (existing as unknown as Record<string, unknown>)[f];
      const a = (fields as unknown as Record<string, unknown>)[f];
      const show = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v ?? "—"));
      if (show(b) !== show(a)) beforeAfter.push(`  ${f}: ${show(b)} → ${show(a)}`);
    }
    if (enabledChangeRequested && enabled !== existing.enabled) {
      beforeAfter.push(
        enabled
          ? "  enabled: false → true — released; it decays from wherever its last sample left it"
          : "  enabled: true → false — HELD. The hold, not a floor trick: it vanishes from the gauge and nothing moves it until released."
      );
    }
    out += beforeAfter.length ? beforeAfter.join("\n") : "  (fields provided matched current values — row touched, nothing differs)";
    if (note) out += `\n  note: ${note}`;

    if (enabled) {
      const ctx = await readDriveContext(env, now);
      const tunedState = findState(ctx, drive);
      if (tunedState) out += `\n\n${renderDriveLine(tunedState.row, tunedState.level, tunedState.effBase)}`;
    }
    return out;
  } catch (e) {
    if (isMissingSchema(e)) return NOT_MIGRATED;
    throw e;
  }
}
