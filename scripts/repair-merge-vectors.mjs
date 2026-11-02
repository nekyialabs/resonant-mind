#!/usr/bin/env node
// repair-merge-vectors — clears the vector findings of check:merge-damage
// (MD-1 to MD-4) without destroying anything.
//
// Every vector it removes is moved, in the same statement that removes it,
// into `embeddings_recovered`: its id, source, text (`content`), metadata,
// the vector itself and the reason. Nothing is deleted outright, so a vector
// that turns out to be the last copy of a memory (a memory deleted by a merge
// of an entity into itself) can still be read and restored. Resonant Mind
// never reads `embeddings_recovered`; it is only a place to keep them.
//
//   PG_URL=postgres://... npm run repair:merge-vectors            # dry run: changes nothing
//   PG_URL=postgres://... npm run repair:merge-vectors -- --apply  # does it
//   add --json for a machine-readable report
//
// One transaction, with writes to `embeddings` blocked for its few moments
// (reads continue). Before it commits it re-counts: every removed vector must
// be in `embeddings_recovered`, no memory may have changed, and MD-1 to MD-4
// must be clear; otherwise it rolls back and changes nothing. It never prints
// memory content. Exit codes: 0 done (or dry run), 2 refused or failed.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { CHECKS } from './check-merge-damage.mjs';

const VECTOR_CHECKS = ['MD-1', 'MD-2', 'MD-3', 'MD-4'];

// Kept outside the migration set on purpose: a new migration would change the
// migration-set hash that in-flight v3.2 -> v4 migrations are bound to. The
// vector column has no fixed dimension, so any embedding model's vectors fit.
export const RECOVERED_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS embeddings_recovered (
  recovered_id  BIGSERIAL PRIMARY KEY,
  id            TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  source_id     INTEGER NOT NULL,
  embedding     vector,
  content       TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ,
  reason        TEXT NOT NULL,
  recovered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE embeddings_recovered IS
  'Vectors moved out of embeddings by repair-merge-vectors (reason MD-1/MD-2/MD-4). Kept so that removing them destroys nothing. Not read by Resonant Mind; see docs/merge-damage-check.md.'`;

const MOVE = (reason, where) => `
WITH moved AS (
  DELETE FROM embeddings e WHERE ${where}
  RETURNING e.id, e.source_type, e.source_id, e.embedding, e.content, e.metadata, e.created_at
)
INSERT INTO embeddings_recovered (id, source_type, source_id, embedding, content, metadata, created_at, reason)
SELECT id, source_type, source_id, embedding, content, metadata, created_at, '${reason}' FROM moved`;

/** In order: MD-2 must run before MD-3 (re-keying two vectors of one memory to the same id would collide). */
export const STEPS = [
  {
    code: 'MD-1', action: 'moved to embeddings_recovered',
    sql: MOVE('MD-1', `e.source_type = 'observation'
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id)`),
  },
  {
    code: 'MD-2', action: 'moved to embeddings_recovered (the vector kept is the one at the memory\'s current key, else the newest)',
    sql: MOVE('MD-2', `e.source_type = 'observation'
      AND EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id)
      AND e.id <> (
        SELECT k.id FROM embeddings k JOIN observations o ON o.id = k.source_id
         WHERE k.source_type = 'observation' AND k.source_id = e.source_id
         ORDER BY (k.id = 'obs-' || o.entity_id || '-' || o.id) DESC, k.created_at DESC NULLS LAST, k.id DESC
         LIMIT 1)`),
  },
  {
    code: 'MD-3', action: 're-filed under the memory\'s current entity (vector values unchanged)',
    sql: `
UPDATE embeddings e
   SET id = 'obs-' || o.entity_id || '-' || o.id,
       metadata = jsonb_set(COALESCE(e.metadata, '{}'::jsonb), '{entity}', to_jsonb(x.name))
  FROM observations o JOIN entities x ON x.id = o.entity_id
 WHERE e.source_type = 'observation' AND e.source_id = o.id
   AND (e.id <> 'obs-' || o.entity_id || '-' || o.id OR e.metadata->>'entity' IS DISTINCT FROM x.name)`,
  },
  {
    code: 'MD-4', action: 'moved to embeddings_recovered',
    sql: MOVE('MD-4', `e.source_type = 'entity'
      AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.source_id)`),
  },
];

const one = async (client, sql) => (await client.query(sql)).rows[0];
const fingerprint = (client) => one(client, `
  SELECT (SELECT count(*) FROM embeddings)::int AS embeddings,
         (SELECT count(*) FROM embeddings_recovered)::int AS recovered,
         (SELECT count(*) FROM observations)::int AS observations,
         (SELECT md5(COALESCE(string_agg(id || ':' || md5(COALESCE(content, '')), ',' ORDER BY id), '')) FROM observations) AS memories`);

/**
 * Runs the repair on a connected client. Dry run unless apply is true.
 * Returns a report; throws only on connection-level failures.
 */
export async function repairMergeVectors(client, { apply = false } = {}) {
  const report = { apply, committed: false, steps: [], refused: null };
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    await client.query(RECOVERED_TABLE_SQL);
    await client.query('LOCK TABLE embeddings IN EXCLUSIVE MODE'); // blocks writes, not reads
    const before = await fingerprint(client);

    let removed = 0;
    for (const step of STEPS) {
      const { rowCount } = await client.query(step.sql);
      if (step.code !== 'MD-3') removed += rowCount;
      report.steps.push({ code: step.code, rows: rowCount, action: step.action });
    }

    const after = await fingerprint(client);
    const findings = (await runChecksInPlace(client)).filter((r) => VECTOR_CHECKS.includes(r.code));
    const problems = [];
    if (after.embeddings !== before.embeddings - removed) problems.push('embeddings count does not match the vectors removed');
    if (after.recovered !== before.recovered + removed) problems.push('not every removed vector is in embeddings_recovered');
    if (after.observations !== before.observations || after.memories !== before.memories) problems.push('memories changed');
    for (const f of findings) if (f.count !== 0) problems.push(`${f.code} still has ${f.count} findings`);
    report.verified = { removed, kept_in_recovered: after.recovered - before.recovered, memories_unchanged: after.memories === before.memories, remaining: Object.fromEntries(findings.map((f) => [f.code, f.count])) };

    if (problems.length) {
      report.refused = problems;
      await client.query('ROLLBACK');
    } else if (apply) {
      await client.query('COMMIT');
      report.committed = true;
    } else {
      await client.query('ROLLBACK');
    }
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    report.refused = [error.message];
    return report;
  }
}

// runChecks opens its own READ ONLY transaction; inside ours, run the same
// queries directly so the check sees the uncommitted repair.
async function runChecksInPlace(client) {
  const out = [];
  for (const check of CHECKS) {
    if (!VECTOR_CHECKS.includes(check.code)) continue;
    out.push({ code: check.code, count: (await client.query(check.sql)).rowCount });
  }
  return out;
}

function printHuman(report) {
  console.log(`Resonant Mind merge vector repair — ${report.apply ? 'APPLY' : 'dry run (nothing will be changed; add --apply to do it)'}\n`);
  for (const s of report.steps) console.log(`${s.code}  ${String(s.rows).padStart(6)}  ${s.action}`);
  if (report.verified) {
    console.log(`\nVerified before ${report.apply ? 'commit' : 'rollback'}: ${report.verified.removed} vectors removed, ${report.verified.kept_in_recovered} kept in embeddings_recovered, memories unchanged: ${report.verified.memories_unchanged}.`);
  }
  if (report.refused) {
    console.log(`\nREFUSED, rolled back, nothing changed:\n  - ${report.refused.join('\n  - ')}`);
  } else if (report.committed) {
    console.log('\nCommitted. The removed vectors (with their text) are in embeddings_recovered; see docs/merge-damage-check.md to read or restore them.');
  } else {
    console.log('\nDry run rolled back; nothing was changed.');
  }
}

async function main() {
  const connectionString = process.env.PG_URL || process.env.DATABASE_URL;
  if (!connectionString) { console.error('PG_URL or DATABASE_URL is required'); process.exitCode = 2; return; }
  const ssl = /[?&]sslmode=disable\b/.test(connectionString) ? false
    : process.env.PG_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const client = new pg.Client({ connectionString, ssl });
  try {
    await client.connect();
    const report = await repairMergeVectors(client, { apply: process.argv.includes('--apply') });
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    process.exitCode = report.refused ? 2 : 0;
  } catch (error) {
    console.error(`repair could not run: ${error?.message ?? error}`);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
