import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { TARGET_SCHEMAS, assertTargetRow } from '../transform/target-schema.mjs';
import { V4_MIGRATION_LOCK_ID, V4_MIGRATOR_VERSION, migrationSetSha256, readV4Migrations } from '../../migrate-postgres.mjs';
import { postgresIdentityFromRow, normalizePostgresIdentity as normalizeIdentityRow } from '../lib/postgres-identity.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const IMPORT_ORDER = Object.freeze(['entities', 'people', 'nodes', 'threads', 'context_entries', 'relational_state', 'identity', 'journals', 'subconscious', 'tensions', 'observations', 'observation_versions', 'relations', 'consolidation_groups', 'images', 'daemon_proposals', 'orphan_observations', 'co_surfacing']);
const SELF_REFERENCE_FIELDS = Object.freeze(['linked_observation_id', 'superseded_by', 'supersedes']);
const REFERENCES = Object.freeze({
  observations: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], linked_observation_id: ['observations'], superseded_by: ['observations'], supersedes: ['observations'] },
  observation_versions: { observation_id: ['observations'] },
  images: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], observation_id: ['observations'] },
  consolidation_groups: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], consolidated_observation_id: ['observations'], source_observation_ids: ['observations'] },
  orphan_observations: { observation_id: ['observations'] },
  co_surfacing: { obs_a_id: ['observations'], obs_b_id: ['observations'] },
  daemon_proposals: { from_obs_id: ['observations'], to_obs_id: ['observations'], from_entity_id: ['entities'], to_entity_id: ['entities'] },
  thread_entities: { thread_id: ['threads'], entity_id: ['entities'] },
});
// The tables of IMPORT_ORDER whose `id` is a serial (default nextval(...)) in migrations/postgres. people and nodes are not here: their
// ids are copied from entities and have no sequence. This list is a cross-check, not the authority: the set that is actually reset and
// validated is read from the target's catalog (readSerialTables), and a disagreement between the two is a refusal, so a table added to
// the schema or to this list alone cannot silently go without its sequence reset (issue #26: relations, consolidation_groups).
export const SERIAL_TABLES = new Set(['entities', 'observations', 'observation_versions', 'relations', 'consolidation_groups', 'relational_state', 'identity', 'journals', 'images', 'subconscious', 'daemon_proposals', 'orphan_observations', 'co_surfacing']);

const SERIAL_CATALOG_QUERY = `
  SELECT c.relname::text AS table_name,
         COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false) AS serial
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
`;
/**
 * Pure reconciliation of the catalog's answer with the static list. `rows` are { table_name, serial } for the IMPORT_ORDER tables that
 * exist and have an id column. Returns the set of serial tables, or refuses when the catalog and the list disagree.
 */
export function serialCatalogDifference(rows, expected = SERIAL_TABLES) {
  const serial = new Set(rows.filter((row) => row.serial === true).map((row) => row.table_name));
  const present = new Set(rows.map((row) => row.table_name));
  const notListed = [...serial].filter((table) => !expected.has(table)).sort();
  const notSerial = [...expected].filter((table) => present.has(table) && !serial.has(table)).sort();
  return { serial, notListed, notSerial };
}
/** The catalog read with no verdict: { serial, notListed, notSerial }. Import refuses on a disagreement (readSerialTables); validate reports it as a finding. */
export async function readSerialCatalog(client) {
  const result = await query(client, SERIAL_CATALOG_QUERY, [[...IMPORT_ORDER]]);
  return serialCatalogDifference(result.rows ?? []);
}
export function reconcileSerialTables(rows, expected = SERIAL_TABLES) {
  const { serial: catalog, notListed, notSerial } = serialCatalogDifference(rows, expected);
  if (notListed.length || notSerial.length) throw refusal('RMIG-E-TARGET-SCHEMA', 'import', 'The target schema and the migrator disagree about which tables have a serial id, so id sequences cannot be reset or checked safely.', { serial_in_target_not_in_migrator: notListed, in_migrator_not_serial_in_target: notSerial });
  return catalog;
}
/** The IMPORT_ORDER tables whose id has a sequence in this target, read from the catalog and cross-checked against SERIAL_TABLES. */
export async function readSerialTables(client) {
  const result = await query(client, SERIAL_CATALOG_QUERY, [[...IMPORT_ORDER]]);
  return reconcileSerialTables(result.rows ?? []);
}

function quoteIdentifier(value) { if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('PostgreSQL identifier is not allowlisted.'); return `"${value}"`; }
function qtable(schema, table) { return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`; }
function refusal(code, phase, summary, safeDetails = {}) { return new MigrationRefusal({ code, phase, summary, safe_details: safeDetails, report_path: null }); }
function requireHash(value, label) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`); }
async function query(client, text, values = []) { if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.'); return client.query(text, values); }

export function normalizePostgresIdentity(row) { return normalizePostgresIdentityRow(row); }
function normalizePostgresIdentityRow(row) { return normalizeIdentityRow(row); }
function identityFromRow(row) { return postgresIdentityFromRow(row); }

export const TARGET_IDENTITY_QUERY = `
  SELECT current_database() AS database_name,
         (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
         inet_server_addr()::text AS server_address,
         inet_server_port()::text AS server_port,
         current_setting('server_version_num') AS server_version
`;
// Freshness is closed-world: every non-system schema, extension and application object must be accounted
// for. The one thing it must not count is another session's temporary objects. pg_temp_N and
// pg_toast_temp_N are the per-session temporary schemas, which PostgreSQL itself reserves (a user cannot
// create a schema whose name starts with pg_), and a temporary table is dropped when its session ends,
// so a concurrent session's temp table must not make an empty database look used. Nothing else is
// hidden by that: a temp schema is ignored only for objects that are themselves temporary (a relation
// with relpersistence 't'; functions and types that live in a temp schema), so a persistent relation
// that somehow sat in one would still be listed and refused.
export const TARGET_OBJECT_QUERY = `
  /* non_system_objects */
  WITH scanned_schemas AS (
    SELECT n.oid, n.nspname::text AS nspname, (n.nspname ~ '^pg_temp_[0-9]+$' OR n.nspname ~ '^pg_toast_temp_[0-9]+$') AS is_temp
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ), user_schemas AS (
    SELECT oid, nspname FROM scanned_schemas WHERE NOT is_temp
  ), extension_list AS (
    SELECT e.extname, n.nspname AS schema_name
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  ), app_objects AS (
    SELECT n.nspname AS schema_name, c.relname AS object_name, 'relation' AS object_kind
    FROM scanned_schemas n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT (n.is_temp AND c.relpersistence = 't')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT n.nspname, p.proname, 'routine'
    FROM scanned_schemas n JOIN pg_catalog.pg_proc p ON p.pronamespace = n.oid
    WHERE NOT n.is_temp
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT n.nspname, t.typname, 'type'
    FROM scanned_schemas n JOIN pg_catalog.pg_type t ON t.typnamespace = n.oid
    WHERE NOT n.is_temp AND t.typrelid = 0 AND t.typtype IN ('c', 'd', 'e')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  )
  SELECT true AS inventory_complete,
         COALESCE((SELECT array_agg(nspname::text ORDER BY nspname) FROM user_schemas), ARRAY[]::text[]) AS schemas,
         COALESCE((SELECT array_agg(extname::text ORDER BY extname) FROM extension_list), ARRAY[]::text[]) AS extensions,
         COALESCE((SELECT array_agg(schema_name::text ORDER BY schema_name) FROM extension_list WHERE extname = 'vector'), ARRAY[]::text[]) AS vector_schemas,
         (SELECT count(*)::text FROM app_objects) AS object_count,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('schema', schema_name, 'name', object_name, 'kind', object_kind) ORDER BY schema_name, object_kind, object_name) FROM app_objects), '[]'::jsonb) AS objects
`;
export const TARGET_VECTOR_QUERY = `SELECT (EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'vector') OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector')) AS available`;
export const TARGET_STATE_QUERY = `
  /* target_state */
  SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind AS object_kind
  FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ORDER BY c.relkind, c.relname
`;

export async function readIdentityInTransaction(client) { const result = await query(client, TARGET_IDENTITY_QUERY); return identityFromRow(result.rows?.[0] ?? {}); }
export async function readTargetIdentity({ client } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { const readOnly = await query(client, 'SHOW transaction_read_only'); if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target identity read could not prove a read-only transaction.'); return await readIdentityInTransaction(client); }
  finally { try { await query(client, 'ROLLBACK'); } catch { /* preserve identity error */ } }
}

export async function readTargetState({ client } = {}) {
  const catalog = await query(client, TARGET_STATE_QUERY);
  const rows = (catalog.rows ?? []).map((row) => ({ schema_name: row.schema_name, object_name: row.object_name, object_kind: row.object_kind }));
  const tables = rows.filter((row) => ['r', 'p'].includes(row.object_kind));
  const counts = [];
  for (const table of tables) {
    const count = await query(client, `SELECT count(*)::text AS row_count FROM ${qtable(table.schema_name, table.object_name)}`);
    counts.push({ ...table, row_count: String(count.rows?.[0]?.row_count ?? '0') });
  }
  return Object.freeze({ objects: rows, counts: counts.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) });
}

export async function inspectTarget({ client, sourceIdentity } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const readOnly = await query(client, 'SHOW transaction_read_only');
    if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target preflight could not prove a read-only transaction.');
    const targetIdentity = await readIdentityInTransaction(client);
    if (sourceIdentity?.database_identity_sha256 === targetIdentity.database_identity_sha256) throw refusal('RMIG-E-SAME-SOURCE-TARGET', 'inspect-target', 'Source and target resolve to the same PostgreSQL database.');
    const objectResult = await query(client, TARGET_OBJECT_QUERY);
    const objectRow = objectResult.rows?.[0];
    const inventoryComplete = objectRow?.inventory_complete === true || String(objectRow?.inventory_complete).toLowerCase() === 't';
    const schemas = objectRow?.schemas;
    const extensions = objectRow?.extensions;
    const vectorSchemas = objectRow?.vector_schemas;
    const objects = objectRow?.objects;
    const objectCount = Number(objectRow?.object_count);
    if (!inventoryComplete || !Array.isArray(schemas) || !Array.isArray(extensions) || !Array.isArray(vectorSchemas) || !Array.isArray(objects) || !Number.isSafeInteger(objectCount) || objectCount < 0 || objectCount !== objects.length) throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target catalog inventory was incomplete or internally inconsistent; refusing closed-world freshness.');
    const disallowedExtensions = extensions.filter((name) => !['plpgsql', 'vector'].includes(name));
    const allowedSchemas = new Set(['public', ...vectorSchemas]);
    const disallowedSchemas = schemas.filter((name) => typeof name !== 'string' || !allowedSchemas.has(name));
    if (disallowedExtensions.length || disallowedSchemas.length || objectCount !== 0) throw refusal('RMIG-E-TARGET-NOT-FRESH', 'inspect-target', 'Target PostgreSQL database has user schemas, unrelated extensions, or application objects; required vector extension objects alone are allowed.', { object_count: objectCount, schemas: disallowedSchemas, extensions: disallowedExtensions, objects });
    const vectorResult = await query(client, TARGET_VECTOR_QUERY);
    if (vectorResult.rows?.[0]?.available !== true && String(vectorResult.rows?.[0]?.available).toLowerCase() !== 't') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target PostgreSQL database does not provide pgvector.');
    return Object.freeze({ target_identity: targetIdentity, object_count: 0, schemas: [], pgvector: true, read_only_proven: true });
  } finally { try { await query(client, 'ROLLBACK'); } catch { /* preserve refusal */ } }
}

function stagingName(migrationId, bundleHash) { const id = String(migrationId).replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 28); return `rmig_${id}_${bundleHash.slice(0, 16)}`.slice(0, 63); }
export function stageContentSha256(members) { return canonicalSha256(Object.fromEntries(Object.entries(members ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => [table, rows ?? []]))); }
function planEnvelope(plan, { migrationSetSha256: setHash, migratorVersion } = {}) {
  const { plan_sha256: _ignoredHash, plan_payload_sha256: _ignoredPayloadHash, migration_set_sha256: _ignoredSetHash, migrator_version: _ignoredVersion, ...payload } = plan ?? {};
  if (setHash !== undefined) payload.migration_set_sha256 = setHash;
  if (migratorVersion !== undefined) payload.migrator_version = migratorVersion;
  return payload;
}
function planPayloadSha256(plan) { return canonicalSha256(planEnvelope(plan)); }
function boundPlanSha256(plan, fields) { return canonicalSha256(planEnvelope(plan, fields)); }
export function bindRelationalPlan(plan, { migrationSetSha256: setHash, migratorVersion = V4_MIGRATOR_VERSION } = {}) {
  requireHash(setHash, 'migrationSetSha256');
  if (typeof migratorVersion !== 'string' || migratorVersion.length === 0) throw new TypeError('migratorVersion is required.');
  const payloadHash = plan.plan_payload_sha256 ?? planPayloadSha256(plan);
  if (plan.plan_payload_sha256 !== undefined && plan.plan_payload_sha256 !== payloadHash) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'bind-plan', 'The relational payload hash is invalid.');
  const bound = { ...plan, migration_set_sha256: setHash, migrator_version: migratorVersion, plan_payload_sha256: payloadHash };
  bound.plan_sha256 = boundPlanSha256(bound, { migrationSetSha256: setHash, migratorVersion });
  return Object.freeze(bound);
}
function stageMetadataFields({ migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256, migrationSetSha256: setHash, migratorVersion, planSha256: hash, stageContentSha256: contentHash }) { return [migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256, setHash, migratorVersion, hash, contentHash, 'prepared']; }

function insertSql(table, row, schema = 'public') {
  const keys = Object.keys(row);
  if (!TARGET_SCHEMAS[table] || keys.length === 0) throw new TypeError(`Unsupported or empty row for target table ${table}.`);
  return { text: `INSERT INTO ${qtable(schema, table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${keys.map((_key, index) => `$${index + 1}`).join(', ')})`, values: keys.map((key) => row[key]) };
}

async function createStaging(client, schemaName, fields) {
  await query(client, `CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await query(client, `REVOKE ALL ON SCHEMA ${quoteIdentifier(schemaName)} FROM PUBLIC`);
  await query(client, `CREATE TABLE ${qtable(schemaName, 'run_metadata')} (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, migration_set_sha256 TEXT NOT NULL, migrator_version TEXT NOT NULL, plan_sha256 TEXT NOT NULL, stage_content_sha256 TEXT NOT NULL, dry_run_receipt_sha256 TEXT, target_state_sha256 TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(client, `INSERT INTO ${qtable(schemaName, 'run_metadata')} (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, stageMetadataFields(fields));
}

async function stagePlan(client, schemaName, plan, fields) {
  if (!plan || !plan.members) throw new TypeError('The staging plan must contain members.');
  if (plan.bundle_manifest_sha256 !== fields.bundleManifestSha256 || plan.compiled_policy_sha256 !== fields.compiledPolicySha256 || plan.migration_id !== fields.migrationId) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'The staging plan is not bound to the requested migration inputs.');
  const bound = bindRelationalPlan(plan, { migrationSetSha256: fields.migrationSetSha256, migratorVersion: fields.migratorVersion });
  if (plan.plan_sha256 !== undefined && plan.plan_sha256 !== planPayloadSha256(plan) && plan.plan_sha256 !== bound.plan_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'The staging plan hash is invalid.');
  const members = bound.members;
  const contentHash = stageContentSha256(members);
  for (const table of Object.keys(members).sort()) {
    if (!TARGET_SCHEMAS[table]) throw new TypeError(`Unsupported staging table ${table}.`);
    await query(client, `DROP TABLE IF EXISTS ${qtable(schemaName, table)}`);
    await query(client, `CREATE TABLE ${qtable(schemaName, table)} (LIKE public.${quoteIdentifier(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    for (const row of members[table] ?? []) {
      assertTargetRow(table, row);
      const physicalRow = table === 'identity' && row.kind === undefined ? { ...row, kind: String(row.section).split('.')[0].replace(/[^a-z0-9_]+/giu, '_').toLowerCase() } : row;
      const insert = insertSql(table, physicalRow, schemaName);
      await query(client, insert.text, insert.values);
    }
  }
  await query(client, `DROP TABLE IF EXISTS ${qtable(schemaName, 'run_rows')}`);
  await query(client, `CREATE TABLE ${qtable(schemaName, 'run_rows')} (table_name TEXT NOT NULL, row_index INTEGER NOT NULL, row_json JSONB NOT NULL, row_sha256 TEXT NOT NULL, PRIMARY KEY (table_name, row_index))`);
  for (const table of Object.keys(members).sort()) for (const [index, row] of (members[table] ?? []).entries()) await query(client, `INSERT INTO ${qtable(schemaName, 'run_rows')} (table_name, row_index, row_json, row_sha256) VALUES ($1, $2, $3::jsonb, $4)`, [table, index, canonicalJson(row), canonicalSha256(row)]);
  await query(client, `UPDATE ${qtable(schemaName, 'run_metadata')} SET plan_sha256 = $1, stage_content_sha256 = $2, status = $3, updated_at = NOW() WHERE migration_id = $4`, [bound.plan_sha256, contentHash, 'staged', fields.migrationId]);
  return { plan_sha256: bound.plan_sha256, stage_content_sha256: contentHash };
}

async function readStagedMembers(client, schemaName, tables) {
  const result = await query(client, `SELECT table_name, row_index, row_json, row_sha256 FROM ${qtable(schemaName, 'run_rows')} ORDER BY table_name, row_index`);
  const members = {};
  for (const row of result.rows ?? []) {
    const value = typeof row.row_json === 'string' ? JSON.parse(row.row_json) : row.row_json;
    if (row.row_sha256 !== canonicalSha256(value)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged row content hash is invalid.');
    (members[row.table_name] ??= []).push(value);
  }
  for (const table of tables) members[table] ??= [];
  return members;
}

export async function ledgerBinding(client) {
  const migrations = await readV4Migrations();
  const result = await query(client, 'SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  const rows = result.rows ?? [];
  const expected = new Map(migrations.map(({ file, checksum }) => [file, checksum]));
  if (rows.length !== migrations.length || rows.some((row) => expected.get(row.version) !== row.checksum)) throw refusal('RMIG-E-TARGET-SCHEMA', 'prepare-target', 'Target v4 ledger is not the exact current migration checksum set.');
  return { migration_set_sha256: migrationSetSha256(migrations), migrator_version: V4_MIGRATOR_VERSION, migrations };
}

export async function prepareTarget({ client, migrationRunner, sourceIdentity, migrationId, bundleManifestSha256, compiledPolicySha256, resumeSchema, plan } = {}) {
  requireHash(bundleManifestSha256, 'bundleManifestSha256'); requireHash(compiledPolicySha256, 'compiledPolicySha256');
  if (typeof migrationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(migrationId)) throw new TypeError('migrationId is invalid.');
  if (resumeSchema !== undefined) throw refusal('RMIG-E-TARGET-NOT-FRESH', 'prepare-target', 'General resume is unsupported; discard the interrupted target and restart against a fresh target.');
  const target = await inspectTarget({ client, sourceIdentity });
  const targetIdentity = target.target_identity; requireHash(targetIdentity.database_identity_sha256, 'target identity');
  const schemaName = stagingName(migrationId, bundleManifestSha256);
  if (!migrationRunner || typeof migrationRunner.run !== 'function') throw new TypeError('prepareTarget requires the immutable v4 migration runner.');
  const migrations = await readV4Migrations();
  const ledger = { migration_set_sha256: migrationSetSha256(migrations), migrator_version: V4_MIGRATOR_VERSION };
  const boundPlan = plan ? bindRelationalPlan(plan, { migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version }) : null;
  const planHash = boundPlan?.plan_sha256 ?? canonicalSha256({ migrationId });
  const contentHash = boundPlan ? stageContentSha256(boundPlan.members) : canonicalSha256({});
  let created = false; let runnerCompleted = false;
  try {
    await createStaging(client, schemaName, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256: targetIdentity.database_identity_sha256, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version, planSha256: planHash, stageContentSha256: contentHash });
    created = true;
    await migrationRunner.run({ atomic: true });
    runnerCompleted = true;
    await ledgerBinding(client);
    await query(client, `CREATE TABLE IF NOT EXISTS public.migration_import_receipts (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, migration_set_sha256 TEXT NOT NULL, migrator_version TEXT NOT NULL, plan_sha256 TEXT NOT NULL, stage_content_sha256 TEXT NOT NULL, target_state_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, status TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    if (plan) await stagePlan(client, schemaName, plan, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256: targetIdentity.database_identity_sha256, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version });
    return Object.freeze({ schema: schemaName, target_identity: targetIdentity, status: plan ? 'staged' : 'prepared', resumed: false, hashes: { bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256, migration_set_sha256: ledger.migration_set_sha256, migrator_version: ledger.migrator_version } });
  } catch (error) {
    // The runner is atomic. If it completed, retain the hash-bound staging
    // schema for inspection; interrupted runs restart on a fresh target.
    if (created && !runnerCompleted) { try { await query(client, `DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* preserve original failure */ } }
    throw error;
  }
}

function tableRows(plan) { return plan?.members && typeof plan.members === 'object' ? plan.members : {}; }
function idSet(rows) { return new Set((rows ?? []).map((row) => String(row.id))); }
function hasRef(plan, tables, value) { return tables.some((table) => idSet(plan.members?.[table]).has(String(value))); }
function validationFor(plan) {
  const members = tableRows(plan); const foreignKeys = []; const uniqueness = []; const enums = [];
  for (const [table, fields] of Object.entries(REFERENCES)) for (const row of members[table] ?? []) for (const [field, targets] of Object.entries(fields)) {
    const values = field === 'source_observation_ids' ? (row[field] ?? []) : [row[field]];
    for (const value of values) if (value !== null && value !== undefined && !hasRef(plan, targets, value)) foreignKeys.push({ table, field, value, row_sha256: canonicalSha256(row) });
  }
  const uniqueColumns = { co_surfacing: ['obs_a_id', 'obs_b_id'], orphan_observations: ['observation_id'], thread_entities: ['thread_id', 'entity_id', 'role'] };
  for (const [table, rows] of Object.entries(members)) {
    const seen = new Set();
    for (const row of rows) {
      const keys = [];
      if (Object.hasOwn(row, 'id')) keys.push(['id', row.id]);
      if (uniqueColumns[table]) keys.push(['unique', uniqueColumns[table].map((field) => row[field])]);
      for (const [kind, value] of keys) { const key = `${kind}:${canonicalJson(value)}`; if (seen.has(key)) uniqueness.push({ table, key, row_sha256: canonicalSha256(row) }); seen.add(key); }
    }
    const target = TARGET_SCHEMAS[table];
    if (!target) { enums.push({ table, reason: 'unsupported target table' }); continue; }
    for (const row of rows) {
      try { assertTargetRow(table, row); } catch (error) { enums.push({ table, reason: error.message, row_sha256: canonicalSha256(row) }); }
    }
  }
  return { foreign_keys: { violations: foreignKeys.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, uniqueness: { violations: uniqueness.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, enums: { violations: enums.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, routing: { violations: routingViolations(members) } };
}

export function validateRelationalPlan(plan) { return validationFor(plan); }

export function buildDryRunReport({ plan, targetIdentity, migrationSetSha256: setHash, migratorVersion = V4_MIGRATOR_VERSION, stageContentSha256: contentHash, targetStateSha256: stateHash, status = 'validated' } = {}) {
  if (!plan || !plan.members) throw new TypeError('A relational staging plan is required.');
  requireHash(plan.bundle_manifest_sha256, 'plan.bundle_manifest_sha256'); requireHash(plan.compiled_policy_sha256, 'plan.compiled_policy_sha256'); requireHash(targetIdentity?.database_identity_sha256, 'target identity');
  const members = tableRows(plan); const counts = { tables: {} };
  for (const table of Object.keys(members).sort()) { const coverage = plan.coverage?.[table] ?? {}; counts.tables[table] = { source_rows: coverage.source_rows ?? members[table].length, transformed_rows: coverage.transformed_rows ?? coverage.mapped_rows ?? members[table].length, excluded_rows: coverage.excluded_rows ?? 0, rows: members[table].length, sha256: canonicalSha256(members[table]) }; }
  const losses = Array.isArray(plan.losses) ? plan.losses : [];
  const boundHash = setHash && migratorVersion ? boundPlanSha256(plan, { migrationSetSha256: setHash, migratorVersion }) : (plan.plan_sha256 ?? planPayloadSha256(plan));
  const report = { format_version: 1, receipt_type: 'fresh-v4-dry-run', report_type: 'fresh-v4-dry-run', status, migration_id: plan.migration_id, bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256, migration_set_sha256: setHash ?? plan.migration_set_sha256 ?? null, migrator_version: migratorVersion, plan_sha256: boundHash, stage_content_sha256: contentHash ?? stageContentSha256(members), target_identity_sha256: targetIdentity.database_identity_sha256, target_state_sha256: stateHash ?? null, counts, validation: validationFor(plan), losses: { count: losses.length, sha256: canonicalSha256(losses), entries: losses } };
  report.receipt_sha256 = canonicalSha256(report); return Object.freeze(report);
}

export function buildImportReceipt({ plan, dryRun, targetIdentity, insertedRows = 0 } = {}) {
  if (!plan || !dryRun || !targetIdentity?.database_identity_sha256) throw new TypeError('An import receipt requires a plan, dry-run receipt, and target identity.');
  if (dryRun.migration_id !== plan.migration_id || dryRun.bundle_manifest_sha256 !== plan.bundle_manifest_sha256 || dryRun.compiled_policy_sha256 !== plan.compiled_policy_sha256 || dryRun.target_identity_sha256 !== targetIdentity.database_identity_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Import receipt inputs are not bound to the dry-run receipt.');
  const receipt = { format_version: 1, receipt_type: 'fresh-v4-import', status: 'complete', migration_id: plan.migration_id, bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256, target_identity_sha256: targetIdentity.database_identity_sha256, migration_set_sha256: dryRun.migration_set_sha256, migrator_version: dryRun.migrator_version, plan_sha256: dryRun.plan_sha256, stage_content_sha256: dryRun.stage_content_sha256, target_state_sha256: dryRun.target_state_sha256, dry_run_receipt_sha256: dryRun.receipt_sha256, inserted_rows: insertedRows };
  receipt.receipt_sha256 = canonicalSha256(receipt);
  return Object.freeze(receipt);
}

function verifyDryRun(plan, dryRun, targetIdentity) {
  if (!dryRun || dryRun.status !== 'validated' || !dryRun.migration_set_sha256 || !dryRun.migrator_version || !dryRun.plan_sha256 || !dryRun.stage_content_sha256 || !dryRun.target_state_sha256) throw refusal('RMIG-E-DRY-RUN', 'import', 'Import requires a successful bound PostgreSQL dry-run receipt.');
  const expected = buildDryRunReport({ plan, targetIdentity, migrationSetSha256: dryRun.migration_set_sha256, migratorVersion: dryRun.migrator_version, stageContentSha256: dryRun.stage_content_sha256, targetStateSha256: dryRun.target_state_sha256, status: 'validated' });
  if (dryRun.receipt_sha256 !== expected.receipt_sha256 || canonicalJson(dryRun) !== canonicalJson(expected)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Dry-run receipt does not match the exact import inputs.');
  if (dryRun.validation.foreign_keys.violations.length || dryRun.validation.uniqueness.violations.length || dryRun.validation.enums.violations.length || dryRun.validation.routing.violations.length) throw refusal('RMIG-E-VALIDATION', 'import', 'Dry-run validation found rows that cannot be imported.');
}

function triggerKind(entity) {
  if (['peer_AI', 'AI peer'].includes(entity.entity_type)) return 'peer_ai';
  if (entity.entity_type === 'kin') return 'person';
  return entity.entity_type;
}
function triggerTable(entity) { return ['self', 'person', 'peer_ai', 'peer_AI', 'AI peer', 'kin'].includes(entity.entity_type) ? 'people' : 'nodes'; }
function routingViolations(members) {
  const entities = members.entities ?? [];
  const routed = [...(members.people ?? []).map((row) => ({ table: 'people', row })), ...(members.nodes ?? []).map((row) => ({ table: 'nodes', row }))];
  const violations = [];
  const expectedIds = new Set();
  for (const entity of entities) {
    expectedIds.add(String(entity.id));
    if (entity.created_at === undefined || entity.updated_at === undefined) { violations.push({ id: entity.id, reason: 'trigger timestamps are not hash-bound' }); continue; }
    const expected = { id: entity.id, name: entity.name, kind: triggerKind(entity), salience: entity.salience ?? 'active', primary_context: entity.primary_context ?? 'default', created_at: entity.created_at, updated_at: entity.updated_at };
    const matches = routed.filter(({ table, row }) => String(row.id) === String(entity.id));
    if (matches.length !== 1 || matches[0].table !== triggerTable(entity) || canonicalJson(matches[0].row) !== canonicalJson(expected)) violations.push({ id: entity.id, expected, actual: matches.map(({ table, row }) => ({ table, row })) });
  }
  for (const item of routed) if (!expectedIds.has(String(item.row.id))) violations.push({ id: item.row.id, reason: 'extra people/nodes row', actual: item });
  return violations.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}
function compatibilityCheck(members) {
  const entities = members.entities ?? [];
  if (entities.length === 0) throw refusal('RMIG-E-ENTITY-COMPAT', 'import', 'Fresh-v4 import requires public.entities compatibility rows for released foreign keys and routing triggers.');
  const violations = routingViolations(members);
  if (violations.length) throw refusal('RMIG-E-ENTITY-COMPAT', 'import', 'Staged people/nodes rows are not exactly the rows released entities triggers generate.', { violations });
}

async function insertRows(client, table, rows) {
  const deferred = [];
  for (const row of rows) {
    assertTargetRow(table, row);
    const initial = { ...row };
    if (table === 'observations') for (const field of SELF_REFERENCE_FIELDS) { if (Object.hasOwn(initial, field)) deferred.push({ id: initial.id, field, value: initial[field] }); delete initial[field]; }
    const insert = insertSql(table, initial); await query(client, insert.text, insert.values);
  }
  for (const item of deferred) await query(client, `UPDATE public.${quoteIdentifier(table)} SET ${quoteIdentifier(item.field)} = $1 WHERE id = $2`, [item.value, item.id]);
  return rows.length;
}
export async function resetSequence(client, table, serialTables = undefined) {
  if (serialTables !== undefined && !serialTables.has(table)) return; // the set comes from the catalog; without one, pg_get_serial_sequence below decides
  const sequence = await query(client, `
    SELECT n.nspname AS schema_name, c.relname AS sequence_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = pg_get_serial_sequence($1, $2)::regclass
  `, [`public.${table}`, 'id']);
  const sequenceRow = sequence.rows?.[0];
  if (!sequenceRow) return;
  const maximum = await query(client, `SELECT COALESCE(MAX(id), 0)::text AS max_id FROM public.${quoteIdentifier(table)}`);
  const maxId = Number(maximum.rows?.[0]?.max_id ?? 0);
  if (!Number.isSafeInteger(maxId) || maxId < 0 || maxId === Number.MAX_SAFE_INTEGER) throw refusal('RMIG-E-TARGET-SCHEMA', 'import', `Cannot safely compute the next ${table} sequence value.`);
  await query(client, `ALTER SEQUENCE ${qtable(sequenceRow.schema_name, sequenceRow.sequence_name)} RESTART WITH ${maxId + 1}`);
}

async function validateOnTarget(client, members) {
  await query(client, 'BEGIN');
  try {
    await query(client, 'SELECT pg_advisory_xact_lock($1)', [V4_MIGRATION_LOCK_ID]);
    compatibilityCheck(members);
    let inserted = 0;
    for (const table of IMPORT_ORDER) {
      if (table === 'people' || table === 'nodes') continue; // entities trigger exactly one routed compatibility row
      inserted += await insertRows(client, table, members[table] ?? []);
    }
    await query(client, 'ROLLBACK');
    return inserted;
  } catch (error) { try { await query(client, 'ROLLBACK'); } catch { /* preserve validation error */ } throw error; }
}

export async function dryRunStaging({ client, plan, stagingSchema, targetIdentity } = {}) {
  if (typeof stagingSchema !== 'string' || !IDENTIFIER.test(stagingSchema)) throw refusal('RMIG-E-DRY-RUN-REQUIRED', 'dry-run', 'Dry-run requires an allowlisted staging schema.');
  const metadata = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, status FROM ${qtable(stagingSchema, 'run_metadata')} WHERE migration_id = $1`, [plan.migration_id]);
  const row = metadata.rows?.[0];
  if (!row || row.bundle_manifest_sha256 !== plan.bundle_manifest_sha256 || row.compiled_policy_sha256 !== plan.compiled_policy_sha256 || row.target_identity_sha256 !== targetIdentity.database_identity_sha256 || !['staged', 'prepared'].includes(row.status)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'dry-run', 'Staging metadata is not bound to the exact plan and target.');
  const members = await readStagedMembers(client, stagingSchema, Object.keys(plan.members));
  if (stageContentSha256(members) !== row.stage_content_sha256 || stageContentSha256(members) !== stageContentSha256(plan.members)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'dry-run', 'Staged content does not cryptographically match the plan.');
  const state = await readTargetState({ client }); const stateHash = canonicalSha256(state);
  await validateOnTarget(client, members);
  const ledger = await ledgerBinding(client);
  const stagedPlan = { ...plan, members, migration_set_sha256: row.migration_set_sha256, migrator_version: row.migrator_version, plan_sha256: row.plan_sha256 };
  const report = buildDryRunReport({ plan: stagedPlan, targetIdentity, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version, stageContentSha256: row.stage_content_sha256, targetStateSha256: stateHash, status: 'validated' });
  await query(client, `UPDATE ${qtable(stagingSchema, 'run_metadata')} SET status = $1, dry_run_receipt_sha256 = $2, target_state_sha256 = $3, updated_at = NOW() WHERE migration_id = $4`, ['dry-run', report.receipt_sha256, stateHash, plan.migration_id]);
  return report;
}

export async function importPlan({ client, plan, dryRun, targetIdentity, stagingSchema, injectFailureAfter } = {}) {
  if (typeof stagingSchema !== 'string' || !IDENTIFIER.test(stagingSchema)) throw refusal('RMIG-E-DRY-RUN-REQUIRED', 'import', 'Import requires the validated staging schema; direct plan bypass is disabled.');
  verifyDryRun(plan, dryRun, targetIdentity);
  await query(client, 'BEGIN');
  try {
    await query(client, 'SELECT pg_advisory_xact_lock($1)', [V4_MIGRATION_LOCK_ID]);
    const currentIdentity = await readIdentityInTransaction(client);
    if (currentIdentity.database_identity_sha256 !== targetIdentity.database_identity_sha256 || currentIdentity.database_identity_sha256 !== dryRun.target_identity_sha256) throw refusal('RMIG-E-TARGET-CHANGED', 'import', 'Target identity changed since the dry run.');
    const currentStateHash = canonicalSha256(await readTargetState({ client }));
    if (currentStateHash !== dryRun.target_state_sha256) throw refusal('RMIG-E-TARGET-CHANGED', 'import', 'Target public objects or row counts changed since the dry run.');
    const ledger = await ledgerBinding(client);
    const metadata = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, dry_run_receipt_sha256, target_state_sha256, status FROM ${qtable(stagingSchema, 'run_metadata')} WHERE migration_id = $1 FOR UPDATE`, [plan.migration_id]);
    const row = metadata.rows?.[0];
    const metadataMismatches = !row ? ['metadata'] : [
      ['bundle_manifest_sha256', row.bundle_manifest_sha256, plan.bundle_manifest_sha256],
      ['compiled_policy_sha256', row.compiled_policy_sha256, plan.compiled_policy_sha256],
      ['target_identity_sha256', row.target_identity_sha256, targetIdentity.database_identity_sha256],
      ['migration_set_sha256', row.migration_set_sha256, ledger.migration_set_sha256],
      ['migrator_version', row.migrator_version, ledger.migrator_version],
      ['dry_run_receipt_sha256', row.dry_run_receipt_sha256, dryRun.receipt_sha256],
      ['target_state_sha256', row.target_state_sha256, dryRun.target_state_sha256],
      ['status', row.status, 'dry-run'],
      ['plan_sha256', row.plan_sha256, boundPlanSha256(plan, { migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version })],
      ['stage_content_sha256', row.stage_content_sha256, dryRun.stage_content_sha256],
    ].filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
    if (metadataMismatches.length) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staging metadata is not bound to the exact successful dry-run receipt.', { fields: metadataMismatches });
    const existing = await query(client, 'SELECT migration_id, receipt_sha256, status FROM public.migration_import_receipts WHERE migration_id = $1 FOR UPDATE', [plan.migration_id]);
    if (existing.rows?.length) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'This migration already has an import receipt; exact-once import refuses a rerun.');
    const members = await readStagedMembers(client, stagingSchema, Object.keys(plan.members));
    if (stageContentSha256(members) !== dryRun.stage_content_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged content changed after dry-run.');
    const stagedPlan = bindRelationalPlan({ ...plan, members }, { migrationSetSha256: row.migration_set_sha256, migratorVersion: row.migrator_version });
    if (stagedPlan.plan_sha256 !== row.plan_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged plan hash does not match run metadata.');
    compatibilityCheck(members);
    let inserted = 0;
    const serialTables = await readSerialTables(client); // refuses before any row is written if the catalog and the migrator disagree
    for (const table of IMPORT_ORDER) {
      if (table === 'people' || table === 'nodes') continue;
      inserted += await insertRows(client, table, members[table] ?? []);
      await resetSequence(client, table, serialTables);
      if (injectFailureAfter !== undefined && inserted >= injectFailureAfter) throw new Error('injected import failure for rollback proof');
    }
    const importReceipt = buildImportReceipt({ plan, dryRun, targetIdentity, insertedRows: inserted });
    await query(client, 'INSERT INTO public.migration_import_receipts (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, target_state_sha256, receipt_sha256, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [plan.migration_id, plan.bundle_manifest_sha256, plan.compiled_policy_sha256, targetIdentity.database_identity_sha256, row.migration_set_sha256, row.migrator_version, row.plan_sha256, row.stage_content_sha256, row.target_state_sha256, importReceipt.receipt_sha256, 'complete']);
    await query(client, `UPDATE ${qtable(stagingSchema, 'run_metadata')} SET status = $1, updated_at = NOW() WHERE migration_id = $2`, ['complete', plan.migration_id]);
    await query(client, 'COMMIT');
    return Object.freeze(importReceipt);
  } catch (error) { try { await query(client, 'ROLLBACK'); } catch { /* preserve import error */ } throw error; }
}

export function parseTargetIdentity(value) { return identityFromRow(value); }
export { TARGET_SCHEMAS };
