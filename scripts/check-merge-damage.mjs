#!/usr/bin/env node
// check-merge-damage — READ-ONLY check for what an entity merge before 4.1.2
// can have left behind (see docs/merge-damage-check.md).
//
// It opens one READ ONLY transaction, runs SELECTs, rolls back, and prints
// counts and row ids. It never writes, and it never prints memory content.
//
//   PG_URL=postgres://... npm run check:merge-damage            # human report
//   PG_URL=postgres://... npm run check:merge-damage -- --json  # machine report
//
// Exit codes: 0 nothing found, 1 findings (read docs/merge-damage-check.md
// before changing anything), 2 the check could not run.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const ID_LIMIT = 50;

/** Each check: a code, what it means, and a query returning one `ref` per finding. */
export const CHECKS = [
  {
    code: 'MD-1',
    title: 'Observation vectors whose memory no longer exists',
    means: 'Vector search can surface a memory that was deleted. CAUTION: if a merge of an entity into itself deleted memories, these vectors (their `content` column) may be the only remaining copy of them. `npm run repair:merge-vectors` moves them to embeddings_recovered instead of deleting them; do not delete them any other way.',
    sql: `SELECT e.id AS ref FROM embeddings e
           WHERE e.source_type = 'observation'
             AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id)
           ORDER BY e.id`,
  },
  {
    code: 'MD-2',
    title: 'Memories with more than one vector',
    means: 'Search can return the memory twice, and one of the vectors may hold text from before an edit.',
    sql: `SELECT 'observation ' || e.source_id AS ref FROM embeddings e
           JOIN observations o ON o.id = e.source_id
           WHERE e.source_type = 'observation'
           GROUP BY e.source_id HAVING count(*) > 1
           ORDER BY e.source_id`,
  },
  {
    code: 'MD-3',
    title: 'Vectors filed under the wrong entity (key or metadata name)',
    means: 'Search shows the old entity name. On a release before 4.1.2, deleting such a memory leaves its vector behind (MD-1) and editing it creates a second vector (MD-2).',
    sql: `SELECT e.id AS ref FROM embeddings e
           JOIN observations o ON o.id = e.source_id
           JOIN entities x ON x.id = o.entity_id
           WHERE e.source_type = 'observation'
             AND (e.id <> 'obs-' || o.entity_id || '-' || o.id
                  OR e.metadata->>'entity' IS DISTINCT FROM x.name)
           ORDER BY e.id`,
  },
  {
    code: 'MD-4',
    title: 'Entity vectors whose entity no longer exists',
    means: 'Entity search can surface an entity that was merged away or deleted.',
    sql: `SELECT e.id AS ref FROM embeddings e
           WHERE e.source_type = 'entity'
             AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.source_id)
           ORDER BY e.id`,
  },
  {
    code: 'MD-5',
    title: 'Memories whose person/node link points at a deleted entity',
    means: 'The memory belongs to the entity in entity_id, but person_id/node_id still name the entity it was merged away from. Readers that use person_id (the bonds view) do not show it.',
    sql: `SELECT 'observation ' || o.id AS ref FROM observations o
           WHERE COALESCE(o.person_id, o.node_id) IS DISTINCT FROM o.entity_id
             AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = COALESCE(o.person_id, o.node_id))
           ORDER BY o.id`,
  },
  {
    code: 'MD-6',
    title: 'Memories whose person/node link points at a different, existing entity',
    means: 'Usually a merge that stopped half-way (it failed when the source entity had a consolidation group): the memories moved, the source entity was not deleted. The owner should decide whether that merge should be finished.',
    sql: `SELECT 'observation ' || o.id AS ref FROM observations o
           WHERE COALESCE(o.person_id, o.node_id) IS DISTINCT FROM o.entity_id
             AND EXISTS (SELECT 1 FROM entities x WHERE x.id = COALESCE(o.person_id, o.node_id))
           ORDER BY o.id`,
  },
  {
    code: 'MD-7',
    title: 'Images no longer attached to any entity',
    means: 'The image survived but its entity was deleted or merged away (entity_id was set to NULL). person_id/node_id still hold the old entity id; the new one cannot be known from the database alone.',
    sql: `SELECT 'image ' || i.id AS ref FROM images i
           WHERE i.entity_id IS NULL AND COALESCE(i.person_id, i.node_id) IS NOT NULL
           ORDER BY i.id`,
  },
  {
    code: 'MD-8',
    title: 'Relations naming an entity that does not exist',
    means: 'Relations are stored by name; one side names no entity.',
    sql: `SELECT 'relation ' || r.id AS ref FROM relations r
           WHERE NOT EXISTS (SELECT 1 FROM entities x WHERE x.name = r.from_entity)
              OR NOT EXISTS (SELECT 1 FROM entities x WHERE x.name = r.to_entity)
           ORDER BY r.id`,
  },
  {
    code: 'MD-9',
    title: 'Image vectors filed under an old entity name',
    means: 'The image is attached to an entity, but its vector\'s metadata still names the entity it had before a merge, so search shows the old name. Only the name is wrong; the vector is fine.',
    sql: `SELECT 'image ' || i.id AS ref FROM images i
            JOIN entities x ON x.id = i.entity_id
            JOIN embeddings e ON e.source_type = 'image' AND e.source_id = i.id
           WHERE e.metadata->>'entity' IS DISTINCT FROM x.name
           ORDER BY i.id`,
  },
  {
    code: 'MD-10',
    title: 'Pending daemon proposals naming an entity that does not exist',
    means: 'The proposal points at a deleted or merged-away entity by id. It lists with an empty name and accepting it fails.',
    sql: `SELECT 'proposal ' || d.id AS ref FROM daemon_proposals d
           WHERE d.status = 'pending'
             AND ((d.from_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = d.from_entity_id))
               OR (d.to_entity_id   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = d.to_entity_id)))
           ORDER BY d.id`,
  },
];

export const NOT_DETECTABLE = [
  'Thread links to a merged-away entity were deleted by the database (ON DELETE CASCADE). Nothing in the database records them any more; restore from a backup taken before the merge if they matter.',
  'Memories deleted by merging an entity into itself are gone from `observations`. Their vectors (MD-1) and any backup are the only traces.',
];

export async function runChecks(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const results = [];
    for (const check of CHECKS) {
      try {
        const { rows } = await client.query(check.sql);
        results.push({ code: check.code, title: check.title, means: check.means, count: rows.length, refs: rows.slice(0, ID_LIMIT).map((r) => r.ref) });
      } catch (error) {
        // A missing table on an unusual schema is reported, not fatal; the
        // failed statement aborts the transaction, so start a fresh one.
        results.push({ code: check.code, title: check.title, error: error.message });
        await client.query('ROLLBACK');
        await client.query('BEGIN TRANSACTION READ ONLY');
      }
    }
    return results;
  } finally {
    await client.query('ROLLBACK');
  }
}

function printHuman(results) {
  console.log('Resonant Mind merge damage check (read-only; nothing was changed)\n');
  for (const r of results) {
    if (r.error) { console.log(`${r.code}  could not run: ${r.error}\n`); continue; }
    console.log(`${r.code}  ${r.count === 0 ? 'ok  ' : 'FOUND'}  ${r.title}: ${r.count}`);
    if (r.count > 0) {
      console.log(`      ${r.means}`);
      console.log(`      ${r.refs.join(', ')}${r.count > r.refs.length ? `, … (${r.count - r.refs.length} more)` : ''}`);
    }
    console.log('');
  }
  console.log('Not detectable from the database:');
  for (const line of NOT_DETECTABLE) console.log(`  - ${line}`);
  const found = results.some((r) => r.count > 0);
  console.log(found
    ? '\nFindings above. Do not change anything yet: take a backup, show this report to the owner, and read docs/merge-damage-check.md. Every repair is the owner\'s decision. MD-1 to MD-4 are cleared without destroying anything by `npm run repair:merge-vectors` (a dry run unless given --apply).'
    : '\nNothing found by these checks.');
}

async function main() {
  const connectionString = process.env.PG_URL || process.env.DATABASE_URL;
  if (!connectionString) { console.error('PG_URL or DATABASE_URL is required'); process.exitCode = 2; return; }
  // Same TLS rules as db:migrate (verify by default, PG_SSL_NO_VERIFY=1 to skip
  // verification); `sslmode=disable` in the URL is honoured for a local database.
  const ssl = /[?&]sslmode=disable\b/.test(connectionString) ? false
    : process.env.PG_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const client = new pg.Client({ connectionString, ssl });
  try {
    await client.connect();
    const results = await runChecks(client);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ read_only: true, results, not_detectable: NOT_DETECTABLE }, null, 2));
    else printHuman(results);
    process.exitCode = results.some((r) => r.error) ? 2 : results.some((r) => r.count > 0) ? 1 : 0;
  } catch (error) {
    console.error(`check could not run: ${error?.message ?? error}`);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
