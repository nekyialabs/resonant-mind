import { types } from 'node:util';
import { canonicalJson } from './canonical-json.mjs';
import { assertSafeBundleMemberPath, canonicalSha256 } from './hash.mjs';
import { redact } from './redact.mjs';

export const FORMAT_VERSION = 1;
export const REQUIRED_BUNDLE_ARTIFACTS = Object.freeze([
  'source-report.json',
  'policy-template.json',
  'external/images.json',
  'external/reembed-jobs.ndjson',
]);
export const MIGRATION_PHASES = Object.freeze([
  'runtime',
  'inspect-source',
  'normalise-source',
  'export',
  'verify-bundle',
  'draft-decisions',
  'review-decisions',
  'apply-decisions',
  'compile-policy',
  'plan-relational',
  'inspect-target',
  'prepare-target',
  'dry-run',
  'import',
  'plan-images',
  'copy-images',
  'plan-reembed',
  'validate',
  'status',
]);
export const REPORT_STATUSES = Object.freeze([
  'succeeded',
  'refused',
  'failed',
  'in-progress',
  'complete',
  'exported',
  'review-required',
  'dry-run-accepted',
  'data-imported',
  'data-imported-images-pending',
  'data-imported-not-search-ready',
  'ready-for-cutover',
  'complete-operator-attested',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const MIGRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const MIGRATOR_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;

const SOURCE_KINDS = new Set(['postgres', 'sqlite', 'd1-export']);
const BUNDLE_MODES = new Set(['encrypted', 'plaintext']);
const PHASES = new Set(MIGRATION_PHASES);
const STATUSES = new Set(REPORT_STATUSES);

function fail(label, detail) {
  throw new TypeError(`${label} ${detail}.`);
}

export function assertPlainObject(value, label = 'Value') {
  if (value === null || typeof value !== 'object') {
    fail(label, 'must be a plain object');
  }
  if (types.isProxy(value)) {
    fail(label, 'must not be a proxy');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(label, 'must be a plain object');
  }
  return value;
}

function dataDescriptors(value, label) {
  assertPlainObject(value, label);
  const descriptors = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail(label, 'must not contain symbol keys');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only enumerable data fields');
    }
    descriptors[key] = descriptor.value;
  }
  return descriptors;
}

export function assertExactKeys(value, requiredKeys, label = 'Value') {
  const fields = dataDescriptors(value, label);
  const actual = Object.keys(fields).sort();
  const expected = [...requiredKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(label, `must contain exactly keys: ${expected.join(', ')}`);
  }
  return fields;
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(label, 'must be a non-empty trimmed string without control characters');
  }
}

export function assertMigrationId(value, label = 'migration_id') {
  if (typeof value !== 'string' || !MIGRATION_ID.test(value)) {
    fail(label, 'must be a safe 8-128 character identifier');
  }
}

export function assertTimestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(label, 'must be a canonical RFC 3339 UTC timestamp');
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail(label, 'must be a canonical RFC 3339 UTC timestamp');
  }
  if (canonical !== value) {
    fail(label, 'must be a canonical RFC 3339 UTC timestamp');
  }
}

export function assertSha256(value, label = 'artifact_sha256') {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(label, 'must be a lowercase SHA-256 digest');
  }
}

function assertMigratorVersion(value) {
  if (typeof value !== 'string' || !MIGRATOR_VERSION.test(value)) {
    fail('migrator_version', 'must be a semantic version');
  }
}

function assertFormatVersion(value) {
  if (value !== FORMAT_VERSION) {
    fail('format_version', `must be supported version ${FORMAT_VERSION}`);
  }
}

function assertDensePlainArray(value, label) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    fail(label, 'must be a plain dense array');
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label, 'must be a plain dense array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  const keys = Reflect.ownKeys(value);
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || keys[length] !== 'length') {
    fail(label, 'must be a plain dense array');
  }
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      fail(label, 'must be a plain dense array');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label, 'must contain only enumerable data fields');
    }
  }
  return length;
}

function assertMember(value, index) {
  const label = `members[${index}]`;
  const fields = assertExactKeys(
    value,
    ['name', 'sha256', 'plaintext_sha256', 'row_count'],
    label,
  );
  assertSafeBundleMemberPath(fields.name, `${label}.name`);
  assertSha256(fields.sha256, `${label}.sha256`);
  assertSha256(fields.plaintext_sha256, `${label}.plaintext_sha256`);
  if (!Number.isSafeInteger(fields.row_count) || fields.row_count < 0) {
    fail(`${label}.row_count`, 'must be a non-negative safe integer');
  }
  return fields.name;
}

export function validateManifest(value) {
  const fields = assertExactKeys(value, [
    'format_version',
    'migrator_version',
    'migration_id',
    'created_at',
    'source_kind',
    'source_fingerprint',
    'bundle_mode',
    'plaintext_acknowledgements',
    'secret_review',
    'members',
  ], 'Manifest');
  assertFormatVersion(fields.format_version);
  assertMigratorVersion(fields.migrator_version);
  assertMigrationId(fields.migration_id);
  assertTimestamp(fields.created_at, 'created_at');
  if (!SOURCE_KINDS.has(fields.source_kind)) {
    fail('source_kind', 'must be postgres, sqlite, or d1-export');
  }
  assertSha256(fields.source_fingerprint, 'source_fingerprint');
  if (!BUNDLE_MODES.has(fields.bundle_mode)) {
    fail('bundle_mode', 'must be encrypted or plaintext');
  }
  const acknowledgements = assertExactKeys(
    fields.plaintext_acknowledgements,
    ['allow_plaintext_bundle', 'acknowledge_plaintext_risk'],
    'plaintext_acknowledgements',
  );
  if (
    typeof acknowledgements.allow_plaintext_bundle !== 'boolean' ||
    typeof acknowledgements.acknowledge_plaintext_risk !== 'boolean'
  ) {
    fail('plaintext_acknowledgements', 'must contain boolean values');
  }
  const expectedAcknowledgement = fields.bundle_mode === 'plaintext';
  if (
    acknowledgements.allow_plaintext_bundle !== expectedAcknowledgement ||
    acknowledgements.acknowledge_plaintext_risk !== expectedAcknowledgement
  ) {
    fail('plaintext_acknowledgements', 'must exactly match the bundle mode');
  }

  const secretReview = assertExactKeys(fields.secret_review, ['decisions', 'false_positive_acknowledgements', 'sha256'], 'secret_review');
  if (secretReview.sha256 !== canonicalSha256({ decisions: secretReview.decisions, false_positive_acknowledgements: secretReview.false_positive_acknowledgements })) fail('secret_review.sha256', 'does not match the canonical secret review content');
  const decisionCount = assertDensePlainArray(secretReview.decisions, 'secret_review.decisions');
  const decisionIds = new Set();
  for (let index = 0; index < decisionCount; index += 1) {
    const item = Object.getOwnPropertyDescriptor(secretReview.decisions, String(index)).value;
    const decision = assertExactKeys(item, ['review_id', 'decision', 'reviewed_at', 'reviewed_by'], `secret_review.decisions[${index}]`);
    if (!SHA256.test(decision.review_id) || decisionIds.has(decision.review_id)) fail(`secret_review.decisions[${index}].review_id`, 'must be a unique review ID');
    if (!['retain', 'redact', 'exclude-row'].includes(decision.decision)) fail(`secret_review.decisions[${index}].decision`, 'must be retain, redact, or exclude-row');
    assertTimestamp(decision.reviewed_at, `secret_review.decisions[${index}].reviewed_at`);
    assertString(decision.reviewed_by, `secret_review.decisions[${index}].reviewed_by`);
    decisionIds.add(decision.review_id);
  }
  const falsePositiveCount = assertDensePlainArray(secretReview.false_positive_acknowledgements, 'secret_review.false_positive_acknowledgements');
  const falsePositiveIds = new Set();
  for (let index = 0; index < falsePositiveCount; index += 1) {
    const value = Object.getOwnPropertyDescriptor(secretReview.false_positive_acknowledgements, String(index)).value;
    if (!SHA256.test(value) || falsePositiveIds.has(value)) fail(`secret_review.false_positive_acknowledgements[${index}]`, 'must contain unique review IDs');
    falsePositiveIds.add(value);
  }

  const memberCount = assertDensePlainArray(fields.members, 'members');
  const names = new Set();
  const windowsFoldedNames = new Map();
  let previousName = null;
  for (let index = 0; index < memberCount; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(fields.members, String(index));
    const name = assertMember(descriptor.value, index);
    if (name === 'manifest.json' || name === 'checksums.sha256') {
      fail(`members[${index}].name`, 'must not reserve bundle control-file names');
    }
    if (fields.bundle_mode === 'encrypted' && !name.toLowerCase().endsWith('.enc')) {
      fail(`members[${index}].name`, 'must end with .enc for encrypted bundles');
    }
    if (fields.bundle_mode === 'plaintext' && name.toLowerCase().endsWith('.enc')) {
      fail(`members[${index}].name`, 'must not end with .enc for plaintext bundles');
    }
    if (names.has(name)) {
      fail('members', `must not contain duplicate path ${name}`);
    }
    const windowsFoldedName = name.toLowerCase();
    const caseCollision = windowsFoldedNames.get(windowsFoldedName);
    if (caseCollision !== undefined) {
      fail('members', `must not contain Windows-case collision ${caseCollision} and ${name}`);
    }
    if (previousName !== null && previousName > name) {
      fail('members', 'must be in deterministic sorted path order');
    }
    previousName = name;
    names.add(name);
    windowsFoldedNames.set(windowsFoldedName, name);
  }
  const suffix = fields.bundle_mode === 'encrypted' ? '.enc' : '';
  for (const artifact of REQUIRED_BUNDLE_ARTIFACTS) {
    const requiredName = `${artifact}${suffix}`;
    if (!names.has(requiredName)) fail('members', `must include required artifact ${requiredName}`);
  }
  for (const name of names) {
    const isRequired = REQUIRED_BUNDLE_ARTIFACTS.some((artifact) => name === `${artifact}${suffix}`);
    const isData = /^data\/[A-Za-z0-9._-]+\.ndjson(?:\.enc)?$/u.test(name);
    if (!isRequired && !isData) fail('members', `contains an unsupported extra member ${name}`);
  }
  return value;
}

export function reportHashInput(value) {
  const fields = assertExactKeys(value, [
    'format_version',
    'migrator_version',
    'phase',
    'timestamp',
    'migration_id',
    'status',
    'artifact_sha256',
    'details',
  ], 'Report');
  return {
    format_version: fields.format_version,
    migrator_version: fields.migrator_version,
    phase: fields.phase,
    timestamp: fields.timestamp,
    migration_id: fields.migration_id,
    status: fields.status,
    details: fields.details,
  };
}

export function assertPlainData(value, path = 'details', ancestors = new WeakSet(), depth = 0) {
  if (depth > 100) {
    fail(path, 'exceeds the maximum data depth');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail(path, 'contains an unsafe number');
    }
    return;
  }
  if (typeof value !== 'object') {
    fail(path, 'contains unsupported data');
  }
  if (types.isProxy(value)) {
    fail(path, 'must not contain proxy data');
  }
  if (ancestors.has(value)) {
    fail(path, 'must not contain cyclic data');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = assertDensePlainArray(value, path);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        assertPlainData(descriptor.value, `${path}[${index}]`, ancestors, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, 'must contain only plain data objects');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        fail(path, 'must not contain symbol fields');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(`${path}.${key}`, 'must be an enumerable data field, not an accessor or hidden field');
      }
      assertPlainData(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertSafeDetails(value) {
  assertPlainData(value);
  canonicalJson(value);
  const safe = redact(value);
  if (canonicalJson(safe) !== canonicalJson(value)) {
    fail('details', 'must not contain unsafe secrets or connection strings');
  }
}

export function validateReport(value) {
  const base = reportHashInput(value);
  assertFormatVersion(base.format_version);
  assertMigratorVersion(base.migrator_version);
  if (!PHASES.has(base.phase)) {
    fail('phase', 'must be a supported migration phase');
  }
  assertTimestamp(base.timestamp);
  assertMigrationId(base.migration_id);
  if (!STATUSES.has(base.status)) {
    fail('status', 'must be a supported report status');
  }
  assertSafeDetails(base.details);
  const artifactSha256 = Object.getOwnPropertyDescriptor(value, 'artifact_sha256').value;
  assertSha256(artifactSha256);
  if (artifactSha256 !== canonicalSha256(base)) {
    fail('artifact_sha256', 'does not match the canonical report content');
  }
  return value;
}

export function validateVersionedArtifact(kind, value) {
  if (kind === 'manifest') {
    return validateManifest(value);
  }
  if (kind === 'report') {
    return validateReport(value);
  }
  assertString(kind, 'Artifact kind');
  fail('Artifact kind', 'is unknown');
}
