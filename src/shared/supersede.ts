/**
 * Supersede helpers shared by mind_write (auto-supersede) and ritual_tend
 * (accepting a "supersede" proposal): the AUTO_SUPERSEDE setting, and the one
 * routine that retires an old observation in favour of a newer one.
 */

import type { Env } from "../types";
import { AUTO_SUPERSEDE_THRESHOLD } from "./constants";

export interface AutoSupersedeSetting {
  /** true when AUTO_SUPERSEDE=off: nothing is retired and no proposals are made. */
  off: boolean;
  /** Similarity at or above which a pair is retired (short facts) or proposed (long ones). */
  threshold: number;
}

const warnedValues = new Set<string>();

/**
 * Read AUTO_SUPERSEDE from the Env. Unset or empty: the default threshold.
 * A number in (0, 1]: that threshold. "off": never. Anything else falls back
 * to the default, with one warning per distinct bad value.
 */
export function resolveAutoSupersede(env: Pick<Env, "AUTO_SUPERSEDE">): AutoSupersedeSetting {
  const fallback: AutoSupersedeSetting = { off: false, threshold: AUTO_SUPERSEDE_THRESHOLD };
  const raw = env.AUTO_SUPERSEDE;
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === "") return fallback;
  if (text === "off") return { off: true, threshold: AUTO_SUPERSEDE_THRESHOLD };
  const n = Number(text);
  if (Number.isFinite(n) && n > 0 && n <= 1) return { off: false, threshold: n };
  if (!warnedValues.has(text)) {
    warnedValues.add(text);
    console.warn(`[mind_write] AUTO_SUPERSEDE='${String(raw).slice(0, 40)}' is not "off" or a number above 0 up to 1 — using the default ${AUTO_SUPERSEDE_THRESHOLD}`);
  }
  return fallback;
}

// Log the genuinely-missing supersede columns case (42703) once per isolate, not per write.
let supersedeColumnsMissingLogged = false;

/**
 * Retire `oldId` in favour of `newId`.
 *
 * No transactions exist (adapter opens a fresh client per statement), so the
 * pair is ordered: retire the old row first (the load-bearing half), then set
 * the back-pointer — and any desync is logged for reconciliation, never swallowed.
 *
 * Returns true when the old row was retired by this call.
 */
export async function retireObservation(env: Env, oldId: number, newId: number): Promise<boolean> {
  let oldApplied = false;
  try {
    const oldRes = await env.DB.prepare(`
      UPDATE observations SET valid_until = NOW(), superseded_by = ? WHERE id = ? AND valid_until IS NULL
    `).bind(newId, oldId).run();
    // Never trust .success (hardcoded true) — trust .meta.changes.
    oldApplied = (oldRes.meta.changes ?? 0) > 0;
    if (oldApplied) {
      const newRes = await env.DB.prepare(`
        UPDATE observations SET supersedes = ? WHERE id = ?
      `).bind(oldId, newId).run();
      if ((newRes.meta.changes ?? 0) === 0) {
        console.error(`[mind_write] supersede pair desync: obs ${oldId} got superseded_by=${newId}, but supersedes back-pointer on obs ${newId} applied 0 changes — reconcile: UPDATE observations SET supersedes=${oldId} WHERE id=${newId}`);
      }
    }
    // oldApplied=false means the old row was already retired (valid_until set)
    // by a concurrent path — nothing to supersede, skip the back-pointer.
    return oldApplied;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "42703") {
      // Genuinely-missing supersede columns on this deployment — tolerate, log once.
      if (!supersedeColumnsMissingLogged) {
        supersedeColumnsMissingLogged = true;
        console.warn(`[mind_write] supersede columns missing (Postgres 42703) — auto-supersede inert on this deployment: ${e}`);
      }
      if (oldApplied) {
        console.error(`[mind_write] supersede pair desync: obs ${oldId} got superseded_by=${newId}, but supersedes column missing for obs ${newId} — reconcile ids (old=${oldId}, new=${newId})`);
      }
      return false;
    }
    if (oldApplied) {
      console.error(`[mind_write] supersede pair desync: obs ${oldId} got superseded_by=${newId}, but back-pointer update failed (${e}) — reconcile ids (old=${oldId}, new=${newId})`);
      return true;
    }
    console.error(`[mind_write] supersede update failed for obs ${oldId} -> ${newId}: ${e}`);
    return false;
  }
}
