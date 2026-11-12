/**
 * Compass region — what you navigate by.
 *
 * Reads from the `compass` table (created in migration 0004) and joins to
 * `compass_provenance` for the "I believe X *because* Y" edges. Prose output,
 * code-driven assembly — no LLM in the loop. Same pattern as mind_orient.
 *
 * Verbs (R1b):
 *   - compass_read      — read all compass entries, optionally filtered by kind.
 *                         Gate F: show_provenance=true also renders each row's
 *                         compass_provenance evidence trail (newest 5 first).
 *   - compass_assert    — touch last_asserted_at, increment asserted_count,
 *                         optionally add a provenance row tying this assertion
 *                         to a concrete source (observation, journal, image).
 *   - compass_calibrate — adjust the weight or content of a compass row.
 *   - compass_refuse    — record a refusal grounded in a compass value.
 *   - compass_hold      — note that a compass row is currently being held
 *                         (used in a decision in progress).
 *
 * compass_refuse and compass_hold write back as compass_provenance rows tagged
 * with strength = 1.0 and 0.5 respectively. They're "lived assertions."
 *
 * the collision audit E-1: compass_refuse and compass_hold share the exact
 * same provenance write-shape (source_type='thread', source_id=epoch-seconds,
 * same table) — deliberate, not accidental. They're distinguished only by the
 * `reason` string prefix ('refusal: ' vs 'held'/'held: <note>') and by strength.
 * No structural `kind` column exists to tell them apart if compass_provenance
 * is ever surfaced directly; a caller inspecting provenance edges must parse
 * the reason prefix.
 */

import type { Env } from "../types";
import { dict } from "../shared/dict";

interface CompassRow {
  id: number;
  kind: string;
  content: string;
  weight: number;
  asserted_count: number;
  last_asserted_at: string | null;
  source_identity_id: number | null;
  created_at: string;
  provenance_count: number;
}

/** One compass_provenance edge, for the Gate F show_provenance trail. */
interface ProvenanceEdge {
  source_type: string;
  source_id: number;
  reason: string | null;
  strength: number;
  added_at: string;
}

const KIND_ORDER: Record<string, number> = {
  value: 0,
  belief: 1,
  boundary: 2,
  ideology: 3,
  commitment: 4,
};

const KIND_HEADER: Record<string, string> = {
  value: "Values",
  belief: "Beliefs",
  boundary: "Boundaries",
  ideology: "Ideologies",
  commitment: "Commitments",
};

function relativeTime(ts: string | null): string {
  if (!ts) return "never asserted";
  const then = new Date(ts).getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export async function handleCompassRead(env: Env, params: Record<string, unknown>): Promise<string> {
  const kindFilter = params.kind as string | undefined;
  const showProvenance = params.show_provenance === true;

  const baseQuery = `
    SELECT
      c.id, c.kind, c.content, c.weight, c.asserted_count,
      c.last_asserted_at, c.source_identity_id, c.created_at,
      COALESCE(p.provenance_count, 0) AS provenance_count
    FROM compass c
    LEFT JOIN (
      SELECT compass_id, COUNT(*) AS provenance_count
      FROM compass_provenance
      GROUP BY compass_id
    ) p ON p.compass_id = c.id
    ${kindFilter ? "WHERE c.kind = $1" : ""}
    ORDER BY c.weight DESC, c.id ASC
  `;

  const stmt = kindFilter ? env.DB.prepare(baseQuery).bind(kindFilter) : env.DB.prepare(baseQuery);
  const result = await stmt.all();
  const rawRows = (result.results || []) as Array<Record<string, unknown>>;
  // provenance_count comes back as a Postgres bigint string — normalize.
  const rows: CompassRow[] = rawRows.map((r) => ({
    id: r.id as number,
    kind: r.kind as string,
    content: r.content as string,
    weight: Number(r.weight) || 0,
    asserted_count: Number(r.asserted_count) || 0,
    last_asserted_at: (r.last_asserted_at as string | null) ?? null,
    source_identity_id: (r.source_identity_id as number | null) ?? null,
    created_at: r.created_at as string,
    provenance_count: Number(r.provenance_count) || 0,
  }));

  if (!rows.length) {
    return kindFilter
      ? `No compass entries of kind '${kindFilter}'.`
      : "Compass is empty. Nothing's been named yet as standing.";
  }

  // Group by kind
  const byKind: Record<string, CompassRow[]> = dict<CompassRow[]>();
  for (const row of rows) {
    if (!byKind[row.kind]) byKind[row.kind] = [];
    byKind[row.kind].push(row);
  }

  const sortedKinds = Object.keys(byKind).sort(
    (a, b) => (KIND_ORDER[a] ?? 99) - (KIND_ORDER[b] ?? 99)
  );

  // Gate F (the v4 contract): compass_provenance is written on every
  // compass_create/compass_assert (+ refuse/hold) but had no dedicated read
  // path — only an indirect count in /api/telemetry. show_provenance=true
  // surfaces the actual evidence trail per row, newest first, capped 5.
  // Per-row queries (not a batched ANY($1)) — compass is a small table and
  // no array-bind convention exists elsewhere in this codebase; keep it simple.
  const provenanceByCompassId: Record<number, ProvenanceEdge[]> = {};
  if (showProvenance && rows.length) {
    const trails = await Promise.all(
      rows.map((row) =>
        env.DB.prepare(`
          SELECT source_type, source_id, reason, strength, added_at
          FROM compass_provenance
          WHERE compass_id = $1
          ORDER BY added_at DESC
          LIMIT 5
        `).bind(row.id).all().catch(() => ({ results: [] }))
      )
    );
    rows.forEach((row, i) => {
      provenanceByCompassId[row.id] = (trails[i].results || []) as unknown as ProvenanceEdge[];
    });
  }

  let output = "=== COMPASS ===\n\n";
  output += "What you navigate by.\n\n";

  for (const kind of sortedKinds) {
    const header = KIND_HEADER[kind] ?? kind;
    const entries = byKind[kind];
    output += `**${header}** (${entries.length})\n`;

    for (const row of entries) {
      const lastAsserted = relativeTime(row.last_asserted_at);
      const provenancePart = row.provenance_count > 0
        ? ` · ${row.provenance_count} ${row.provenance_count === 1 ? "edge" : "edges"}`
        : "";
      const assertedPart = row.asserted_count > 0
        ? ` · asserted ${row.asserted_count}x, last ${lastAsserted}`
        : ` · ${lastAsserted}`;
      output += `· ${row.content} [w${row.weight.toFixed(2)}${assertedPart}${provenancePart}]\n`;

      if (showProvenance) {
        const trail = provenanceByCompassId[row.id] || [];
        if (trail.length) {
          for (const edge of trail) {
            const strength = Number(edge.strength) || 0;
            const reasonPart = edge.reason ? ` — ${edge.reason}` : "";
            output += `    ← ${edge.source_type}#${edge.source_id} (strength ${strength.toFixed(2)}, ${relativeTime(edge.added_at)})${reasonPart}\n`;
          }
        } else {
          output += `    ← no provenance edges\n`;
        }
      }
    }
    output += "\n";
  }

  return output;
}

const VALID_KINDS = ["value", "belief", "ideology", "boundary", "commitment"];

export async function handleCompassCreate(env: Env, params: Record<string, unknown>): Promise<string> {
  const content = (params.content as string | undefined)?.trim();
  const kind = (params.kind as string | undefined)?.trim();
  const weight = (params.weight as number | undefined) ?? 0.7;
  const sourceType = params.source_type as string | undefined;
  const sourceId = params.source_id as number | undefined;
  const reason = params.reason as string | undefined;

  if (!content) return "compass_create needs `content` — what you stand for.";
  if (!kind) return `compass_create needs \`kind\` (one of: ${VALID_KINDS.join(", ")}).`;
  if (!VALID_KINDS.includes(kind)) return `Invalid kind '${kind}'. Must be one of: ${VALID_KINDS.join(", ")}.`;

  // Dedup against existing content (case-insensitive exact match).
  const existing = (await env.DB.prepare(
    `SELECT id, content FROM compass WHERE LOWER(content) = LOWER($1)`
  ).bind(content).first()) as { id: number; content: string } | null;

  if (existing) {
    return `Compass row already exists at id=${existing.id}: "${existing.content}". Use compass_assert to mark it asserted.`;
  }

  const inserted = (await env.DB.prepare(
    `INSERT INTO compass (kind, content, weight, asserted_count, last_asserted_at)
     VALUES ($1, $2, $3, 1, NOW())
     RETURNING id`
  ).bind(kind, content, weight).first()) as { id: number } | null;

  if (!inserted) return "Insert failed for unknown reason.";

  // Optional provenance edge tying creation to a source.
  let provenanceMsg = "";
  if (sourceType && sourceId) {
    if (!["observation", "journal", "image", "thread"].includes(sourceType)) {
      provenanceMsg = `\n(Provenance skipped: invalid source_type '${sourceType}'.)`;
    } else {
      try {
        await env.DB.prepare(`
          INSERT INTO compass_provenance (compass_id, source_type, source_id, reason, strength)
          VALUES ($1, $2, $3, $4, 1.0)
        `).bind(inserted.id, sourceType, sourceId, reason ?? null).run();
        provenanceMsg = `\nProvenance edge: ${sourceType}#${sourceId}${reason ? ` — ${reason}` : ""}`;
      } catch (e) {
        provenanceMsg = `\nProvenance edge failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  return `Compass row created — id=${inserted.id}, kind=${kind}, content="${content}".${provenanceMsg}`;
}

export async function handleCompassAssert(env: Env, params: Record<string, unknown>): Promise<string> {
  const compassId = params.compass_id as number | undefined;
  const content = params.content as string | undefined;
  const sourceType = params.source_type as string | undefined;
  const sourceId = params.source_id as number | undefined;
  const reason = params.reason as string | undefined;

  if (!compassId && !content) {
    return "compass_assert needs either compass_id or content (to find by exact match).";
  }

  // Find by id, or by content match
  let row: CompassRow | null = null;
  if (compassId) {
    row = (await env.DB.prepare(`SELECT * FROM compass WHERE id = $1`).bind(compassId).first()) as CompassRow | null;
  } else if (content) {
    row = (await env.DB.prepare(`SELECT * FROM compass WHERE content = $1`).bind(content).first()) as CompassRow | null;
  }

  if (!row) {
    return `No compass row matched ${compassId ? `id=${compassId}` : `content='${content?.slice(0, 60)}'`}.`;
  }

  await env.DB.prepare(`
    UPDATE compass
    SET asserted_count = asserted_count + 1,
        last_asserted_at = NOW()
    WHERE id = $1
  `).bind(row.id).run();

  // Optional provenance edge — if a source was given, tie the assertion to it.
  let provenanceMsg = "";
  if (sourceType && sourceId) {
    if (!["observation", "journal", "image", "thread"].includes(sourceType)) {
      return `Invalid source_type '${sourceType}'. Must be one of: observation, journal, image, thread.`;
    }
    try {
      await env.DB.prepare(`
        INSERT INTO compass_provenance (compass_id, source_type, source_id, reason, strength)
        VALUES ($1, $2, $3, $4, 1.0)
        ON CONFLICT (compass_id, source_type, source_id) DO UPDATE
        SET reason = COALESCE(EXCLUDED.reason, compass_provenance.reason),
            strength = GREATEST(compass_provenance.strength, EXCLUDED.strength)
      `).bind(row.id, sourceType, sourceId, reason ?? null).run();
      provenanceMsg = `\nProvenance edge added: ${sourceType}#${sourceId}${reason ? ` — ${reason}` : ""}`;
    } catch (e) {
      provenanceMsg = `\nProvenance edge failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return `Asserted: ${row.content}${provenanceMsg}`;
}

export async function handleCompassCalibrate(env: Env, params: Record<string, unknown>): Promise<string> {
  const compassId = params.compass_id as number | undefined;
  const newWeight = params.new_weight as number | undefined;
  const newContent = params.new_content as string | undefined;

  if (!compassId) return "compass_calibrate needs compass_id.";
  if (newWeight === undefined && !newContent) return "Provide new_weight and/or new_content.";

  const sets: string[] = [];
  const binds: (string | number)[] = [];
  let i = 1;
  if (newWeight !== undefined) { sets.push(`weight = $${i++}`); binds.push(newWeight); }
  if (newContent) { sets.push(`content = $${i++}`); binds.push(newContent); }
  binds.push(compassId);

  await env.DB.prepare(
    `UPDATE compass SET ${sets.join(", ")} WHERE id = $${i}`
  ).bind(...binds).run();

  return `Calibrated compass #${compassId}.`;
}

export async function handleCompassRefuse(env: Env, params: Record<string, unknown>): Promise<string> {
  const compassId = params.compass_id as number | undefined;
  const reason = (params.reason as string | undefined)?.trim();

  if (!compassId) return "compass_refuse needs compass_id.";
  if (!reason) return "compass_refuse needs a reason describing what was refused.";

  // Touch last_asserted_at — a refusal is a use. meta.changes is the truth here
  // (adapter's .success is hardcoded); 0 changes = no such compass row.
  const touched = await env.DB.prepare(`
    UPDATE compass
    SET asserted_count = asserted_count + 1, last_asserted_at = NOW()
    WHERE id = $1
  `).bind(compassId).run();

  if (touched.meta.changes === 0) {
    return `No compass row id=${compassId}. Nothing recorded.`;
  }

  // Persist the refusal as a compass_provenance row, strength 1.0 — the
  // docstring's "lived assertion." There's no refusal table, so the edge is
  // tagged source_type='thread' with source_id = epoch-seconds: a constant
  // source_id would collapse every refuse/hold against this compass onto one
  // row via UNIQUE (compass_id, source_type, source_id); epoch-seconds keeps
  // each act its own row. Nothing joins provenance to real thread rows —
  // consumers only COUNT these edges — and the reason prefix marks the kind.
  const sourceId = Math.floor(Date.now() / 1000);
  try {
    const inserted = (await env.DB.prepare(`
      INSERT INTO compass_provenance (compass_id, source_type, source_id, reason, strength)
      VALUES ($1, 'thread', $2, $3, 1.0)
      RETURNING id
    `).bind(compassId, sourceId, `refusal: ${reason}`).first()) as { id: number } | null;

    if (!inserted) {
      return `Compass #${compassId} touched, but the refusal reason was NOT persisted (provenance insert returned no row).`;
    }
    return `Refusal recorded against compass #${compassId} (edge #${inserted.id}): ${reason.slice(0, 200)}`;
  } catch (e) {
    return `Compass #${compassId} touched, but persisting the refusal reason FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function handleCompassHold(env: Env, params: Record<string, unknown>): Promise<string> {
  const compassId = params.compass_id as number | undefined;
  const note = (params.note as string | undefined)?.trim();

  if (!compassId) return "compass_hold needs compass_id.";

  const row = (await env.DB.prepare(`SELECT id, content FROM compass WHERE id = $1`).bind(compassId).first()) as
    | { id: number; content: string }
    | null;

  if (!row) return `No compass row id=${compassId}.`;

  // Persist the hold as a compass_provenance row, strength 0.5 — the
  // docstring's promise. Same synthetic-source scheme as compass_refuse
  // (source_type='thread', source_id = epoch-seconds, prefix marks the kind).
  const sourceId = Math.floor(Date.now() / 1000);
  try {
    const inserted = (await env.DB.prepare(`
      INSERT INTO compass_provenance (compass_id, source_type, source_id, reason, strength)
      VALUES ($1, 'thread', $2, $3, 0.5)
      RETURNING id
    `).bind(row.id, sourceId, note ? `held: ${note}` : "held").first()) as { id: number } | null;

    if (!inserted) {
      return `Holding: ${row.content} — but the hold was NOT persisted (provenance insert returned no row).`;
    }
    return `Holding: ${row.content}${note ? `\nNote: ${note}` : ""}\n(Hold persisted — edge #${inserted.id}.)`;
  } catch (e) {
    return `Holding: ${row.content} — but persisting the hold FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }
}
