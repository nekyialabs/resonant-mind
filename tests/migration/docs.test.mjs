import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_GROUPS } from '../../scripts/v32-to-v4/commands/usage.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const normalized = (text) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const userGuide = () => normalized(read('USER_MIGRATION_GUIDE.md'));
const agentRunbook = () => normalized(read('AGENT_MIGRATION_RUNBOOK.md'));
const refusalCodes = [
  'RMIG-E-NODE-VERSION',
  'RMIG-E-SOURCE-ARG',
  'RMIG-E-SOURCE-FINGERPRINT',
  'RMIG-E-SOURCE-DRIFT',
  'RMIG-E-SOURCE-NOT-READONLY',
  'RMIG-E-D1-REMOTE-UNSUPPORTED',
  'RMIG-E-D1-SQL-UNSAFE',
  'RMIG-E-BUNDLE-PLAINTEXT-ACK',
  'RMIG-E-BUNDLE-INTEGRITY',
  'RMIG-E-BUNDLE-DECRYPT',
  'RMIG-E-SECRET-DETECTED',
  'RMIG-E-POLICY-UNRESOLVED',
  'RMIG-E-POLICY-MISMATCH',
  'RMIG-E-SAME-SOURCE-TARGET',
  'RMIG-E-TARGET-NOT-FRESH',
  'RMIG-E-TARGET-SCHEMA',
  'RMIG-E-DRY-RUN-REQUIRED',
  'RMIG-E-DRY-RUN',
  'RMIG-E-TARGET-CHANGED',
  'RMIG-E-ENTITY-COMPAT',
  'RMIG-E-RECEIPT-MISMATCH',
  'RMIG-E-IMAGE-INCOMPLETE',
  'RMIG-E-REEMBED-INCOMPLETE',
  'RMIG-E-CHECKPOINT',
  'RMIG-E-CHECKPOINT-FAULT',
  'RMIG-E-VALIDATION',
  'RMIG-E-NORMALISE-UNRESOLVED',
  'RMIG-E-NORMALISE-FAILED',
  'RMIG-E-COMMAND-UNKNOWN',
  'RMIG-E-COMMAND-NOT-IMPLEMENTED',
];

const requiredHeadings = [
  'Support matrix',
  'Source and target safety',
  'What changes in the data',
  'Backup and restore rehearsal',
  'Operator command sequence',
  'Risks, sizing, and quiescence',
  'Troubleshooting',
  'Interruption and restart',
  'Cutover and rollback',
  'Sensitive artifact retention',
];

const exactCommands = [
  'inspect-source', 'normalise-source', 'export', 'verify-bundle', 'draft-decisions', 'review-decisions', 'apply-decisions', 'compile-policy', 'plan-relational',
  'inspect-target', 'prepare-target', 'dry-run', 'import', 'plan-images', 'copy-images',
  'plan-reembed', 'validate', 'status',
];

const forbiddenPositiveClaims = [
  /in-place\s+(?:migration|upgrade|import)\s+(?:is|remains)\s+(?:supported|allowed|available)/iu,
  /(?:support|upgrade|migration|import)\s+(?:is|remains)\s+(?:supported|allowed|available)\s+in-place/iu,
  /automatic(?:ally)?\s+(?:copy|transfer|upload)\s+(?:to\s+)?R2(?![^.\n]{0,40}(?:unsupported|not supported|not permitted))/iu,
  /general\s+resume\s+(?:is|remains)\s+(?:supported|available)/iu,
  /automatic\s+cutover\s+(?:is|remains)\s+(?:supported|available)/iu,
  /release\s+support\s+(?:is|remains)\s+(?:provided|included|promised)/iu,
  /supported\s+release\s+(?:is|remains|ships)/iu,
];

function assertHasEvery(text, values) {
  for (const value of values) expect(text).toContain(value);
}

describe('operator migration documentation', () => {
  it('creates both operator documents with the required sections', () => {
    expect(existsSync(resolve(root, 'USER_MIGRATION_GUIDE.md'))).toBe(true);
    expect(existsSync(resolve(root, 'AGENT_MIGRATION_RUNBOOK.md'))).toBe(true);
    assertHasEvery(userGuide(), requiredHeadings);
    assertHasEvery(agentRunbook(), [
      'State machine', 'Authorization gate', 'Secret boundary', 'Backup evidence',
      'Identity and freshness gate', 'Decision review gate', 'Dry-run receipt gate',
      'External phase evidence', 'Stop conditions', 'Cutover and rollback',
    ]);
  });

  it('states the exact first-release source and target boundary', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    assertHasEvery(text, [
      'PostgreSQL v3.2.0',
      'D1/SQLite v3.2.0',
      'fresh v4 PostgreSQL',
      'read-only',
      'separate',
      'old vectors',
      'operator-assisted',
      'not a product support promise',
    ]);
    expect(text).toMatch(/remote Cloudflare D1[\s\S]{0,500}npx wrangler d1 export <binding-or-name> --remote --output <local\.sql>/iu);
    expect(text).toMatch(/R2[\s\S]{0,500}(?:external|operator).{0,80}(?:receipt|handoff)/iu);
    for (const pattern of forbiddenPositiveClaims) expect(text).not.toMatch(pattern);
  });

  it('documents every current refusal code and exact refusal language', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    assertHasEvery(text, refusalCodes);
    assertHasEvery(text, [
      'exit code 2',
      'Unexpected internal failures use exit code 1',
      'human text on stderr',
      'JSON on stdout when --json is set',
      'No bypass is permitted',
    ]);
  });

  it('documents how a v3.2 image can complete, the exit codes of status, and what each image state rests on', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    assertHasEvery(text, [
      // the copy fingerprints what it copies, and says so; what makes a copy refuse
      'stores a path and descriptive columns and nothing about the object',
      'source_fingerprint',
      'detected from the bytes',
      'never from the file name',
      'writes no receipt',
      'source-changed-after-fingerprint',
      'target-holds-a-different-object',
      // a receipt for objects the tool cannot read must carry the observed values
      'sha256',
      'fingerprint-missing-or-malformed',
      'signed-receipt-attested',
      'tool-rehashed-source-and-target',
      'tool-rehashed-target-against-plan',
      'signed-receipt-rehashed-target',
      'images_fingerprint',
      'copy-time-receipt',
      'source-now',
      'object-binding-unverifiable',
      // status: one code per outcome
      '**Exit codes of `status`.**',
      '`3` means `unverified`',
      'must treat `3`, like `2`, as not proven',
      'makes `status` exit 3',
    ]);
    // the old names of the image states are gone
    expect(text).not.toContain('tool-rehashed-objects');
    expect(text).not.toContain('attested-by-signed-receipt');
    expect(text).not.toMatch(/images`? \| `verified-by-tool`/u);
  });

  it('says that the owner decides from the real values, what an agent may not do, and who stated each choice', () => {
    const guide = userGuide().replace(/\s+/gu, ' ');
    assertHasEvery(guide, [
      'The owner decides, from the real values',
      'review-decisions',
      'a hash of each observed value and not the value',
      'default-src \'none\'; style-src \'unsafe-inline\'',
      'no script, no link, no image, no font, no frame',
      'must not be pasted into a chat',
      'stated_by',
      'owner-accepted-agent-suggestion',
      'bulk_rule',
      'A bulk approval must name its rule',
      'that is not a choice',
      'never an agent\'s',
    ]);
    const runbook = agentRunbook().replace(/\s+/gu, ' ');
    assertHasEvery(runbook, [
      'the owner decides from the real values',
      'review-decisions',
      'does not read it back, summarise it, paste it into chat',
      'and it does not open the HTML file',
      '"you decide", "whatever\'s sensible", "approve all"',
      'that is not a choice',
      'A bulk approval must name its rule',
      'recorded verbatim in `bulk_rule`',
      'owner-accepted-agent-suggestion',
      'never its own name',
    ]);
  });

  it('documents how an unsigned image receipt is checked, which defaults are evaluated, and that an offline comparison is not a validation', () => {
    const text = `${userGuide()}\n${agentRunbook()}`.replace(/\s+/gu, ' ');
    assertHasEvery(text, [
      '--image-source-dir',
      'receipt_seal',
      'receipt-not-sealed',
      'image-receipt-seal-invalid',
      'source-dir-required-to-check-an-unsigned-receipt',
      'image-source-differs-from-copy-fingerprint',
      'default-expression-not-evaluated',
      'transaction_timestamp()',
      'an integer within the sequence',
      'There is no acknowledgement',
      'reconcileMigration',
    ]);
  });

  it('contains the current CLI command names and parser options', () => {
    const text = userGuide();
    assertHasEvery(text, exactCommands);
    assertHasEvery(text, [
      '--source-kind', '--source', '--report', '--migration-id', '--bundle',
      '--source-report', '--source-fingerprint', '--passphrase-file',
      '--allow-plaintext-bundle', '--allow-plaintext-artifact', '--acknowledge-plaintext-risk', '--decisions', '--out',
      '--reviewed-by', '--compiled-policy',
      '--target', '--bundle-manifest-sha256', '--compiled-policy-sha256',
      '--resume-schema', '--plan', '--staging-schema', '--receipt-out', '--dry-run',
      '--input', '--images', '--adapter', '--external-receipt', '--trusted-public-key',
      '--reembed-plan', '--reembed-receipts', '--embedding-model', '--image-target-dir', '--image-source-dir', '--html', '--dry-run-receipt', '--import-receipt',
      '--image-plan', '--image-receipt', '--operator-cutover-ack',
    ]);
    expect(text).toContain('node scripts/v32-to-v4/cli.mjs <command> --help');
    expect(text).not.toContain('Implementation conflict');
    expect(text).not.toContain('command names only');
  });

  it('names a real command and real options in every step: the guide\'s examples are checked against the CLI\'s own option lists', () => {
    const documented = Object.fromEntries(COMMAND_GROUPS.flatMap(([, commands]) => commands.map(([name, options]) => [name, new Set(options.join(' ').match(/--[a-z][a-z0-9-]*/gu))])));
    const used = {};
    for (const block of userGuide().matchAll(/```bash\n([\s\S]*?)\n```/gu)) {
      for (const invocation of block[1].split(/\n\s*\n/u)) {
        const match = /node scripts\/v32-to-v4\/cli\.mjs (\S+)/u.exec(invocation);
        if (!match) continue;
        expect(COMMANDS, `${match[1]} is not a CLI command`).toContain(match[1]);
        (used[match[1]] ??= new Set());
        for (const option of invocation.match(/--[a-z][a-z0-9-]*/gu) ?? []) used[match[1]].add(option);
      }
    }
    // every command appears in the guide's sequence, and every option it shows is one the command accepts
    for (const command of COMMANDS) expect(used[command], `the guide shows no example of ${command}`).toBeDefined();
    for (const [command, options] of Object.entries(used)) for (const option of options) expect(documented[command].has(option), `guide shows ${command} ${option}`).toBe(true);
    // and the steps that used to be missing are there, in order
    const guide = userGuide();
    const order = ['draft-decisions', 'apply-decisions', 'compile-policy', 'plan-relational', 'prepare-target', 'dry-run', 'import', 'validate'].map((command) => guide.indexOf(`cli.mjs ${command}`));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says how to connect through a pooler, what v4 fills in for NULLs, and that earlier decision drafts are stale', () => {
    const guide = userGuide();
    expect(guide).toMatch(/direct \(non-pooled\) connection/u);
    expect(guide).toMatch(/Neon/u);
    expect(guide).toMatch(/set_config/u);
    expect(guide).toMatch(/RMIG-E-SOURCE-DRIFT[^.]*pooler|pooler[^.]*RMIG-E-SOURCE-DRIFT/u);
    expect(guide).toContain('null-replaced-by-v4-default');
    expect(guide).toMatch(/import time/u);
    expect(guide).toMatch(/earlier build[^.]*no longer match/u);
    const runbook = agentRunbook();
    for (const command of ['draft-decisions', 'apply-decisions --reviewed-by', 'plan-relational', 'inspect-target', 'prepare-target']) expect(runbook, command).toContain(command);
    expect(runbook).toMatch(/never its own name/u);
  });

  it('links the new guides from the existing entry points', () => {
    const readme = read('README.md');
    const oldGuide = read('docs/migration-from-mind-cloud.md');
    expect(readme).toContain('[User migration guide](USER_MIGRATION_GUIDE.md)');
    expect(readme).toContain('[Agent migration runbook](AGENT_MIGRATION_RUNBOOK.md)');
    expect(oldGuide).toContain('../USER_MIGRATION_GUIDE.md');
    expect(oldGuide).toContain('../AGENT_MIGRATION_RUNBOOK.md');
  });

  it('says what an empty timestamp or date is, and what a dump that turns foreign keys on gets', () => {
    const guide = userGuide();
    const empty = guide.slice(guide.indexOf('Empty text'), guide.indexOf('Every point-in-time column'));
    for (const word of ['not NULL', 'policy item', 'exclude-row', 'replace-timestamp', 'normalize-date', 'set-null', 'entities.created_at', 'timestamp-reviewed-empty', 'date-reviewed-empty']) expect(empty, word).toContain(word);
    expect(guide).toContain('PRAGMA foreign_keys=ON');
    expect(guide).toMatch(/foreign_keys=ON[^\n]*RMIG-E-D1-SQL-UNSAFE/u);
    expect(agentRunbook()).toContain('foreign-keys-on');
    expect(agentRunbook()).toContain('replace-timestamp');
  });

  it('does not include usable credentials or secret-shaped examples', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^<\[\{\s`]+/iu);
    expect(text).not.toMatch(/(?:api[_-]?key|secret|password|token)\s*[=:]\s*['"](?!<|\[|\{)[^'"`\n]+/iu);
    expect(text).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/u);
    expect(text).toMatch(/env:RMIG_(?:SOURCE|TARGET)/u);
    expect(text).toMatch(/<passphrase-file>/u);
  });
});
