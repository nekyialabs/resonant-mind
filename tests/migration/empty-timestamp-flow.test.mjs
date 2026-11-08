import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { readArtifactFile } from './helpers/artifacts.mjs';
import { runCli } from './helpers/cli-run.mjs';
import { SQLITE_REVIEW, createSqliteSource } from './helpers/seeds.mjs';

// Issue 14, through the operator's commands on a real SQLite v3.2 source (no database needed): empty text in timestamp and date
// columns is drafted as decision items, an unreviewed or malformed answer is refused, and each reviewed answer reaches the plan.
const work = mkdtempSync(join(tmpdir(), 'rmig-empty-time-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
const EMPTY = sha256Hex('');

describe('an empty timestamp or date in a SQLite v3.2 source, through the CLI', () => {
  const state = {};
  const bundle = () => ['--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')];
  const cell = (item) => `${item.source_table}.${item.source_id}.${item.field}`;
  const isEmptyCell = (item) => (item.type === 'timestamp' || item.type === 'date') && item.observed_value_sha256 === EMPTY;
  // what the owner says about each empty cell; every other item is answered as in the shared seed review
  const OWNER = {
    'observations.10.last_accessed_at': { action: 'replace-timestamp', value: '2026-02-04T05:06:07+00:00' },
    'observations.11.last_surfaced_at': { action: 'set-null' },
    'observations.11.source_date': 'set-null',
    'observations.12.added_at': 'exclude-row',
    'entities.3.updated_at': { action: 'replace-timestamp', value: '2026-01-03T10:00:00+01:00' },
  };
  const answer = (item, overrides = {}) => ({ ...item, stated_by: 'owner', choice: isEmptyCell(item) ? { ...OWNER, ...overrides }[cell(item)] : SQLITE_REVIEW[item.type] });

  it('drafts one item per empty cell, offering set-null only where v4 can hold NULL', () => {
    createSqliteSource(file('source.sqlite'));
    const database = new DatabaseSync(file('source.sqlite'));
    try {
      database.exec("UPDATE observations SET last_accessed_at = '' WHERE id = 10; UPDATE observations SET last_surfaced_at = '', source_date = '' WHERE id = 11; UPDATE entities SET updated_at = '' WHERE id = 3;");
      database.exec("INSERT INTO observations (id, entity_id, content, added_at) VALUES (12, 1, 'a blank time', '');");
    } finally { database.close(); }
    writeFileSync(file('passphrase'), 'empty-timestamp-flow-passphrase', { mode: 0o600 });
    expect(runCli(['inspect-source', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--report', file('source-report.json')]).status).toBe(0);
    const exported = runCli(['export', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--source-report', file('source-report.json'), '--migration-id', 'rmig_empty_time_01', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')]);
    expect(exported.status, exported.output).toBe(0);
    const draft = runCli(['draft-decisions', ...bundle(), '--out', file('draft.json')]);
    expect(draft.status, draft.output).toBe(0);
    state.draft = JSON.parse(readFileSync(file('draft.json'), 'utf8'));
    const empties = state.draft.items.filter(isEmptyCell);
    expect(empties.map(cell).sort()).toEqual(Object.keys(OWNER).sort());
    const byCell = Object.fromEntries(empties.map((item) => [cell(item), item]));
    expect(byCell['observations.10.last_accessed_at']).toMatchObject({ type: 'timestamp', allowed_choices: ['replace-timestamp', 'set-null', 'exclude-row'], reason: 'timestamp is empty text, not NULL; the owner must choose' });
    expect(byCell['observations.11.source_date']).toMatchObject({ type: 'date', allowed_choices: ['normalize-date', 'set-null', 'exclude-row'] });
    expect(byCell['entities.3.updated_at'].allowed_choices).toEqual(['replace-timestamp', 'exclude-row']);
    expect(state.draft.items.every((item) => !Object.hasOwn(item, 'choice'))).toBe(true); // nothing is chosen for the owner
  }, 180_000);

  it('refuses an unanswered cell, a set-null the item does not offer, and a replacement that is not an instant', () => {
    const attempt = (items, name) => runCli(['apply-decisions', ...bundle(), '--decisions', file(name), '--reviewed-by', 'Test Reviewer', '--out', file(`never-${name}`), '--json']);
    const cases = {
      'unanswered.json': (item) => (cell(item) === 'observations.12.added_at' ? item : answer(item)),
      'set-null-not-offered.json': (item) => answer(item, { 'entities.3.updated_at': 'set-null' }),
      'no-offset.json': (item) => answer(item, { 'observations.10.last_accessed_at': { action: 'replace-timestamp', value: '2026-02-04T05:06:07' } }),
      'not-real.json': (item) => answer(item, { 'observations.10.last_accessed_at': { action: 'replace-timestamp', value: '2026-02-30T05:06:07Z' } }),
      'bare-string.json': (item) => answer(item, { 'observations.10.last_accessed_at': 'replace-timestamp' }),
    };
    for (const [name, choose] of Object.entries(cases)) {
      writeFileSync(file(name), JSON.stringify({ ...state.draft, items: state.draft.items.map(choose) }));
      const refused = attempt(null, name);
      expect(refused.status, name).toBe(2);
      expect(JSON.parse(refused.stdout).code, name).toBe('RMIG-E-POLICY-UNRESOLVED');
      expect(existsSync(file(`never-${name}`)), name).toBe(false);
    }
  }, 180_000);

  it('applies the owner\'s answers, compiles, and plans exactly the reviewed outcome', () => {
    writeFileSync(file('edited.json'), JSON.stringify({ ...state.draft, items: state.draft.items.map((item) => answer(item)) }));
    const applied = runCli(['apply-decisions', ...bundle(), '--decisions', file('edited.json'), '--reviewed-by', 'Test Reviewer', '--out', file('reviewed.json')]);
    expect(applied.status, applied.output).toBe(0);
    const compiled = runCli(['compile-policy', ...bundle(), '--decisions', file('reviewed.json'), '--out', file('policy.json')]);
    expect(compiled.status, compiled.output).toBe(0);
    const planned = runCli(['plan-relational', ...bundle(), '--compiled-policy', file('policy.json'), '--out', file('plan.json')]);
    expect(planned.status, planned.output).toBe(0);
    const plan = readArtifactFile(file('plan.json'), 'relational-plan', file('passphrase'));
    const observation = (id) => plan.members.observations.find((row) => row.id === id);
    expect(observation(10)).toMatchObject({ last_accessed_at: '2026-02-04T05:06:07.000Z', last_surfaced_at: '2026-02-03T03:05:06.000Z' }); // the empty cell is replaced, the naive one still takes its reviewed timezone
    expect(observation(11)).toMatchObject({ last_surfaced_at: null, source_date: null });
    expect(observation(12)).toBeUndefined(); // exclude-row
    expect(plan.members.nodes.find((row) => row.name === 'Rhizome').updated_at).toBe('2026-01-03T09:00:00.000Z');
    expect(plan.losses.filter((loss) => loss.kind === 'excluded-row').map((loss) => loss.source_table)).toEqual(['observations']);
    expect(JSON.stringify(plan.members)).not.toMatch(/"(?:added_at|last_accessed_at|last_surfaced_at|updated_at|created_at|source_date)":""/u); // an empty string is never carried through
  }, 180_000);
});
