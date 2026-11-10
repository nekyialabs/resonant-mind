import { canonicalJson } from '../lib/canonical-json.mjs';
import { compareCatalog, sourceSpecFor } from '../lib/fingerprint.mjs';
import { MigrationRefusal, isMigrationRefusal } from '../lib/refusal.mjs';
import { createReport, writeReportAtomic } from '../lib/report.mjs';

import { createRequire } from 'node:module';
// The release that wrote the artifact (package.json), so a report says which migrator made it.
const VERSION = createRequire(import.meta.url)('../../../package.json').version;
const DEFAULT_MIGRATION_ID = 'rmig_inspect_source';
const ALLOWED_KINDS = new Set(['postgres', 'sqlite', 'd1-export']);

function refusal(code, summary, safeDetails = {}, reportPath = null) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: reportPath });
}

export function parseInspectSourceArgs(argv) {
  const values = Object.create(null);
  const allowed = new Set(['--source-kind', '--source', '--report']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) throw refusal('RMIG-E-SOURCE-ARG', 'inspect-source requires --source-kind, --source, and --report arguments.');
    values[key] = argv[index + 1];
    index += 1;
  }
  const sourceKind = values['--source-kind'];
  const source = values['--source'];
  const reportPath = values['--report'];
  if (!ALLOWED_KINDS.has(sourceKind) || typeof source !== 'string' || typeof reportPath !== 'string') throw refusal('RMIG-E-SOURCE-ARG', 'inspect-source requires a supported source kind, source, and report path.');
  return { sourceKind, source, reportPath };
}

async function createAdapter(sourceKind, source) {
  if (sourceKind === 'postgres') return (await import('../source/postgres-v32.mjs')).createPostgresV32Adapter({ source });
  if (sourceKind === 'sqlite') return (await import('../source/sqlite-v32.mjs')).createSqliteV32Adapter({ source });
  return (await import('../source/d1-export.mjs')).createD1ExportAdapter({ source });
}

async function tableCount(adapter, table) {
  if (typeof adapter.rowCount === 'function') return String(await adapter.rowCount(table));
  let count = 0;
  for await (const _row of adapter.streamTable(table)) count += 1;
  return String(count);
}

function reportInput({ sourceKind, identity, comparison, tables, ambiguityCounts, imageInventory, embeddingInventory, wranglerMigrations = null, sourceGuard = null, status, timestamp, migrationId }) {
  return {
    migrator_version: VERSION,
    phase: 'inspect-source',
    timestamp,
    migration_id: migrationId,
    status,
    details: {
      source_kind: sourceKind,
      source_identity: identity,
      catalog_match: comparison.match,
      expected_fingerprint: comparison.expectedFingerprint,
      actual_fingerprint: comparison.actualFingerprint,
      catalog_diff: comparison.diff,
      tables,
      ambiguity_counts: ambiguityCounts,
      image_inventory: imageInventory,
      embedding_inventory: embeddingInventory,
      // d1-export only, and only when the export carried wrangler's own bookkeeping table in its exact shape: the
      // names of the migrations wrangler recorded as applied, oldest first. The table itself is set aside: it is
      // not in `tables`, not counted in any row total, and not exported into a bundle.
      ...(wranglerMigrations === null ? {} : { d1_migrations_set_aside: wranglerMigrations }),
      ...(sourceGuard === null ? {} : { source_guard: sourceGuard }),
    },
  };
}

export async function inspectSource({ sourceKind, source, reportPath, adapter: suppliedAdapter, timestamp = new Date().toISOString(), migrationId = DEFAULT_MIGRATION_ID, maxDiffs = 24, adapterFactory = createAdapter } = {}) {
  if (!ALLOWED_KINDS.has(sourceKind) || typeof reportPath !== 'string' || reportPath.length === 0) throw refusal('RMIG-E-SOURCE-ARG', 'inspect-source requires a supported source kind and report path.');
  const adapter = suppliedAdapter ?? await adapterFactory(sourceKind, source);
  let reportWritten = false;
  let snapshotStarted = false;
  try {
    await adapter.beginSnapshot();
    snapshotStarted = true;
    const identity = await adapter.identity();
    const actualCatalog = await adapter.catalog();
    const comparison = compareCatalog(actualCatalog, sourceSpecFor(sourceKind === 'd1-export' ? 'sqlite' : sourceKind), { maxDiffs });
    if (!comparison.match) {
      const report = createReport({ ...reportInput({ sourceKind, identity, comparison, tables: [], ambiguityCounts: {}, imageInventory: {}, embeddingInventory: [], status: 'refused', timestamp, migrationId }) });
      writeReportAtomic(reportPath, report);
      reportWritten = true;
      throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The source catalog is not the exact supported v3.2 schema.', { source_kind: sourceKind, expected_fingerprint: comparison.expectedFingerprint, actual_fingerprint: comparison.actualFingerprint, diff: comparison.diff }, reportPath);
    }
    // Outside the fingerprint, which is unchanged: what it cannot see (CHECK, collations, generated columns, ...).
    const guardFindings = typeof adapter.sourceGuard === 'function' ? await adapter.sourceGuard() : [];
    if (guardFindings.length > 0) {
      const report = createReport({ ...reportInput({ sourceKind, identity, comparison, tables: [], ambiguityCounts: {}, imageInventory: {}, embeddingInventory: [], sourceGuard: guardFindings, status: 'refused', timestamp, migrationId }) });
      writeReportAtomic(reportPath, report);
      reportWritten = true;
      throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The source has a CHECK constraint, collation, generated column or other schema feature the fingerprint cannot see, so it is not the exact v3.2 schema.', { source_kind: sourceKind, findings: guardFindings.slice(0, 24), finding_count: guardFindings.length }, reportPath);
    }
    const tables = [];
    for (const table of actualCatalog.tables) tables.push({ name: table.name, row_count: await tableCount(adapter, table.name) });
    const ambiguityCounts = typeof adapter.ambiguityCounts === 'function' ? await adapter.ambiguityCounts() : { duplicate_entity_names: 0, ambiguous_timestamps: 0, invalid_json: 0 };
    const imageInventory = typeof adapter.imageInventory === 'function' ? await adapter.imageInventory() : { row_count: tables.find((item) => item.name === 'images')?.row_count ?? '0' };
    const embeddingInventory = typeof adapter.embeddingInventory === 'function' ? await adapter.embeddingInventory() : [];
    const wranglerMigrations = typeof adapter.wranglerMigrations === 'function' ? await adapter.wranglerMigrations() : null;
    const report = createReport({ ...reportInput({ sourceKind, identity, comparison, tables, ambiguityCounts, imageInventory, embeddingInventory, wranglerMigrations, status: 'succeeded', timestamp, migrationId }) });
    writeReportAtomic(reportPath, report);
    reportWritten = true;
    return report;
  } catch (error) {
    if (isMigrationRefusal(error)) {
      if (!reportWritten) {
        const emptyComparison = { match: false, expectedFingerprint: null, actualFingerprint: null, diff: [] };
        try {
          const report = createReport({ ...reportInput({ sourceKind, identity: {}, comparison: emptyComparison, tables: [], ambiguityCounts: {}, imageInventory: {}, embeddingInventory: [], status: 'refused', timestamp, migrationId }) });
          writeReportAtomic(reportPath, report);
          reportWritten = true;
        } catch { /* preserve the original structured refusal */ }
      }
      if (error.report_path === null && reportWritten) throw refusal(error.code, error.summary, error.safe_details, reportPath);
    }
    throw error;
  } finally {
    if (snapshotStarted || typeof adapter.endSnapshot === 'function') {
      try { await adapter.endSnapshot(); } catch { /* preserve the primary operation result */ }
    }
    try { await adapter.close(); } catch (error) { if (!reportWritten) throw error; }
  }
}

export function humanInspectReport(report, reportPath = null) {
  const details = report.details;
  const totalRows = details.tables.reduce((total, table) => total + BigInt(table.row_count), 0n).toString(10);
  const path = reportPath === null ? '' : `Report: ${reportPath}`;
  return `inspect-source: supported ${details.source_kind}; tables=${details.tables.length}; rows=${totalRows}; images=${details.image_inventory.row_count ?? '0'}; embeddings=${details.embedding_inventory.length}; ambiguity=${canonicalJson(details.ambiguity_counts)}${path === '' ? '' : `; ${path}`}\n`;
}
