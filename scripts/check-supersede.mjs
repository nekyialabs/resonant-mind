#!/usr/bin/env node
// check-supersede — READ-ONLY check of the observations that were retired
// ("superseded") by newer ones, to see whether any were retired when they
// were not really rewrites (see docs/supersede-check.md).
//
// It opens one READ ONLY transaction, runs a SELECT, rolls back, and prints
// ids, lengths, dates and a word-overlap figure per pair. It reads the text of
// each pair only to measure it; it never writes and never prints memory content.
//
//   PG_URL=postgres://... npm run check:supersede            # human report
//   PG_URL=postgres://... npm run check:supersede -- --json  # machine report
//
// Exit codes: 0 nothing superseded, 1 superseded observations found (read
// docs/supersede-check.md before changing anything), 2 the check could not run.
import pg from 'pg';
import { pathToFileURL } from 'node:url';

// Same figure as AUTO_SUPERSEDE_MAX_CHARS in src/shared/constants.ts: since 4.2.0
// only pairs where both sides are this short are retired automatically.
export const SHORT_MAX_CHARS = 280;
const HUMAN_PAIR_LIMIT = 50;
const LOW_OVERLAP = 0.2;
const DAY_MS = 24 * 60 * 60 * 1000;

const SQL = `SELECT o.id AS old_id, n.id AS new_id, o.entity_id,
                    o.content AS old_content, n.content AS new_content,
                    o.added_at AS old_added_at, n.added_at AS new_added_at,
                    o.valid_until AS retired_at
               FROM observations o
               LEFT JOIN observations n ON n.id = o.superseded_by
              WHERE o.superseded_by IS NOT NULL
              ORDER BY o.id`;

/** Lowercase words of 4 or more letters, as a set. */
export function wordSet(text) {
  return new Set(String(text ?? '').toLowerCase().match(/\p{L}{4,}/gu) ?? []);
}

/** Jaccard overlap of the 4+ letter word sets of two texts: 0 to 1 (0 when both are empty). */
export function wordOverlap(a, b) {
  const x = wordSet(a);
  const y = wordSet(b);
  if (x.size === 0 && y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((p, q) => p - q);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const iso = (d) => (d == null ? null : new Date(d).toISOString());
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * Turn the query rows (which carry content) into a report that does not.
 * `now` is a parameter so the 7-day figure can be tested.
 */
export function buildReport(rows, now = new Date()) {
  const pairs = rows.map((r) => {
    const oldLen = String(r.old_content ?? '').length;
    const newLen = r.new_content == null ? null : String(r.new_content).length;
    return {
      old_id: Number(r.old_id),
      superseder_id: r.new_id == null ? null : Number(r.new_id),
      entity_id: r.entity_id == null ? null : Number(r.entity_id),
      old_length: oldLen,
      superseder_length: newLen,
      old_added_at: iso(r.old_added_at),
      superseder_added_at: iso(r.new_added_at),
      retired_at: iso(r.retired_at),
      word_overlap: r.new_content == null ? null : round2(wordOverlap(r.old_content, r.new_content)),
    };
  });
  const cutoff = now.getTime() - 7 * DAY_MS;
  const longEither = pairs.filter((p) => p.old_length > SHORT_MAX_CHARS || (p.superseder_length ?? 0) > SHORT_MAX_CHARS);
  const overlaps = pairs.map((p) => p.word_overlap).filter((x) => x != null);
  const summary = {
    superseded_total: pairs.length,
    retired_last_7_days: pairs.filter((p) => p.retired_at && new Date(p.retired_at).getTime() > cutoff).length,
    short_max_chars: SHORT_MAX_CHARS,
    pairs_either_side_over_short_max: longEither.length,
    pairs_both_short: pairs.length - longEither.length,
    pairs_with_missing_superseder: pairs.filter((p) => p.superseder_id == null || p.superseder_length == null).length,
    median_old_length: median(pairs.map((p) => p.old_length)),
    median_word_overlap: round2(median(overlaps)),
    pairs_overlap_below: LOW_OVERLAP,
    pairs_low_overlap: overlaps.filter((x) => x < LOW_OVERLAP).length,
    long_pairs_low_overlap: longEither.filter((p) => p.word_overlap != null && p.word_overlap < LOW_OVERLAP).length,
  };
  return { summary, pairs };
}

export async function readPairs(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const { rows } = await client.query(SQL);
    return rows;
  } finally {
    await client.query('ROLLBACK');
  }
}

const day = (s) => (s ? s.slice(0, 10) : '-');

function printHuman(report) {
  const s = report.summary;
  console.log('Resonant Mind supersede check (read-only; nothing was changed)\n');
  console.log(`Superseded observations:                ${s.superseded_total}`);
  console.log(`  retired in the last 7 days:           ${s.retired_last_7_days}`);
  console.log(`  either side over ${s.short_max_chars} characters:    ${s.pairs_either_side_over_short_max}  (4.2.0 no longer retires these on its own)`);
  console.log(`  both sides ${s.short_max_chars} characters or less:  ${s.pairs_both_short}`);
  if (s.pairs_with_missing_superseder) console.log(`  superseder row missing:               ${s.pairs_with_missing_superseder}`);
  console.log(`  median length of the retired one:     ${s.median_old_length ?? '-'}`);
  console.log(`  median word overlap with superseder:  ${s.median_word_overlap ?? '-'}  (1 = same words, 0 = none shared)`);
  console.log(`  overlap below ${s.pairs_overlap_below}:                     ${s.pairs_low_overlap} (${s.long_pairs_low_overlap} of them long)`);
  if (report.pairs.length > 0) {
    console.log(`\nFirst ${Math.min(HUMAN_PAIR_LIMIT, report.pairs.length)} pairs (all of them with --json):`);
    console.log('old id -> superseder id  entity  lengths (old/new)  added (old/new)  overlap');
    for (const p of report.pairs.slice(0, HUMAN_PAIR_LIMIT)) {
      console.log(`${p.old_id} -> ${p.superseder_id ?? '?'}  ${p.entity_id ?? '-'}  ${p.old_length}/${p.superseder_length ?? '-'}  ${day(p.old_added_at)}/${day(p.superseder_added_at)}  ${p.word_overlap ?? '-'}`);
    }
  }
  console.log(s.superseded_total > 0
    ? '\nSuperseded observations are hidden from mind_search unless include_expired is set. Do not change anything yet: take a backup, show this report to the owner, and read docs/supersede-check.md. Every repair is the owner\'s decision.'
    : '\nNothing has been superseded.');
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
    const report = buildReport(await readPairs(client));
    if (process.argv.includes('--json')) console.log(JSON.stringify({ read_only: true, ...report }, null, 2));
    else printHuman(report);
    process.exitCode = report.summary.superseded_total > 0 ? 1 : 0;
  } catch (error) {
    console.error(`check could not run: ${error?.message ?? error}`);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
