/**
 * Daemon-facing HTTP handlers — manual triggers for the cron-scheduled
 * `processSubconscious` and `processDream`.
 */

import type { Env } from "../../types";
import { jsonResponse } from "../response";
import { processSubconscious } from "../../daemon";
import { processDream } from "../../daemon/dream-processing";

export async function handleApiProcess(env: Env): Promise<Response> {
  await processSubconscious(env);
  return jsonResponse({ status: "processed", timestamp: new Date().toISOString() });
}

/**
 * Manual dream trigger. Honest about what happened (review finding):
 * the old handler returned "the most recent dream ever" with status:ok even
 * when the date-gate meant nothing was generated. Now the outcome is explicit,
 * and ?regen=1 deliberately re-dreams tonight (deletes today's row + vector).
 */
export async function handleApiDream(request: Request, env: Env): Promise<Response> {
  try {
    const regen = new URL(request.url).searchParams.get("regen") === "1";
    const outcome = await processDream(env, true, undefined, regen);
    if (!outcome.generated) {
      return jsonResponse({ status: "not-generated", reason: outcome.reason });
    }
    const dream = await env.DB.prepare(
      'SELECT id, dream_date, content, emotional_seed, recurring_dream_id, recurrence_count, composed_by FROM dreams WHERE id = ?'
    ).bind(outcome.dreamId).first();
    return jsonResponse({ status: "generated", regenerated: regen, dream });
  } catch (e) {
    console.error("Dream generation failed", e);
    return jsonResponse({ status: "error", error: "Dream generation failed" }, 500);
  }
}
