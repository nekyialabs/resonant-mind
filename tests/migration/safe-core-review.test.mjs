import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1ExportAdapter } from '../../scripts/v32-to-v4/source/d1-export.mjs';
import { parseIndexDefinition, createPostgresV32Adapter, POSTGRES_CATALOG_QUERIES } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { createBundle, verifyBundle } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { validateManifest } from '../../scripts/v32-to-v4/lib/contracts.mjs';
import { sourceSpecFor, fingerprintCatalog } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { parseExportArgs } from '../../scripts/v32-to-v4/commands/export.mjs';
import { parseVerifyBundleArgs } from '../../scripts/v32-to-v4/commands/verify-bundle.mjs';
import { scanRows } from '../../scripts/v32-to-v4/lib/secret-scan.mjs';

function sqlFile(text) {
  const directory = mkdtempSync(join(tmpdir(), 'rm-safe-review-sql-'));
  const path = join(directory, 'export.sql');
  writeFileSync(path, text);
  return path;
}

function fullCatalogAdapter(rows = [{ id: 1, content: 'ok' }]) {
  return {
    beginSnapshot() {}, endSnapshot() {}, close() {}, identity() { return {}; },
    catalog() { return sourceSpecFor('sqlite'); },
    async *streamTable() { for (const row of rows) yield row; },
  };
}

const FP = fingerprintCatalog(sourceSpecFor('sqlite'));

it('rejects D1 ATTACH before SQLite can mutate an external database', () => {
  const root = mkdtempSync(join(tmpdir(), 'rm-d1-escape-'));
  const external = join(root, 'external.sqlite');
  const externalDb = new DatabaseSync(external);
  externalDb.exec('CREATE TABLE outside (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO outside VALUES (1, \'before\');');
  externalDb.close();
  const before = readFileSync(external);
  const source = sqlFile(`ATTACH DATABASE '${external.replaceAll("'", "''")}' AS ext; INSERT INTO ext.outside VALUES (2, 'after');`);
  expect(() => createD1ExportAdapter({ source })).toThrow(/attach|external|unsupported|safe/i);
  expect(readFileSync(external)).toEqual(before);
  const verifyDb = new DatabaseSync(external, { readOnly: true });
  expect(verifyDb.prepare('SELECT id, value FROM outside ORDER BY id').all()).toEqual([{ id: 1, value: 'before' }]);
  verifyDb.close();
});

it('tokenizes D1 comments and quoted literals without treating keywords as statements', () => {
  const source = sqlFile(`-- ATTACH 'not executed'\nCREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO entities VALUES (1, 'VACUUM INTO; -- literal');`);
  const adapter = createD1ExportAdapter({ source });
  expect(adapter).toBeTruthy();
  adapter.close();
});

it('parses the tagged ivfflat index definition without swallowing opclass or options', () => {
  expect(parseIndexDefinition('CREATE INDEX idx_embeddings_vector ON public.embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)')).toEqual({
    columns: ['embedding'],
    expressions: [],
    opclass: 'vector_cosine_ops',
    where: null,
    options: 'lists = 100',
  });
});

it('schema-qualifies Postgres row and count reads and ignores hostile search_path', async () => {
  const queries = [];
  const fake = {
    async connect() {},
    async end() {},
    async query(text, values = []) {
      queries.push({ text, values });
      if (/SHOW transaction_read_only/u.test(text)) return { rows: [{ transaction_read_only: 'on' }] };
      if (/current_setting\('TimeZone'\)/u.test(text)) return { rows: [{ timezone: 'UTC', datestyle: 'ISO, YMD', search_path: 'public', extra_float_digits: '1' }] };
      if (/^SELECT \*/u.test(text)) return { rows: [] };
      if (/count\(\*\)/u.test(text)) return { rows: [{ row_count: '0' }] };
      return { rows: [] };
    },
  };
  const adapter = createPostgresV32Adapter({ source: 'env:URL', env: { URL: 'postgres://safe' }, clientFactory: () => fake, batchSize: 2 });
  await adapter.beginSnapshot();
  await adapter.rowCount('entities');
  for await (const _row of adapter.streamTable('entities', ['id'])) {}
  await adapter.close();
  const reads = queries.filter(({ text }) => /^SELECT \*/u.test(text) || /count\(\*\)/u.test(text));
  expect(reads.every(({ text }) => text.includes('"public"."entities"'))).toBe(true);
  expect(reads.every(({ text }) => !/FROM "entities"|FROM entities/u.test(text))).toBe(true);
});

it('exports and verifies every required v1 bundle artifact and rejects omissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rm-required-bundle-'));
  const passphrase = join(root, 'passphrase');
  writeFileSync(passphrase, 'review-passphrase', { mode: 0o600 });
  const result = await createBundle({
    adapter: fullCatalogAdapter(), sourceKind: 'sqlite', sourceFingerprint: FP,
    migrationId: 'rmig_safe_core_bundle', timestamp: '2026-09-20T00:00:00.000Z',
    outputPath: join(root, 'bundle'), env: { RM_MIGRATION_PASSPHRASE_FILE: passphrase },
  });
  expect(readFileSync(join(result.path, 'envelope.json'), 'utf8')).toContain('migration_id');
  expect(result.manifest.members.map(({ name }) => name)).toEqual(expect.arrayContaining([
    'source-report.json.enc', 'policy-template.json.enc', 'external/images.json.enc', 'external/reembed-jobs.ndjson.enc',
  ]));
  expect(verifyBundle({ path: result.path, env: { RM_MIGRATION_PASSPHRASE_FILE: passphrase } }).ok).toBe(true);
  const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json')));
  manifest.members = manifest.members.filter(({ name }) => name !== 'policy-template.json.enc');
  expect(() => validateManifest(manifest)).toThrow(/required|policy/i);
}, 120_000);

it('uses the documented CLI bundle and passphrase-file flags only', () => {
  expect(parseExportArgs([
    '--source-kind', 'sqlite', '--source', 'db.sqlite', '--migration-id', 'rmig_cli_safe', '--bundle', 'bundle', '--passphrase-file', 'passphrase',
  ])).toMatchObject({ outputPath: 'bundle', passphraseFile: 'passphrase', mode: 'encrypted' });
  expect(() => parseExportArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--migration-id', 'rmig_cli_safe', '--output', 'bundle'])).toThrow();
  expect(() => parseExportArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--migration-id', 'rmig_cli_safe', '--bundle', 'bundle', '--plaintext'])).toThrow();
  expect(parseVerifyBundleArgs(['--bundle', 'bundle', '--passphrase-file', 'passphrase'])).toEqual({ path: 'bundle', passphraseFile: 'passphrase' });
});

it('returns a structured secret refusal when lived-content decisions are missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rm-secret-decision-'));
  const passphrase = join(root, 'passphrase');
  writeFileSync(passphrase, 'review-passphrase', { mode: 0o600 });
  const row = { id: 1, content: 'connect postgres://alice:***@example.test/mind' };
  await expect(createBundle({
    adapter: fullCatalogAdapter([row]), sourceKind: 'sqlite', sourceFingerprint: FP,
    migrationId: 'rmig_safe_core_secret', timestamp: '2026-09-20T00:00:00.000Z',
    outputPath: join(root, 'bundle'), env: { RM_MIGRATION_PASSPHRASE_FILE: passphrase },
  })).rejects.toMatchObject({ code: 'RMIG-E-SECRET-DETECTED' });
  const item = scanRows([row], { table: 'observations', primaryKey: ['id'] }).reviewItems[0];
  expect(item.review_id).toMatch(/^[0-9a-f]{64}$/u);
});