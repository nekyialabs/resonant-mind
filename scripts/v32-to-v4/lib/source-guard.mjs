// A guard over SQLite sources, separate from the catalog fingerprint. The fingerprint covers tables, columns, types,
// nullability, defaults, keys, unique constraints, foreign keys and plain indexes, and it is published as a value, so it
// is not widened. It cannot see the things below, and each of them can change a value or reject a row without any
// difference in the fingerprint, so a source that has one is refused. When the SQL cannot be read with confidence the
// answer is also a refusal.
//
//  - a generated or hidden column (table_xinfo hidden is not 0), or a virtual table
//  - a CHECK constraint
//  - a collation other than BINARY, on a column or on an index key
//  - WITHOUT ROWID, STRICT
//  - a partial index or an expression index

const FORBIDDEN_WORDS = new Map([['CHECK', 'check-constraint'], ['COLLATE', 'collation'], ['GENERATED', 'generated-column']]);

// The words of a CREATE statement outside comments, string literals and quoted identifiers; null when a quote or
// comment is not closed (the scan is not sure of anything then).
export function sqlWords(sql) {
  const words = [];
  let index = 0;
  const text = String(sql ?? '');
  while (index < text.length) {
    const char = text[index];
    if (char === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === close) {
          if (close !== ']' && text[index + 1] === close) { index += 2; continue; }
          index += 1; closed = true; break;
        }
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_$]/u.test(text[end])) end += 1;
      words.push(text.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    index += 1;
  }
  return words;
}

const quoteName = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Findings for the given tables of one schema of a SQLite database (all tables when `tables` is omitted).
 * Each finding is { table, kind, ...detail } and names no value from any row.
 */
export function sourceGuardFindings(database, { schema = 'main', tables } = {}) {
  const findings = [];
  const listed = database.prepare(`PRAGMA ${schema}.table_list`).all().filter((row) => row.schema === schema && !String(row.name).startsWith('sqlite_') && row.type !== 'shadow');
  for (const entry of listed) {
    const table = entry.name;
    if (tables !== undefined && !tables.includes(table)) continue;
    if (entry.type === 'virtual') { findings.push({ table, kind: 'virtual-table' }); continue; }
    if (entry.type !== 'table') continue;
    if (Number(entry.wr) === 1) findings.push({ table, kind: 'without-rowid' });
    if (Number(entry.strict) === 1) findings.push({ table, kind: 'strict' });
    for (const column of database.prepare(`PRAGMA ${schema}.table_xinfo(${quoteName(table)})`).all()) {
      if (Number(column.hidden) !== 0) findings.push({ table, kind: 'generated-or-hidden-column', column: column.name });
    }
    const definition = database.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.sql;
    const words = sqlWords(definition);
    if (words === null) findings.push({ table, kind: 'unreadable-sql' });
    else for (const [word, kind] of FORBIDDEN_WORDS) if (words.includes(word)) findings.push({ table, kind });
    for (const index of database.prepare(`PRAGMA ${schema}.index_list(${quoteName(table)})`).all()) {
      if (Number(index.partial) === 1) findings.push({ table, kind: 'partial-index', index: index.name });
      for (const key of database.prepare(`PRAGMA ${schema}.index_xinfo(${quoteName(index.name)})`).all()) {
        if (Number(key.key) !== 1) continue;
        if (Number(key.cid) === -2) findings.push({ table, kind: 'expression-index', index: index.name });
        else if (String(key.coll).toUpperCase() !== 'BINARY') findings.push({ table, kind: 'collation', index: index.name });
      }
      const indexSql = database.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'index' AND name = ?`).get(index.name)?.sql;
      if (typeof indexSql === 'string') {
        const indexWords = sqlWords(indexSql);
        if (indexWords === null) findings.push({ table, kind: 'unreadable-sql', index: index.name });
        else if (indexWords.includes('COLLATE')) findings.push({ table, kind: 'collation', index: index.name });
      }
    }
  }
  const seen = new Set();
  return findings.filter((finding) => { const key = JSON.stringify(finding); if (seen.has(key)) return false; seen.add(key); return true; });
}
