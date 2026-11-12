import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { HTML_CSP, REVIEW_NOTICE, boundedText } from '../../scripts/v32-to-v4/lib/review-render.mjs';
import { readArtifactFile } from './helpers/artifacts.mjs';
import { runCli } from './helpers/cli-run.mjs';
import { createSqliteSource } from './helpers/seeds.mjs';

// The owner decides, not their agent. A decision draft carries only the hash of an observed value, so the
// owner cannot decide a merge, a timezone or a repaired JSON value from it. `review-decisions` shows the
// owner the real values, locally; these tests drive it as a separate process against a real bundle and check
// that what it shows is in its own output and in no other artifact.
const work = mkdtempSync(join(tmpdir(), 'rmig-review-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);

// distinctive memory content, so that a leak is a string search away
const MARKERS = {
  entityName: 'Rhizome-Marker-Quokka',
  kind: 'mycelial-marker-kind',
  observation: 'first thought about the marker-heron garden',
  unknownWeight: 'crushing-marker-weight',
  badJson: 'not json {marker-brace',
  naive: '2031-04-05T06:07:08',
  hostile: 'see https://example.invalid/leak.png <script>alert(1)</script> <img src="https://example.invalid/x"> \u001b[31m red \u202e reversed',
};
const bundleArgs = () => ['--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')];

function seedMemory(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = OFF'); // the source may hold a reference to nothing: that is what the item is about
    db.exec(`
      UPDATE entities SET name = '${MARKERS.entityName}' WHERE id = 3;
      UPDATE entities SET entity_type = '${MARKERS.kind}' WHERE id = 3;
      UPDATE observations SET content = '${MARKERS.observation}', last_surfaced_at = '${MARKERS.naive}' WHERE id = 11;
    `);
    const insert = db.prepare('INSERT INTO observations (id, entity_id, content, weight, added_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(12, 1, `${MARKERS.hostile} ${'x'.repeat(900)}`, MARKERS.unknownWeight, '2026-01-09 00:00:00');
    db.prepare('INSERT INTO journals (id, content, tags, created_at) VALUES (?, ?, ?, ?)').run(1, 'a journal entry', MARKERS.badJson, '2026-01-09 00:00:00');
    db.prepare('INSERT INTO observations (id, entity_id, content, linked_observation_id, added_at) VALUES (?, ?, ?, ?, ?)').run(13, 1, 'points at nothing', 9999, '2026-01-09 00:00:00');
  } finally { db.close(); }
}

describe('review-decisions shows the owner the real values, locally, and only there', () => {
  const state = {};
  beforeAll(() => {
    createSqliteSource(file('source.sqlite'));
    seedMemory(file('source.sqlite'));
    writeFileSync(file('passphrase'), 'review-decisions-passphrase', { mode: 0o600 });
    const inspect = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--report', file('source-report.json')]);
    expect(inspect.status, inspect.output).toBe(0);
    const exported = runCli(['export', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--source-report', file('source-report.json'), '--migration-id', 'rmig_review_01', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')]);
    expect(exported.status, exported.output).toBe(0);
    const draft = runCli(['draft-decisions', ...bundleArgs(), '--out', file('draft.json')]);
    expect(draft.status, draft.output).toBe(0);
    state.draftOutput = draft.output;
    state.draft = JSON.parse(readFileSync(file('draft.json'), 'utf8'));
  }, 240_000);

  it('the draft itself holds hashes and no memory content, which is why the owner cannot decide from it', () => {
    const types = new Set(state.draft.items.map((item) => item.type));
    for (const type of ['duplicate-entity-name', 'entity-kind', 'timestamp', 'unknown-value', 'malformed-json', 'broken-foreign-key', 'ambiguous-name-reference', 'broken-name-reference', 'tension-state', 'dormancy-translation']) expect(types.has(type), type).toBe(true);
    const text = readFileSync(file('draft.json'), 'utf8');
    for (const [name, marker] of Object.entries(MARKERS)) expect(text.includes(marker), `draft file holds ${name}`).toBe(false);
    expect(state.draftOutput.includes(MARKERS.entityName)).toBe(false);
    expect(state.draft.items.find((item) => item.type === 'entity-kind')).toHaveProperty('observed_value_sha256');
  });

  it('prints each open item with the real values it concerns, what each choice allows and what it does', () => {
    const review = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('draft.json')]);
    expect(review.status, review.output).toBe(0);
    const text = review.stdout;
    // it says first that it shows memory content and must not be pasted into a chat
    expect(text.split('\n').slice(0, 5).join('\n')).toContain(REVIEW_NOTICE.slice(0, 60));
    expect(text.replace(/\s+/gu, ' ')).toContain('do not paste it into a chat');
    // the values: the colliding entities, the unknown kind, the unreadable time, the broken JSON, the unknown value
    for (const needle of ['"Ada"', MARKERS.entityName, MARKERS.kind, MARKERS.naive, MARKERS.badJson, MARKERS.unknownWeight, MARKERS.observation, 'Ada (', 'points at nothing']) {
      if (needle === 'Ada (') continue; // (a name the owner will type; not in the bundle)
      expect(text, needle).toContain(needle);
    }
    // for a merge: both entities with their observation counts and the first observations, and the consequence of each choice
    expect(text).toMatch(/The entities that share the name/u);
    expect(text).toMatch(/observations=\d+/u);
    expect(text).toMatch(/\* merge\n\s+The listed entities become one/u);
    expect(text).toMatch(/\* rename\n\s+Every entity keeps its own id/u);
    expect(text).toMatch(/EVERY entity listed above is left out of v4/u);
    // for a time with no timezone: what the stored moment would be under a timezone
    expect(text).toContain('2031-04-05T06:07:08.000Z');
    expect(text).toContain('2031-04-05T05:07:08.000Z'); // +01:00
    // every item is open, and the counts say so
    expect(text).toMatch(new RegExp(`Items:\\s+${state.draft.items.length} \\(${state.draft.items.length} open, 0 with a recorded choice\\)`, 'u'));
    // long values are cut, with a count
    expect(text).toMatch(/\.\.\. \(\+\d+ more characters\)/u);
    // content cannot drive the terminal: no raw escape, direction override or markup survives
    expect(text.includes('\u001b')).toBe(false);
    expect(text.includes('\u202e')).toBe(false);
    expect(text).toContain('\\u001b[31m');
    expect(text).toContain('\\u202e');
  }, 120_000);

  it('writes a self-contained HTML file with --html, prints no value to the terminal, and never overwrites', () => {
    const review = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('draft.json'), '--html', file('review.html')]);
    expect(review.status, review.output).toBe(0);
    expect(review.stdout).toMatch(/^review-decisions: wrote .*review\.html; items=\d+ \(\d+ open, 0 with a recorded choice\)\. The file shows memory content/u);
    for (const marker of Object.values(MARKERS)) expect(review.output.includes(marker)).toBe(false);
    const html = readFileSync(file('review.html'), 'utf8');
    for (const needle of [MARKERS.entityName, MARKERS.kind, MARKERS.naive, MARKERS.observation, MARKERS.unknownWeight]) expect(html, needle).toContain(needle);
    expect(html.replace(/\s+/gu, ' ')).toContain('do not paste it into a chat');
    const again = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('draft.json'), '--html', file('review.html')]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/u);
    state.html = html;
  }, 120_000);

  it('the HTML loads nothing: no script, link, image, frame, form or url, no network reference, and a policy that forbids loads', () => {
    const html = state.html;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`);
    expect(HTML_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
    // a tokenizer, not a search for words: every tag, every attribute
    const allowedTags = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'h3', 'p', 'span', 'article', 'div', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'li', 'strong', 'code', 'br']);
    const allowedAttributes = new Set(['lang', 'charset', 'http-equiv', 'content', 'name', 'id', 'class', 'role']);
    const withoutStyle = html.replace(/<style>[\s\S]*?<\/style>/u, '<style></style>');
    const tags = [...withoutStyle.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*>/gu)];
    expect(tags.length).toBeGreaterThan(50);
    const problems = [];
    for (const [, , name, attributes] of tags) {
      if (!allowedTags.has(name.toLowerCase())) problems.push(`tag <${name}>`);
      for (const [, attribute, value = ''] of attributes.matchAll(/\s+([a-zA-Z-]+)(?:="([^"]*)")?/gu)) {
        if (!allowedAttributes.has(attribute.toLowerCase())) problems.push(`attribute ${attribute}`);
        if (/(?:https?:|\/\/|url\(|javascript:|data:)/iu.test(value)) problems.push(`reference in ${attribute}`);
      }
    }
    expect(problems).toEqual([]);
    // every '<' in the document starts one of those tags (nothing else, in particular nothing from the memory content, is markup)
    expect((withoutStyle.match(/</gu) ?? []).length).toBe(tags.length + 1); // (+ the doctype)
    expect(html).not.toMatch(/<script|<link|<iframe|<img|<object|<embed|<form|<base|<svg|<audio|<video|<a[\s>]/iu);
    const style = /<style>([\s\S]*?)<\/style>/u.exec(html)[1];
    expect(style).not.toMatch(/url\(|@import|https?:|\/\/|expression\(|@font-face/iu);
    expect(style).toContain('system-ui'); // the reader's own fonts
    // the hostile content is there, as text
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=\\&quot;https://example.invalid/x\\&quot;&gt;');
    expect(html.includes('\u001b')).toBe(false);
  });

  it('never puts a value in JSON: --json needs --html, and then it carries counts and a path', () => {
    const refused = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('draft.json'), '--json']);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-SOURCE-ARG', phase: 'review-decisions' });
    for (const marker of Object.values(MARKERS)) expect(refused.output.includes(marker)).toBe(false);
    const json = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('draft.json'), '--html', file('review-json.html'), '--json']);
    expect(json.status, json.output).toBe(0);
    const result = JSON.parse(json.stdout);
    expect(result).toMatchObject({ command: 'review-decisions', items: state.draft.items.length, open: state.draft.items.length, recorded: 0, contains_memory_content: false, html: file('review-json.html') });
    expect(result.text).toBeUndefined();
    for (const marker of Object.values(MARKERS)) expect(json.output.includes(marker)).toBe(false);
  }, 120_000);

  it('is not leaked into the decision file, the reviewed file, the policy, or any command output but its own', () => {
    // the owner's choices (names they type are theirs, not memory content); each states who stated it
    const REVIEW = {
      'duplicate-entity-name': { action: 'rename', names: Object.fromEntries(state.draft.items.find((item) => item.type === 'duplicate-entity-name').collision_ids.map((id) => [String(id), `Ada (${id})`])) },
      'entity-kind': { action: 'map-to-node', kind: 'concept' },
      timestamp: { action: 'normalize-utc', timezone: '+01:00' },
      'dormancy-translation': 'translate-to-orphan',
      'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-07T00:00:00Z' },
      'ambiguous-name-reference': { action: 'link-by-reviewed-id', target_id: 1 },
      'unknown-value': { action: 'map', value: 'heavy' },
      'malformed-json': { action: 'map-json', value: [] },
      'broken-foreign-key': 'null-if-allowed',
      'broken-name-reference': 'exclude-row',
    };
    const outputs = [];
    const edited = { ...state.draft, items: state.draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: REVIEW[item.type] })) };
    // a value is repaired the owner's way: a time-of-day item, a date item
    writeFileSync(file('edited.json'), JSON.stringify(edited, null, 2));
    const applied = runCli(['apply-decisions', ...bundleArgs(), '--decisions', file('edited.json'), '--reviewed-by', 'The Owner', '--out', file('reviewed.json')]);
    expect(applied.status, applied.output).toBe(0);
    outputs.push(applied.output);
    const compiled = runCli(['compile-policy', ...bundleArgs(), '--decisions', file('reviewed.json'), '--out', file('compiled-policy.json')]);
    expect(compiled.status, compiled.output).toBe(0);
    outputs.push(compiled.output);
    // the review of the edited file shows the recorded choices, who stated them, and still the values
    const review = runCli(['review-decisions', ...bundleArgs(), '--decisions', file('reviewed.json')]);
    expect(review.status, review.output).toBe(0);
    expect(review.stdout).toContain('Recorded choice:');
    expect(review.stdout).toContain('stated by: owner');
    expect(review.stdout).toMatch(new RegExp(`Items:\\s+${edited.items.length} \\(0 open, ${edited.items.length} with a recorded choice\\)`, 'u'));
    expect(review.stdout).toContain(MARKERS.entityName);
    const artifacts = ['draft.json', 'edited.json', 'reviewed.json', 'compiled-policy.json'];
    for (const [name, marker] of Object.entries(MARKERS)) {
      for (const output of outputs) expect(output.includes(marker), `a command output holds ${name}`).toBe(false);
      for (const artifact of artifacts.filter((entry) => entry !== 'compiled-policy.json')) expect(readFileSync(file(artifact), 'utf8').includes(marker), `${artifact} holds ${name}`).toBe(false);
    }
    // the compiled policy is encrypted; opened, it holds the owner's names and the statements, not the memory content of the values
    expect(readFileSync(file('compiled-policy.json')).includes(MARKERS.entityName)).toBe(false);
    const policy = readArtifactFile(file('compiled-policy.json'), 'compiled-policy', file('passphrase'));
    expect(policy.choice_statements).toMatchObject({ stated_by: { owner: edited.items.length, 'owner-accepted-agent-suggestion': 0 }, bulk_rules: [], suggestions_accepted: [] });
    // and no file besides the HTML ones holds a value
    for (const name of readdirSync(work).filter((entry) => !entry.endsWith('.html') && entry !== 'source.sqlite' && !entry.startsWith('bundle'))) {
      const text = readFileSync(file(name), 'latin1');
      for (const marker of [MARKERS.entityName, MARKERS.kind, MARKERS.badJson]) expect(text.includes(marker), `${name} holds a value`).toBe(false);
    }
  }, 240_000);

  it('refuses a decision file that does not belong to the bundle, or does not match the rows it names', () => {
    const run = (name, value) => { writeFileSync(file(name), JSON.stringify(value)); return runCli(['review-decisions', ...bundleArgs(), '--decisions', file(name), '--json', '--html', file(`${name}.html`)]); };
    const otherMigration = run('other-migration.json', { ...state.draft, migration_id: 'rmig_another_01' });
    expect(otherMigration.status).toBe(2);
    expect(JSON.parse(otherMigration.stdout)).toMatchObject({ code: 'RMIG-E-POLICY-MISMATCH', phase: 'review-decisions' });
    const otherBundle = run('other-bundle.json', { ...state.draft, bundle_manifest_sha256: 'a'.repeat(64) });
    expect(otherBundle.status).toBe(2);
    expect(JSON.parse(otherBundle.stdout)).toMatchObject({ code: 'RMIG-E-POLICY-MISMATCH' });
    const missing = run('missing.json', { ...state.draft, items: state.draft.items.slice(1) });
    expect(missing.status).toBe(2);
    const extra = run('extra.json', { ...state.draft, items: [...state.draft.items, { ...state.draft.items[0], decision_id: 'b'.repeat(64) }] });
    expect(extra.status).toBe(2);
    const stale = run('stale.json', { ...state.draft, items: state.draft.items.map((item, index) => (index === 0 ? { ...item, reason: 'edited' } : item)) });
    expect(stale.status).toBe(2);
    const twice = run('twice.json', { ...state.draft, items: [...state.draft.items, state.draft.items[0]] });
    expect(twice.status).toBe(2);
    const notManifest = run('not-manifest.json', { hello: 'world' });
    expect(notManifest.status).toBe(2);
    for (const name of ['other-migration', 'other-bundle', 'missing', 'extra', 'stale', 'twice', 'not-manifest']) expect(existsSync(file(`${name}.json.html`)), name).toBe(false);
    // a wrong passphrase opens nothing
    writeFileSync(file('wrong-passphrase'), 'not the passphrase', { mode: 0o600 });
    const wrong = runCli(['review-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('wrong-passphrase'), '--decisions', file('draft.json')]);
    expect(wrong.status).toBe(2);
    expect(wrong.stdout).toBe('');
  }, 240_000);
});

describe('who stated each choice is recorded, and a choice without it is refused', () => {
  const state = {};
  beforeAll(() => {
    const dir = (name) => join(work, `stated-${name}`);
    state.dir = dir;
    createSqliteSource(join(work, 'stated.sqlite'));
    writeFileSync(join(work, 'stated-passphrase'), 'stated-by-passphrase', { mode: 0o600 });
    const exported = runCli(['export', '--source-kind', 'sqlite', '--source', join(work, 'stated.sqlite'), '--migration-id', 'rmig_stated_01', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase')]);
    expect(exported.status, exported.output).toBe(0);
    const draft = runCli(['draft-decisions', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--out', join(work, 'stated-draft.json')]);
    expect(draft.status, draft.output).toBe(0);
    state.draft = JSON.parse(readFileSync(join(work, 'stated-draft.json'), 'utf8'));
  }, 240_000);

  const CHOICES = {
    'duplicate-entity-name': { action: 'rename', names: { 1: 'Ada (person)', 2: 'Ada (work)' } },
    'entity-kind': { action: 'map-to-node', kind: 'concept' },
    timestamp: { action: 'normalize-utc', timezone: '+01:00' },
    'dormancy-translation': 'translate-to-orphan',
    'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-07T00:00:00Z' },
    'ambiguous-name-reference': { action: 'link-by-reviewed-id', target_id: 1 },
  };
  const apply = (name, items, extra = []) => {
    writeFileSync(join(work, `${name}.json`), JSON.stringify({ ...state.draft, items }));
    return runCli(['apply-decisions', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, `${name}.json`), '--reviewed-by', 'The Owner', '--out', join(work, `${name}-reviewed.json`), ...extra]);
  };
  const chosen = (statement) => state.draft.items.map((item, index) => ({ ...item, choice: CHOICES[item.type], ...statement(item, index) }));

  it('refuses a chosen item with no stated_by, or with a value that is not one of the two', () => {
    const none = apply('stated-none', chosen((_item, index) => (index === 0 ? {} : { stated_by: 'owner' })), ['--json']);
    expect(none.status, none.output).toBe(2);
    expect(JSON.parse(none.stdout)).toMatchObject({ code: 'RMIG-E-POLICY-UNRESOLVED', phase: 'apply-decisions' });
    expect(JSON.parse(none.stdout).summary).toContain('stated_by');
    expect(existsSync(join(work, 'stated-none-reviewed.json'))).toBe(false);
    for (const wrong of ['agent', 'Fable', 'owner ', '', null, 7, 'owner-accepted-agent-choice']) {
      const result = apply('stated-wrong', chosen(() => ({ stated_by: wrong })), ['--json']);
      expect(result.status, String(wrong)).toBe(2);
      expect(JSON.parse(result.stdout).summary, String(wrong)).toContain('stated_by');
      rmSync(join(work, 'stated-wrong.json'), { force: true });
    }
    // an item with neither a choice nor a statement is the old refusal: unresolved
    const unresolved = apply('stated-unresolved', state.draft.items.map((item, index) => (index === 0 ? item : { ...item, choice: CHOICES[item.type], stated_by: 'owner' })), ['--json']);
    expect(unresolved.status).toBe(2);
    expect(JSON.parse(unresolved.stdout)).toMatchObject({ code: 'RMIG-E-POLICY-UNRESOLVED', safe_details: { unresolved: 1 } });
  }, 240_000);

  it('refuses a statement on an item that has no choice, and a malformed bulk rule', () => {
    const noChoice = apply('stated-nochoice', state.draft.items.map((item, index) => (index === 0 ? { ...item, stated_by: 'owner' } : { ...item, choice: CHOICES[item.type], stated_by: 'owner' })), ['--json']);
    expect(noChoice.status).toBe(2);
    // A rule is printed back (apply-decisions, the report, status), so nothing in it may make a line read otherwise:
    // no direction override, zero-width or other invisible character, the same set the review writes out.
    for (const rule of ['', ' padded ', 'x'.repeat(501), 'two\nlines', 42, 'rename every ‮etaticilpud', 'merge​ all', 'keep ⁦the⁩ first', 'soft­hyphen']) {
      const result = apply('stated-rule', chosen((_item, index) => ({ stated_by: 'owner', bulk_rule: rule })), ['--json']);
      expect(result.status, String(rule).slice(0, 20)).toBe(2);
      expect(JSON.parse(result.stdout).summary).toContain('bulk_rule');
      rmSync(join(work, 'stated-rule.json'), { force: true });
    }
  }, 240_000);

  it('refuses a reviewer name with a control, invisible or direction-changing character', () => {
    writeFileSync(join(work, 'reviewer.json'), JSON.stringify({ ...state.draft, items: chosen(() => ({ stated_by: 'owner' })) }));
    for (const reviewer of ['The ‮Owner', 'The​Owner', 'The ⁨Owner⁩', 'The\u0007Owner']) {
      const result = runCli(['apply-decisions', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, 'reviewer.json'), '--reviewed-by', reviewer, '--out', join(work, 'reviewer-reviewed.json'), '--json']);
      expect(result.status, JSON.stringify(reviewer)).toBe(2);
      expect(JSON.parse(result.stdout).summary).toContain('reviewed_by');
      expect(existsSync(join(work, 'reviewer-reviewed.json'))).toBe(false);
    }
  }, 240_000);

  it('records an accepted suggestion and the owner\'s bulk rule verbatim, through apply-decisions, the compiled policy and the report', () => {
    const rule = 'rename every duplicate by appending its context';
    const items = chosen((item) => (item.type === 'duplicate-entity-name' ? { stated_by: 'owner-accepted-agent-suggestion', bulk_rule: rule } : item.type === 'entity-kind' ? { stated_by: 'owner-accepted-agent-suggestion' } : { stated_by: 'owner' }));
    const applied = apply('stated-ok', items);
    expect(applied.status, applied.output).toBe(0);
    expect(applied.stdout).toContain('stated_by owner=4,owner-accepted-agent-suggestion=2');
    expect(applied.stdout).toContain(`bulk rules: 1 item(s) by the rule ${JSON.stringify(rule)}`);
    const reviewed = JSON.parse(readFileSync(join(work, 'stated-ok-reviewed.json'), 'utf8'));
    const byType = Object.fromEntries(reviewed.items.map((item) => [item.type, item]));
    expect(byType['duplicate-entity-name']).toMatchObject({ stated_by: 'owner-accepted-agent-suggestion', bulk_rule: rule });
    expect(byType['entity-kind']).toMatchObject({ stated_by: 'owner-accepted-agent-suggestion' });
    expect(byType['entity-kind']).not.toHaveProperty('bulk_rule');
    expect(byType.timestamp).toMatchObject({ stated_by: 'owner' });
    const json = runCli(['apply-decisions', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, 'stated-ok.json'), '--reviewed-by', 'The Owner', '--out', join(work, 'stated-ok-reviewed-2.json'), '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ stated_by: { owner: 4, 'owner-accepted-agent-suggestion': 2 }, bulk_rules: [{ rule, items: 1 }], suggestions_accepted: [byType['duplicate-entity-name'].decision_id, byType['entity-kind'].decision_id].sort() });

    const compiled = runCli(['compile-policy', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, 'stated-ok-reviewed.json'), '--out', join(work, 'stated-policy.json')]);
    expect(compiled.status, compiled.output).toBe(0);
    const policy = readArtifactFile(join(work, 'stated-policy.json'), 'compiled-policy', join(work, 'stated-passphrase'));
    expect(policy.choice_statements).toEqual({ stated_by: { owner: 4, 'owner-accepted-agent-suggestion': 2 }, bulk_rules: [{ rule, items: 1 }], suggestions_accepted: [byType['duplicate-entity-name'].decision_id, byType['entity-kind'].decision_id].sort() });

    // a hand-edited reviewed file that drops the statement is refused downstream as well: apply-decisions is not the only guard
    const stripped = { ...reviewed, items: reviewed.items.map((item, index) => { if (index !== 0) return item; const { stated_by: _statement, ...rest } = item; return rest; }) };
    writeFileSync(join(work, 'stated-stripped.json'), JSON.stringify(stripped));
    const refused = runCli(['compile-policy', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, 'stated-stripped.json'), '--out', join(work, 'stated-policy-2.json')]);
    expect(refused.status).toBe(2);
    expect(existsSync(join(work, 'stated-policy-2.json'))).toBe(false);
    // and a draft that carries a statement is not a draft
    const draftWithStatement = { ...state.draft, items: state.draft.items.map((item, index) => (index === 0 ? { ...item, stated_by: 'owner' } : item)) };
    writeFileSync(join(work, 'stated-draft-with.json'), JSON.stringify(draftWithStatement));
    expect(runCli(['review-decisions', '--bundle', join(work, 'stated.rmigrate'), '--passphrase-file', join(work, 'stated-passphrase'), '--decisions', join(work, 'stated-draft-with.json'), '--json', '--html', join(work, 'x.html')]).status).toBe(0); // the review shows it; apply is what judges it
  }, 240_000);
});

describe('what a value looks like to the owner', () => {
  it('is JSON text, with invisible and direction-changing characters written out, and a count when it is cut', () => {
    expect(boundedText('plain')).toBe('"plain"');
    expect(boundedText(null)).toBe('null');
    expect(boundedText(12)).toBe('12');
    expect(boundedText('line\nbreak "quoted"')).toBe('"line\\nbreak \\"quoted\\""');
    expect(boundedText('a\u202eb\u200bc\u007fd\u2028e')).toBe('"a\\u202eb\\u200bc\\u007fd\\u2028e"');
    const long = boundedText('y'.repeat(1000), 50);
    expect(long.startsWith(`"${'y'.repeat(49)}`)).toBe(true);
    expect(long).toMatch(/ \.\.\. \(\+\d+ more characters\)$/u);
    expect(Array.from(canonicalJson({ a: long })).length).toBeGreaterThan(0);
  });
});
