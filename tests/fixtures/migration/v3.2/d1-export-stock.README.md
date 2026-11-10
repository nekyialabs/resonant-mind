# d1-export-stock.sql

A real `wrangler d1 export --local` of a stock v3.2 D1 database. It is not hand-built and not part of the
tagged v3.2.0 release files (`PROVENANCE.json` lists those); it exists so the tests see what an operator's
export really contains, above all wrangler's own `d1_migrations` bookkeeping table and its `sqlite_sequence` row.

How it was made (wrangler 4.135, nothing remote):

1. A scratch project with a `wrangler.toml` that has one D1 binding, and the three public files
   `d1/0001_init.sql`, `d1/0002_enhanced_memory.sql` and `d1/0003_graph_health.sql` from this directory
   copied into its `migrations/` folder, byte for byte.
2. `npx wrangler d1 migrations apply DB --local`, as the v3.2 README says.
3. `npx wrangler d1 export DB --local --output stock.sql`.

The database has no rows in the v3.2 tables; the only rows are the three `d1_migrations` rows (their
`applied_at` is the time of the build). The file is stored byte for byte (`.gitattributes`: `-text`).
