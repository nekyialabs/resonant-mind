/**
 * handleMindTension — list / add / sit-with / resolve / delete tensions.
 *
 * Tensions are unresolved pole-pairs (A vs B) the mind holds and visits
 * without forcing resolution. Sitting increments visit count; resolving
 * collapses the poles into something new.
 *
 * Lives in legacy-tools/ pending R3 — post-reshape this is part of the
 * Compass region (holding what doesn't resolve yet).
 */

import type { Env } from "../types";
import { generateId, escapeLike } from "../shared/text";

const SIT_RESOLVE_MIN_PREFIX = 10;
const DELETE_MIN_PREFIX = 20;
const MAX_PREFIX_MATCHES = 20;

type TensionRow = Record<string, unknown>;

/**
 * Resolve a tension from an exact id or a unique id prefix. The prefix is
 * matched literally (LIKE wildcards in the input are escaped), must be at
 * least `minPrefix` characters, and must match exactly one tension.
 */
async function resolveTension(
  env: Env,
  rawId: unknown,
  minPrefix: number,
  columns: string,
): Promise<{ tension: TensionRow } | { error: string }> {
  if (typeof rawId !== "string" || !rawId.trim()) return { error: "tension_id must be a non-empty string" };
  const id = rawId.trim();

  const exact = await env.DB.prepare(`SELECT ${columns} FROM tensions WHERE id = ?`).bind(id).first();
  if (exact) return { tension: exact };

  if (id.length < minPrefix) {
    return { error: `Tension '${id}' not found. A partial id needs at least ${minPrefix} characters; use the full id shown by action='list'.` };
  }

  const matches = await env.DB.prepare(
    `SELECT ${columns} FROM tensions WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT ${MAX_PREFIX_MATCHES + 1}`
  ).bind(`${escapeLike(id)}%`).all();
  const rows = matches.results ?? [];

  if (rows.length === 0) return { error: `Tension '${id}' not found` };
  if (rows.length > 1) {
    const count = rows.length > MAX_PREFIX_MATCHES ? `more than ${MAX_PREFIX_MATCHES}` : String(rows.length);
    return { error: `Tension id prefix '${id}' matches ${count} tensions. Use a longer prefix or the full id.` };
  }
  return { tension: rows[0] };
}

export async function handleMindTension(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;

  try {
    if (action === "list") {
      const tensions = await env.DB.prepare(
        `SELECT id, pole_a, pole_b, context, created_at, visits
         FROM tensions WHERE resolved_at IS NULL
         ORDER BY created_at DESC`
      ).all();

      const resolved = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM tensions WHERE resolved_at IS NOT NULL`
      ).first();

      const output: string[] = [];
      output.push("=".repeat(50));
      output.push("TENSION SPACE");
      output.push("=".repeat(50));

      if (tensions.results?.length) {
        for (const t of tensions.results) {
          const created = new Date(t.created_at as string);
          const now = new Date();
          const days = Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000));

          output.push("");
          output.push(`[${String(t.id)}] (${days}d)`);
          output.push(`   A: ${String(t.pole_a).slice(0, 60)}`);
          output.push(`   B: ${String(t.pole_b).slice(0, 60)}`);
          if (t.context) output.push(`   Why: ${String(t.context).slice(0, 50)}`);
          if (t.visits) output.push(`   Sat with ${t.visits} time(s)`);
        }
      } else {
        output.push("");
        output.push("No active tensions.");
      }

      output.push("");
      output.push(`Resolved: ${(resolved?.count as number) || 0}`);
      output.push("=".repeat(50));

      return output.join("\n");
    }

    if (action === "add") {
      const poleA = params.pole_a as string;
      const poleB = params.pole_b as string;

      if (!poleA || !poleB) {
        return JSON.stringify({ error: "pole_a and pole_b required for action='add'" });
      }

      const tensionId = generateId('tension');
      const tensionContext = params.context as string;

      await env.DB.prepare(
        `INSERT INTO tensions (id, pole_a, pole_b, context, visits, created_at)
         VALUES (?, ?, ?, ?, 0, datetime('now'))`
      ).bind(tensionId, poleA, poleB, tensionContext || null).run();

      return JSON.stringify({
        success: true,
        tension_id: tensionId,
        message: "Tension added. Let it simmer.",
        tension: { pole_a: poleA, pole_b: poleB, context: tensionContext }
      }, null, 2);
    }

    if (action === "sit") {
      const tensionId = params.tension_id as string;

      if (!tensionId) {
        return JSON.stringify({ error: "tension_id required for action='sit'" });
      }

      const found = await resolveTension(env, tensionId, SIT_RESOLVE_MIN_PREFIX, "*");
      if ("error" in found) return JSON.stringify({ error: found.error });
      const tension = found.tension;

      await env.DB.prepare(
        `UPDATE tensions SET visits = visits + 1, last_visited = datetime('now') WHERE id = ?`
      ).bind(tension.id as string).run();

      return JSON.stringify({
        success: true,
        tension_id: tension.id,
        pole_a: tension.pole_a,
        pole_b: tension.pole_b,
        context: tension.context,
        visits: (tension.visits as number) + 1,
        prompt: "Sit with this. What does holding both poles feel like?"
      }, null, 2);
    }

    if (action === "resolve") {
      const tensionId = params.tension_id as string;
      const resolution = params.resolution as string;

      if (!tensionId) {
        return JSON.stringify({ error: "tension_id required for action='resolve'" });
      }

      const found = await resolveTension(env, tensionId, SIT_RESOLVE_MIN_PREFIX, "*");
      if ("error" in found) return JSON.stringify({ error: found.error });
      const tension = found.tension;

      await env.DB.prepare(
        `UPDATE tensions SET resolved_at = datetime('now'), resolution = ? WHERE id = ?`
      ).bind(resolution || null, tension.id as string).run();

      return JSON.stringify({
        success: true,
        tension_id: tension.id,
        resolution,
        message: "Tension resolved. The poles collapsed into something new."
      }, null, 2);
    }

    if (action === "delete") {
      const tensionId = params.tension_id as string;
      if (!tensionId) return JSON.stringify({ error: "tension_id required for action='delete'" });
      const found = await resolveTension(env, tensionId, DELETE_MIN_PREFIX, "id, pole_a, pole_b");
      if ("error" in found) return JSON.stringify({ error: found.error });
      const tension = found.tension;
      await env.DB.prepare(`DELETE FROM tensions WHERE id = ?`).bind(tension.id as string).run();
      return JSON.stringify({ success: true, message: `Deleted tension: ${tension.pole_a} <-> ${tension.pole_b}` });
    }

    return JSON.stringify({ error: `Invalid action '${action}'. Must be: list, add, sit, resolve, delete` });
  } catch (error) {
    console.error("mind_tension failed", error);
    return JSON.stringify({ error: "Internal error" });
  }
}
