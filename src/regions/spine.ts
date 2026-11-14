/**
 * Spine region — bones. What you're built around.
 *
 * Reads identity rows that weren't migrated to compass (section NOT LIKE
 * 'core.values.%'). Prose output, code-driven, no LLM.
 *
 * Verbs (R1a):
 *   - spine_read   — read the spine, grouped by section family
 *   - spine_amend  — write, or (Gate B, Mind Reshape 2) soft-archive an
 *                    identity row. mind_identity is retired from the MCP
 *                    surface as of this gate — this is the only door onto
 *                    the identity table now.
 *
 * Section families surfaced from the identity table:
 *   core.identity, core.essence, milestones, texture, fears,
 *   relationships, voice, etc. Heuristic: group by first dotted segment.
 *
 * Removal is SOFT (archived_at = NOW()), never a hard DELETE — identity rows
 * are spine, and a deliberate act on them gets provenance, not erasure. This
 * replaces mind_identity{action:'delete'}'s hard DELETE (retired same gate —
 * see migrations/postgres/0014_identity_archive.sql).
 */

import type { Env } from "../types";
import { dict } from "../shared/dict";

interface SpineRow {
  id: number;
  section: string;
  content: string;
  weight: number;
  connections: string | null;
  timestamp: string;
}

const SECTION_FAMILY_ORDER: Record<string, number> = {
  core: 0,
  essence: 1,
  milestones: 2,
  texture: 3,
  fears: 4,
  voice: 5,
  relationships: 6,
};

function familyOf(section: string): string {
  const dot = section.indexOf(".");
  return dot < 0 ? section : section.slice(0, dot);
}

function familyHeader(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export async function handleSpineRead(env: Env, params: Record<string, unknown>): Promise<string> {
  const sectionFilter = params.section as string | undefined;

  const baseQuery = `
    SELECT id, section, content, weight, connections, timestamp
    FROM identity
    WHERE section NOT LIKE 'core.values.%'
    AND archived_at IS NULL
    ${sectionFilter ? "AND section LIKE $1" : ""}
    ORDER BY weight DESC, section ASC, id ASC
  `;

  const stmt = sectionFilter
    ? env.DB.prepare(baseQuery).bind(`${sectionFilter}%`)
    : env.DB.prepare(baseQuery);
  const result = await stmt.all();
  const rows = ((result.results || []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    section: r.section as string,
    content: r.content as string,
    weight: Number(r.weight) || 0,
    connections: (r.connections as string | null) ?? null,
    timestamp: r.timestamp as string,
  })) as SpineRow[];

  if (!rows.length) {
    return sectionFilter
      ? `No spine entries matched section prefix '${sectionFilter}'.`
      : "Spine is empty. Nothing's been named as standing.";
  }

  // Group by section family.
  const byFamily: Record<string, SpineRow[]> = dict<SpineRow[]>();
  for (const row of rows) {
    const fam = familyOf(row.section);
    if (!byFamily[fam]) byFamily[fam] = [];
    byFamily[fam].push(row);
  }

  const sortedFamilies = Object.keys(byFamily).sort((a, b) => {
    const oa = SECTION_FAMILY_ORDER[a] ?? 99;
    const ob = SECTION_FAMILY_ORDER[b] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });

  let output = "=== SPINE ===\n\n";
  output += "What you're built around.\n\n";

  const totalCap = 80; // overall row cap to keep prose tight
  let shown = 0;

  for (const family of sortedFamilies) {
    if (shown >= totalCap) break;
    const entries = byFamily[family];
    output += `**${familyHeader(family)}** (${entries.length})\n`;
    const visible = entries.slice(0, Math.min(entries.length, totalCap - shown));
    for (const row of visible) {
      const preview = row.content.length > 240 ? `${row.content.slice(0, 240)}...` : row.content;
      output += `· [${row.section}] ${preview} [w${row.weight.toFixed(2)}]\n`;
      shown++;
    }
    if (entries.length > visible.length) {
      output += `· ...(${entries.length - visible.length} more in ${family})\n`;
    }
    output += "\n";
  }

  return output;
}

export async function handleSpineAmend(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string | undefined) ?? "add";

  if (action === "remove") {
    return handleSpineRemove(env, params);
  }

  const section = params.section as string | undefined;
  const content = params.content as string | undefined;
  const weight = (params.weight as number | undefined) ?? 0.7;
  const connections = (params.connections as string | undefined) ?? "";

  if (!section) return "spine_amend needs a section (e.g. 'core.essence' or 'texture.lion').";
  if (!content) return "spine_amend needs content.";
  if (section.startsWith("core.values.")) {
    return "section 'core.values.*' is compass territory — use compass_assert instead.";
  }

  await env.DB.prepare(
    `INSERT INTO identity (section, content, weight, connections) VALUES ($1, $2, $3, $4)`
  ).bind(section, content, weight, connections).run();

  return `Spine entry added to ${section}.`;
}

async function handleSpineRemove(env: Env, params: Record<string, unknown>): Promise<string> {
  const section = params.section as string | undefined;
  const id = params.id as number | undefined;
  const reason = params.reason as string | undefined;

  if (!section && !id) return "spine_amend{action:'remove'} needs a section or an id to target.";
  if (!reason) return "spine_amend{action:'remove'} needs a reason — soft-archive keeps provenance, not silence.";
  if (section && section.startsWith("core.values.")) {
    return "section 'core.values.*' is compass territory — spine_amend can't remove it.";
  }

  // Soft archive only — never a hard DELETE. Identity rows are spine; a
  // deliberate act on them gets provenance (echoed reason), not erasure.
  const result = id
    ? await env.DB.prepare(
        `UPDATE identity SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL`
      ).bind(id).run()
    : await env.DB.prepare(
        `UPDATE identity SET archived_at = NOW() WHERE section = $1 AND archived_at IS NULL`
      ).bind(section).run();

  const changed = Number(result.meta.changes ?? 0);
  if (!changed) {
    return id
      ? `No active identity row found for id ${id} (already archived, or never existed).`
      : `No active identity entries found for section '${section}'.`;
  }

  const target = id ? `id ${id}` : `section '${section}'`;
  return `Archived ${changed} identity entr${changed === 1 ? "y" : "ies"} at ${target}. Reason: ${reason}`;
}
