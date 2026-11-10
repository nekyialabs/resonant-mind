# v3.2-drifted

Made-up data in a database that has drifted from the public v3.2 schema, for `normalise-source` (issue #21).
Nothing here is real memory content; the names and notes are invented.

- `drift.sql` is the drift, as a script to run on top of the exact public v3.2 schema (`../v3.2/d1/0001`–`0003`):
  `entities` rebuilt with a nullable `primary_context` and an `intentionally_isolated` column, `images` with `charge`,
  `view_count` and `last_viewed_at`, `observations` with `last_sat_at` (and without `charge_note` and `source_date`),
  `journals` without `journal_type`, `tensions` and `observation_versions` rebuilt with differently named columns
  (`visits`, `last_visited`, `edited_at`, `version_num`), `threads` with `source` defaulting to `'owner'`, an
  `observation_sits` table, and eight other tables v3.2 does not have. One entity has a NULL `primary_context`.
- `drifted-d1-export.sql` is the same database as `wrangler d1 export --local` (wrangler 4.135) wrote it, after
  `wrangler d1 migrations apply --local` on the three public files and `drift.sql`. It carries wrangler's
  `d1_migrations` table. The person names and one text value in the rows were replaced by invented ones afterwards (in both files).

Both files are stored byte for byte (`.gitattributes`: `-text`).
