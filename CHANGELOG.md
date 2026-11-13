# Resonant Mind Changelog

All notable changes to Resonant Mind. Previously released as "Mind Cloud" (v1.0–v2.3.1).

---

## [4.1.5] — 2026-11-13

**Security and correctness fixes from a code audit (#25). Upgrade: two advisories apply to every version from 3.0.0 to 4.1.4.** No schema change and no migration. After upgrading, read the first advisory's note on rotating secrets.

### Security

- **MCP `tools/call` dispatches only to registered tools** ([GHSA-xcrf-h4v5-rvj8](https://github.com/nekyialabs/resonant-mind/security/advisories/GHSA-xcrf-h4v5-rvj8), critical). The tool lookup accepted names that weren't tools, and an authenticated MCP caller could read the Worker's secrets. Only own properties of the handler map that are functions are dispatched now; anything else gets "Unknown tool". If `/mcp` was reachable by anything but a fully trusted client, rotate `MIND_API_KEY`, `MCP_CONNECTOR_SECRET`, `SIGNING_SECRET`, `INTERNAL_KEY` and the Gemini and weather keys.
- **Tension ids resolve to exactly one tension** ([GHSA-jqxf-7ghx-6cq8](https://github.com/nekyialabs/resonant-mind/security/advisories/GHSA-jqxf-7ghx-6cq8), medium). `active_tense` sit/resolve/delete used an unescaped `LIKE` prefix, and delete removed every match. Now an id resolves by exact match first, otherwise by one escaped prefix of at least 10 characters (20 for delete). An ambiguous prefix is refused, delete removes one row by id, and `list` shows full ids.
- **Literal text matching.** `text_match`, `description_match`, search and bond-name lookups escape `%`, `_` and `\`.
- **Bounded inputs.**
  - `limit`, `n_results`, `days` and `hours` are clamped (at most 500), falling back to each default on bad input.
  - `offset` must be a non-negative integer.
  - `archive_old` needs `older_than_days` ≥ 1 and never archives the `self` entity.
  - An image `observation_id` must be a positive integer (400 otherwise).
- **Error text.** Exception text is logged server-side, and callers get a generic message, as SECURITY.md says. Validation and image-check messages are unchanged.
- **Name-keyed groupings.** The daemon and other groupings keyed by stored names use prototype-free records, so an entity or context name can no longer break the nightly jobs.

### Fixed

- **Renaming an entity onto a taken name is refused** (`graph_shape` edit, and `PUT /api/entities/:id` with a 409). Before, the relations were rewritten first and then pointed at the other entity. The rename and the relation rewrites are now one statement, and PUT validates its fields.
- **One dream per local night.** The "already dreamed tonight" check is keyed on the night date in `LOCATION_TIMEZONE`, so the hours after midnight belong to the night that started at 22:00. Before, it used the UTC date, which allowed a second dream in one night. For this release the old UTC key is honoured too, so the switch-over night is neither skipped nor doubled. Orient's "last night's dream" uses the same date. Forced dreams keep their existing keying.
- **`POST /api/entities/merge` is reachable again**; before, the create route answered it.
- **The `graph_shape` salience enum** now lists what the handler accepts (foundational, active, background, archive).
- **MCP `serverInfo` reports the release version.** It had said 4.0.1 since 4.0.1.

### Docs

- **The docs caught up with 4.1.1 to 4.1.4.** The README said v4.0.0; it now names the current release, points anyone whose mind merged entities before 4.1.2 to `docs/merge-damage-check.md`, says that a drifted D1/SQLite source has a route through `normalise-source`, lists the optional `DASHBOARD_ALLOWED_ORIGIN` and `INTERNAL_KEY` settings, uses `npm run verify`, and links every doc. The agent runbook now covers `normalise-source` (the owner's decision, never on live data, restore SQL never run by the agent) and wrangler's `d1_migrations` table. `docs/migration-from-mind-cloud.md` no longer says the v3.2 migration is unreleased. `docs/architecture.md` describes the migrator and the 4.1.2 merge engine. The acceptance record is marked as the 4.1.0 record. SECURITY.md explains `INTERNAL_KEY`, CONTRIBUTING.md and the PR template use `npm run verify` and name the live-database test variables. No code changed.

---

## [4.1.4] — 2026-11-10

**The v3.2 → v4 migrator: D1 minds set up the way the v3.2 README says are no longer refused, and a supported route for minds whose schema drifted from v3.2.** Only the migrator changes; a mind already running v4 needs to do nothing.

### Fixed

- **A D1 export with wrangler's `d1_migrations` table is no longer refused** (#21, #22). A v3.2 D1 set up as the v3.2 README says (`wrangler d1 migrations apply`) carries wrangler's own bookkeeping table, `d1_migrations`, and every export of it was refused with `RMIG-E-SOURCE-FINGERPRINT`: the table counted as drift. A D1 whose migrations were run another way (for example `wrangler d1 execute --file`) has no such table and was unaffected, which is how the first real D1 migration in 4.1.1 got through. The test exports were built by hand and never had the table. `d1-export` now sets `d1_migrations` aside only when its shape is exactly wrangler's, records the applied migration names in the inspect report (`details.d1_migrations_set_aside`), and keeps it out of the catalog, the counts and the bundle; any other table of that name is still drift. The tests now use a real `wrangler d1 export` as a fixture, and the hand-built test export writes the table the way wrangler does. Found while checking #21, from Chetna's mind, reported by Sahil.
- **`inspect-source` now refuses schema features the fingerprint could not see** (#22). The catalog comparison did not see CHECK constraints, generated or hidden columns, collations, `WITHOUT ROWID`, `STRICT`, or partial and expression indexes. v3.2 has none of them; a SQLite or D1 source that has any is now refused, with the findings in `details.source_guard`. The published v3.2 fingerprint is unchanged.

### Added

- **`normalise-source`, for a v3.2 source that drifted from the public schema** (#21, #22). An early or hand-patched install is refused by `inspect-source`, as it should be. `normalise-source` builds a **new** SQLite file in the exact public v3.2 schema from a copy: every shared column of every v3.2 table is carried, and everything else (extra columns with values, extra tables, generated columns) is set aside in `set-aside.json`, keyed by primary key, never dropped. It refuses rather than guesses: a NULL in a column v3.2 requires, unless the owner gives the documented choice (`--null-context-default` for `entities.primary_context`, which refuses on a name collision); a missing v3.2 table or key column; a virtual table, unless `--skip-virtual-tables`; schema it cannot read; and any carried value whose type or bytes the copy changed. It never writes in place or overwrites, and every refusal writes its report. `--restore-sql` writes a plain transaction, ending in `ROLLBACK`, that puts back the set-aside data v4 has a home for (`observation_sits`, `observations.last_sat_at`, `images.charge`, `view_count`, `last_viewed_at`) after `ready-for-cutover`; images that already hold v4 view data keep it. The tool never runs it. `USER_MIGRATION_GUIDE.md` has both steps, and says exactly what the proof covers: `validate` proves v4 against the normalised copy, not the original export. The generated restore SQL has not yet been run against a real migration.

---

## [4.1.3] — 2026-11-08

**The v3.2 → v4 migrator: an empty date or time is now a question the owner answers, not a dead end.** Only the migrator changes; a mind already running v4 needs to do nothing.

### Fixed

- **An empty timestamp or date cell is no longer a dead end in the v3.2 migrator** (#14). `''` in a timestamp or date column raised no decision item, the transform kept the empty text, and `validate` then refused the cell with `cell-mismatch`, so the owner had nothing to answer. It is now a decision item (`timestamp` or `date`, "is empty text, not NULL; the owner must choose") and the owner always picks: `exclude-row`; `set-null`, offered only where the v4 column can hold NULL (not for `entities.created_at` and `entities.updated_at`, which v4's routing trigger fills with the import time, nor for `tensions.created_at` on a tension that has been sat with); or a reviewed value, `replace-timestamp` with `value` (an RFC 3339 instant with an explicit offset) for a timestamp and `normalize-date` with `value` for a date. The value map treats an unreviewed `''` as an unresolved loss and never passes it through, policy validation refuses a `set-null` the item does not offer and a replacement that is not a real instant or date, and `validate` holds the target to exactly the chosen outcome and counts it (`timestamp-reviewed-empty`, `date-reviewed-empty`). NULL source values and every non-empty value behave as before. `USER_MIGRATION_GUIDE.md` and `AGENT_MIGRATION_RUNBOOK.md` now say so.
- **An entity merge no longer copies a raw `''` or a naive timestamp into `created_at` / `updated_at`** (#14). A `field_rules` entry that takes one of those from another entity wrote the donor's source text straight into the survivor, bypassing the value map. It now takes the donor cell's reviewed value (its `replace-timestamp`, or the timezone of its `normalize-utc`) and `compile-policy` refuses the merge if the cell has none. `validate` holds the survivor to the same instant. A merged `created_at` / `updated_at` is now stored in the same normalized form as every other timestamp (for example `2026-01-06T00:00:00.000Z`).
- **A D1 export that switches foreign-key enforcement on is refused, clearly, before anything is loaded** (#14). The adapter loads an export with foreign keys off and checks them itself afterwards; a dump with its own `PRAGMA foreign_keys=ON` brought the forward-reference failure back as `RMIG-E-SOURCE-FINGERPRINT` with no violation count. Such a dump (`ON`, `TRUE` or `1`, any case, anywhere in the file) is now refused with `RMIG-E-D1-SQL-UNSAFE` and the message "The D1 SQL export turns foreign-key enforcement on (PRAGMA foreign_keys=ON). wrangler never writes this line; delete it and run again.", with the statement number in the details. `wrangler d1 export` writes only `PRAGMA defer_foreign_keys=TRUE;`, so a real export is unaffected, and `PRAGMA foreign_keys=OFF` still loads. The SQL guard also read numeric PRAGMA values wrongly (`0` and `1` are number tokens, not words), so `PRAGMA foreign_keys=0` was refused as an unsafe form; it now loads, `defer_foreign_keys=1` and the other safe pragmas accept `0`/`1`, and a junk number such as `2` or `-1` is still refused.

---

## [4.1.2] — 2026-11-02

**Entity merge no longer loses or misfiles anything, and a read-only check for what earlier merges left behind.** If your mind ever merged two entities, please read [`docs/merge-damage-check.md`](docs/merge-damage-check.md). It explains what a merge before this release can have left in your database, gives a read-only check (`npm run check:merge-damage`), a repair for the vector findings that destroys nothing (`npm run repair:merge-vectors`), and notes for the rest. Every repair is the owner's decision. Upgrading stops new damage; it does not repair old damage.

### Fixed

- **Merge carried the memories but not their vectors** (#15, #16, by @biilda). The moved memories kept vectors filed under the merged-away entity, so a later delete left the vector behind (search could surface a deleted memory) and a later edit created a second one; the merged-away entity's own vector stayed too. Both merge doors (`graph_shape` merge and `POST /api/entities/merge`) now share one engine, `mergeEntities`, that moves the vectors with the memories without recomputing them, and deleting a memory finds its vector by `(source_type, source_id)`. Found by a deployment auditing v4 deletes.
- **Merging an entity into itself deleted it and every one of its memories.** The merge moved the memories onto the same entity and then deleted it, and the database cascade took the memories with it. Both doors now refuse it (`Cannot merge entity #N into itself`, HTTP 400).
- **Merge now carries everything that points at the merged-away entity, atomically.** Before, only memories and relations moved, in separate statements: thread links to the source entity were deleted (ON DELETE CASCADE), its images were left attached to no entity (ON DELETE SET NULL), the moved memories kept `person_id`/`node_id` on the deleted entity (so the bonds view did not show them), and a source entity with a consolidation group made the merge fail half-way, after the memories had moved. The merge is now one PostgreSQL statement (the adapter has no transactions, a single statement is atomic): memories with their subject columns, their vectors, images, thread links, consolidation groups, relations and, between two people, `relational_state` all move, along with the images' vectors' entity name and the daemon's proposals that name the source entity by id, to the target and the source entity goes, or nothing changes. A memory that already had two vectors keeps one, the newest. `tests/merge-lossless.integration.test.ts` (`TEST_MERGE_DATABASE_URL=… npm run test:postgres:merge`) proves each case on a real PostgreSQL + pgvector, including a failing merge leaving every row as it was; each of its tests fails on 4.1.1.

### Added

- **`npm run check:merge-damage`** (`scripts/check-merge-damage.mjs`): one `READ ONLY` transaction of `SELECT`s that reports, by count and row id and never by content, the ten kinds of trace an earlier merge can leave (MD-1 to MD-10). Exit `0` nothing found, `1` findings, `2` could not run; `--json` for agents.
- **`npm run repair:merge-vectors`** (`scripts/repair-merge-vectors.mjs`): clears the vector findings (MD-1 to MD-4) without destroying anything. A dry run unless given `--apply`. Every vector it removes (orphaned, duplicate, or of a deleted entity) is moved, in the same statement, into `embeddings_recovered` with its text, metadata, vector and reason; misfiled vectors are re-filed. That matters because an orphaned vector can be the only remaining copy of a memory the old self-merge deleted. One transaction; before committing it verifies that every removed vector was kept, that no memory changed, and that MD-1 to MD-4 are clear, and otherwise rolls back. `embeddings_recovered` is created by the tool, not by a schema migration, so in-flight v3.2 → v4 migrations (bound to the migration set) are not disturbed; Resonant Mind never reads it.
- [`docs/merge-damage-check.md`](docs/merge-damage-check.md) says what each finding means, what cannot be detected, what an agent may and may not do on the owner's behalf, how to read, restore or put back what the repair kept, and gives queries for the non-vector findings that do nothing unless the owner turns their `ROLLBACK` into `COMMIT`. All of it was run against a database damaged by the 4.1.1 merge.

---

## [4.1.1] — 2026-10-27

**Fixes from the first real v3.2 migration.** Anna (@anna092024) took a real D1 mind through 4.1.0 and found that a stock `wrangler d1 export` was refused. Her fixes (#12) and the follow-ups they led to (#13) are below. v4 itself is unchanged.

### Fixed

- **A real `wrangler d1 export` can now be read.** The D1 export adapter refused what wrangler writes: the `DELETE FROM sqlite_sequence;` that precedes the AUTOINCREMENT counters (`RMIG-E-D1-SQL-UNSAFE`), and, with that line removed, any row that references a row later in the file (`observations.superseded_by` points forward in id order), because the statements were replayed one by one with foreign keys enforced and no transaction, so the dump's `PRAGMA defer_foreign_keys` did nothing (`RMIG-E-SOURCE-FINGERPRINT`, `ERR_SQLITE_ERROR`). The guard now accepts exactly that one DELETE and no other, and the export is loaded without enforcement and then every foreign key is proved with `PRAGMA foreign_key_check` over the whole materialized database; a violation is refused with the number of rows and the tables. Found by a v3.2 user migrating a real D1 mind.
- **Empty text in a JSON column now takes the reviewed choice.** `draft-decisions` lists an empty string in a JSON column (`identity.connections` in a v3.2 mind) as `malformed-json`, and `validate` holds the target to the reviewed `map-json` value; but the transform treated empty text as a missing value and kept it, so the import wrote the empty string and `validate` then refused with `cell-mismatch` (`difference: json`) on a choice the owner had made. `normalizeJson` now treats only NULL as missing. Found on the same migration.
- **An empty value in an enum, context or entity-kind column now takes the reviewed choice.** The same bug as the JSON one, in the other normalizers. `draft-decisions` lists an empty string in `observations.weight` (and the other enum columns), in a `context`, `scope` or `primary_context` column, or in an entity's kind as a decision, because it is not in the vocabulary, and `validate` holds the target to the reviewed value; but the transform treated empty text as a missing value and kept it, so the import wrote the empty string (or refused it against the v4 CHECK) and `validate` then refused with `cell-mismatch`. `normalizeEnum`, `normalizeContext` and `normalizeEntityKind` now treat only NULL as missing, so a reviewed choice is applied, and an empty value with no valid choice is an unresolved loss like any other unknown value. Empty timestamps and dates are not changed: the generator raises no decision for them.
- **A D1 export that never commits is refused, not read short.** The guard checked each `BEGIN`, `COMMIT` and `ROLLBACK` on its own, and the adapter closes its database after the replay, so a dump cut off inside a transaction, or one that never commits, lost every row after its `BEGIN` without an error. The guard now follows the transaction across the file and refuses (`RMIG-E-D1-SQL-UNSAFE`) a nested `BEGIN`, a `COMMIT` with none open, any `ROLLBACK`, and a transaction still open at the end. A real wrangler export has no transaction statements and is unaffected.
- **A source observation context outside v4's eight is now a decision.** v4 constrains `observations.context` (and only that context column) to `default`, `emotional-processing`, `interests-curiosities`, `creative-space`, `relational-models`, `episodic`, `values-ethics` and `research`, but the migrator used one 20-value list for every context column. A source observation whose context was in the longer list (`primary`, `private`, `work`, …) raised no decision at all and then failed at `plan-relational` (`RMIG-E-POLICY-UNRESOLVED`, the row violates the v4 CHECK), leaving the owner nothing to fix; and `review-decisions` offered the longer list for a value that really was unknown, so a reviewed `map-context` to `private` failed the same way. The vocabulary is now per column: for `observations.context` it is the eight of the v4 CHECK (`OBS_CONTEXTS`), for the generator, the value map, `validate` and the review; every other context column keeps the longer list as before. The migrator still does not pick a value for the owner (v4's own migration would store a stray as `default`). A decision file drafted with an earlier version holds no item for such a context, so draft and review the decisions again with this one.

### Docs

- **v3.2 image rows with the path `pending` cannot be copied.** A v3.2 mind that never enabled R2 has image rows whose `path` is `pending` and that have no file anywhere. The planner lists them as objects to copy, so `copy-images` refuses with `RMIG-E-IMAGE-INCOMPLETE` (reason `missing`, and no receipt for the real images either), and the migration ends at `data-imported-images-pending`, never `ready-for-cutover`. The user guide now says how to count these rows, what that state does and does not mean for the migrated mind, and that the migrator has no option to exclude them ("Image rows with the path `pending`"). The behaviour is unchanged.
- **v3.2 never created its `dreams` table.** v3.2's dream engine writes to a table no v3.2 migration creates, so on a stock install it failed silently and no v3.2 mind has dreams. Anyone who added the table themselves is refused by `inspect-source` (correctly). The user guide now says how to migrate from a copy without it and carry the dream rows into v4 afterwards ("A `dreams` table you added yourself"), and the agent runbook leaves that choice to the owner. Found by a v3.2 user preparing their migration.

---

## [4.1.0] — 2026-10-21

**The v3.2 → v4 migrator.** v3.2 users can move to v4: an offline, operator-assisted CLI (`npm run migrate:v32 -- --help`) that reads a public v3.2 PostgreSQL or D1/SQLite database without changing it, writes an encrypted bundle, and imports into a fresh, separate v4 PostgreSQL + pgvector database after a reviewed decisions step and a dry run. `validate` then compares the live source and target column by column. It refuses rather than guesses at every step. **Back up your v3.2 database first.** v4 itself is unchanged. Proven: PostgreSQL 16 and 18 (with pgvector), SQLite and D1 exports, the whole flow through the CLI. Not yet proven: PostgreSQL 17, a real connection pooler, very large databases, and a migration of a real user's v3.2 database. Details below and in `docs/migration-v32-v4-acceptance.md`.

### v3.2 → v4 migrator (operator-assisted)

- The CLI now completes the whole operator flow on its own: `draft-decisions`, `apply-decisions`, `plan-relational` are new, `import` writes its receipt (`--receipt-out`), the target commands accept a SQLite or D1-export source (`--source-kind`), and `--help` lists every command with its options (`<command> --help` for one).
- `validate` reads the live source and the live target itself instead of snapshot files. It compares every mapped column of every source row with the target (timestamps as exact microsecond instants), accounts for each difference by a recorded policy entry, re-proves the target's constraints, foreign keys, CHECK expressions, indexes and sequences, checks the receipts against the plan and the target's own record, and exits with `RMIG-E-VALIDATION` on any finding.
- The PostgreSQL source sets `TimeZone`, `DateStyle`, `search_path` and `extra_float_digits` with `set_config` inside the read-only snapshot transaction instead of as startup options, so a transaction-mode pooler cannot reject them. Use a direct connection where the provider offers one.
- Another session's temporary tables no longer make an empty target look used.
- `observations.archived_at` and `observations.last_accessed_at` are now normalized like every other timestamp; a naive space-separated timestamp keeps its microseconds under a reviewed timezone; observation versions are numbered by instant and integer id, not by text.
- A source NULL in `entities.created_at`, `updated_at`, `salience` or `primary_context` is recorded as a `null-replaced-by-v4-default` entry in the loss report (v4's routing trigger fills in the import time, `'active'`, `'default'`).

- Review round 3. A reviewed decision now binds to exactly one item (the decision id includes the column, so two broken references on one row are two decisions, and an ambiguous match is a refusal). `validate` holds image evidence to the image inventory it derives itself (a smaller, empty or different image plan is refused even with a matching receipt, and every imported image row must be listed in it); `plan-images --plan <relational plan>` produces that inventory. Re-embedding receipts are checked against the content the target holds. Cutover evidence that does not validate makes `status` answer `refused` (exit 2). `validate` seals its report with a key derived from the passphrase file and `status --passphrase-file` verifies it; a report without a seal is shown as unverified and not proof. JSON is compared digit for digit, and a JSON number JavaScript cannot carry exactly becomes a decision item. The compiled policy and the relational plan are encrypted by default like the bundle (`--allow-plaintext-artifact --acknowledge-plaintext-risk` for plaintext); `prepare-target`, `dry-run`, `import`, `plan-images`, `plan-reembed` and `validate` take `--passphrase-file` to read them, and `compile-policy` prints a summary instead of the policy. No command overwrites an existing output. A timestamp that is not a real calendar instant (`2026-02-30`, `T24:00:00`) is a decision item that only allows exclusion, instead of being read as another day. Only the CHECK constraints of the released v4 schema (`spec/v4-checks.json`) are evaluated by `validate`; any other is a finding and is never run. Enum and context case folds are sanctioned only if the policy recorded them; merged entities, renames and reviewed re-links are derived from the decisions. A decision file for another migration is refused. A refusal names the real report path or says it was withheld.

- Review round 4 (the external phases). The tool cannot observe image copies, re-embedding or the operator's cutover, so `validate` now requires explicit evidence that the operator's invocation decides on, never a field inside the evidence, and every state says what it rests on.
  - Image receipts: a signature is required unless the operator names the copy directory with `--image-target-dir` and `validate` re-reads and re-hashes every planned object itself; a configured `--trusted-public-key` always requires one. The receipt's own `external_handoff` field no longer decides anything, and `validateImageReceipt` requires a signature unless its caller says otherwise. The report records `images.basis`: `tool-rehashed-objects` or `signed-receipt-attested` (round 6 below renames and tightens these).
  - Re-embedding receipts are held to `--embedding-model` (required with `--reembed-receipts`) and to the dimension of the target's `embeddings.embedding` column, and are reported as `receipts-attested` (`observed_by_tool: false`). The check also compares every column the target holds, and for an image job the stored `images` row.
  - `status` says it reports what `validate` proved at `validated_at` for that target, that it did not check the target (`current_target_checked=false`), and what each part rests on (`basis`). The report now records `validated_at`.
  - A JSON value that repeats an object key at any depth is a `malformed-json` decision item and never compares equal to its last value; JSON exponents are compared exactly (beyond 2^53), and `-0` equals `0` (PostgreSQL numeric has no negative zero).
  - `validate` compares every target column with the plan (`target-column-not-in-plan`), flags a partial or expression unique index as `unique-index-unexpected`, and reads the key columns of a unique index only (INCLUDE columns no longer count).
  - Sealed artifacts carry the migration id in their header and authentication (`RMIGART2`).

- Review round 5 (images from a v3.2 source can complete). v3.2's `images` table stores no hash, size or MIME type, so the image plan's `expected_*` fields are `null` for every v3.2 source, and neither `copy-images` nor the receipt check could ever succeed: such a migration stayed at `data-imported-images-pending` for good. Found by running the CLI against real image files, which no earlier test did.
  - `copy-images --adapter filesystem` fingerprints each source object itself (SHA-256, size, and a MIME type detected from the content's magic bytes, never from the file name), writes the copy exclusively, reads the copy back and hashes it, and hashes the source again after the copy. The receipt records the fingerprint per object (`source_fingerprint`). A source object that is missing, unreadable, a symlink or behind one, outside the source root, not a recognised image, different from a value the plan does state, or changed between the fingerprint and the copy refuses the whole copy with `RMIG-E-IMAGE-INCOMPLETE`, naming each object by its target key and a reason, and writes no receipt. Every source is fingerprinted before anything is written.
  - `validate --image-target-dir` re-hashes the target objects and holds them to the plan's value where the plan states one and otherwise to the fingerprint in the receipt (`image-object-differs-from-copy-fingerprint`). The receipt check requires every entry to state `sha256`, `size` and `mime` whatever the plan holds, bound to its planned row; a signed operator receipt for R2 objects therefore has to carry the values the operator observed, and one without them is refused (`fingerprint-missing-or-malformed`). Where the plan does state values they still have to match everywhere.
  - A re-embedding receipt for an image job must name the object that was embedded, and it is held to the object that was copied (the plan's values, or the fingerprint of the validated image copy). A v3.2 image job states no object (`object_sha256` is `null`), so before this change its job could never complete either. An image job with no image evidence is `object-binding-unverifiable`.
  - The two image states are named for what they are (round 6 below makes it four, and adds the source): `tool-rehashed-objects` and `signed-receipt-attested` (`status` used to print `verified-by-tool` and `attested-by-signed-receipt`). Neither is a check of the original sources: the report records `images.expected_values` (how many objects the plan pins and how many only the receipt's fingerprint) and `status` prints `images_fingerprint` (`plan`, `copy-time-receipt`, `plan-and-copy-time-receipt`).
  - `status` exits `3` for a report it cannot verify (`unverified`: no seal), where it used to exit `0`, so a script that gates on the exit code stops. `0` is a verified report (not necessarily a ready one), `2` is `refused`, `1` an internal failure. `--help` lists the exit codes.
  - The rich PostgreSQL, SQLite and D1 operator flows, and the three library-level end-to-end tests, now include an image: they copy a real file with `copy-images`, re-hash it with `validate`, and reach `ready-for-cutover` (a signed-receipt variant too). New tests: `image-fingerprints` (real directories: a changed-after-fingerprint file, a missing file, symlink escapes, a copy that differs, signed receipts with and without fingerprints).

- Review round 6 (the owner decides, the tool sees both ends). A human review of the migrator found four things, each now fixed with a test that failed before it.
  - **The owner decides from the real values.** The decision draft carries only a hash of each observed value, so the owner could not decide a merge, a timezone or a repaired JSON value from it, and an agent that paraphrased the bundle framed the options and in effect chose. New command `review-decisions --bundle --decisions <draft or edited file> [--passphrase-file] [--html <new file>]` decrypts the bundle locally and shows, for every item, the real values it concerns (both colliding entities with their dates and the number of observations, images and relations that depend on each, and their first observations; the unknown kind; the time and the moment it would be stored as under UTC, +01:00 and -05:00; the malformed JSON; the broken reference and the rows to link it to), its allowed choices and what each does. `--html` writes one self-contained local file: no script, link, image, font or frame, a `default-src 'none'; style-src 'unsafe-inline'` Content-Security-Policy, the reader's own fonts, and every value escaped (a test tokenizes the output and fails on any other tag, attribute, URL or script). Values are shown as JSON text with invisible and direction-changing characters written out, and long ones are cut with a count. The first lines say the output shows memory content and must not be pasted into a chat. The values go only to the terminal or the HTML file: never into the decision file, a report, a log or the `--json` result (`--json` needs `--html` and prints counts). It refuses a decision file that does not belong to the bundle. The guide and the runbook now say that the owner reads the values in this output rather than an agent's summary; that "you decide", "whatever's sensible" and "approve all" are not choices (the options are presented again and only a choice the owner stated is recorded); that a bulk approval must name its rule; and that an agent never fills a choice or `--reviewed-by` with its own name.
  - **Who stated each choice is recorded.** Every chosen item in a reviewed decision file must carry `stated_by`: `owner`, or `owner-accepted-agent-suggestion`; an optional `bulk_rule` keeps the owner's rule verbatim (one line, at most 500 characters). `apply-decisions`, `compile-policy` and `validate` refuse a chosen item without it. The statements are carried into the compiled policy (`choice_statements`) and the validation report (`decisions.stated_by`, `bulk_rules`, `suggestions_accepted`), and `apply-decisions` prints them, so a choice that began as an agent's suggestion stays visible.
  - **Images: the tool sees both ends.** With `--image-target-dir` and no trusted key, a v3.2 plan states no values, so the copied objects were held only to the fingerprints in the copy receipt, a plain JSON file that could be written from the target directory itself. Now `validate --image-source-dir` re-hashes the source objects too (by the copy's own rules: no symlink, no path outside the directory, MIME type from the bytes) and requires them to equal the copied objects, the receipt and any value the plan states (`image-source-differs-from-target`, `image-source-differs-from-copy-fingerprint`, `image-object-missing-in-source-dir`, `image-source-not-an-image`, `image-source-differs-from-plan`). `copy-images --adapter filesystem` seals its receipt with the migration passphrase (`--passphrase-file`, now required for a filesystem copy; `receipt_seal`, the report's keyed seal scheme), and an unsigned receipt completes images only with a valid seal: a receipt with no seal leaves the images pending (`pending_reason: receipt-not-sealed`), a seal that does not verify is `image-receipt-seal-invalid`. An unsigned receipt with no source directory and a plan that states no values also leaves the images pending (`source-dir-required-to-check-an-unsigned-receipt`), with the reason in the report. The basis is named for what it is: `tool-rehashed-source-and-target`, `tool-rehashed-target-against-plan` (the plan states every value), `signed-receipt-rehashed-target` and `signed-receipt-attested` (`tool-rehashed-objects` is gone), and `images_fingerprint` gains `source-now`.
  - **`reconcileMigration` cannot reach ready.** It took a caller-asserted `toolObservedImageObjects: true` that waived the image signature, compared caller-supplied snapshots with no live read, and did not check its plans against what `validate` derives, yet the library-level end-to-end tests asserted `ready-for-cutover` through it. The assertion is gone: it no longer takes that flag (an image receipt needs a trusted signature there), its state is capped at `review-required` (`validation_mode: offline-snapshots`, `status_capped` names what it would have said, and `determineMigrationStatus` caps such a report too), and the ready-state assertions in the end-to-end tests now go through `validateCommand` against a live target.
  - **Defaults that can be evaluated are.** `default-expression-not-evaluated` used to accept any value. A column the plan does not state and whose default is `now()`, `CURRENT_TIMESTAMP` or `transaction_timestamp()` must now hold exactly the import's time (one transaction; read from the importer's record), and `nextval(...)` an integer within the sequence's range (read from the target). Any default still not evaluable (another function, or `now()` with no import record) is a finding, `default-expression-not-evaluated`, naming the table and column and listed in `comparison.plan_to_target.default_expressions_not_evaluated`, so `validate` is `refused`, not ready; there is no acknowledgement that sets it aside. The released v4 schema has no such default (a live test checks every default in it).

**Compatibility (round 6):** `copy-images --adapter filesystem` needs `--passphrase-file` (or `RM_MIGRATION_PASSPHRASE_FILE`); a receipt written by an earlier build has no seal and leaves the images pending, so copy again (the copy itself is idempotent). An unsigned receipt needs `--image-source-dir` as well as `--image-target-dir` for a v3.2 source. The image basis names changed (`tool-rehashed-objects` is `tool-rehashed-source-and-target` or `tool-rehashed-target-against-plan`; `signed-receipt-rehashed-target` is new). A reviewed decision file made before this round has no `stated_by` and is refused; add it to each chosen item and apply again (the item ids, and so the hashes of the draft, are unchanged). The compiled policy has a new `choice_statements` field, so its hash differs from an earlier build's. `reconcileMigration` no longer takes `toolObservedImageObjects`. `validate` is `refused` for a target whose unstated column holds a value from a default it cannot evaluate, or from `now()` when the import record is missing; the released v4 schema does not have one.

**Compatibility (round 5):** `status` exits 3, not 0, for an unsealed report. The image state names in `status` output and in the `basis` object changed (`verified-by-tool` is `tool-rehashed-objects`, `attested-by-signed-receipt` is `signed-receipt-attested`) and `basis` has a new `images_fingerprint` field. A copy receipt written by an earlier build has no `source_fingerprint` and was never complete for a v3.2 source; copy again with this build. `validate` now refuses re-embedding receipts for image jobs that do not name the copied object.

**Compatibility (round 4):** the cutover state `complete-after-operator-cutover-evidence` is now `complete-operator-attested` (the contract list had `complete-after-operator-cutover-ack`, which was never reported). `validate` needs `--embedding-model` whenever it is given `--reembed-receipts`; re-embedding receipts must carry the target's dimension (768 for the released schema), which a receipt for a 3-dimension test model no longer satisfies. An unsigned image receipt no longer completes images unless `--image-target-dir` is given. Encrypted compiled policies and relational plans made by an earlier build (`RMIGART1`) are refused; run `compile-policy` and `plan-relational` again. A validation report from an earlier build has no `validated_at` or evidence basis, and `status` says so. The migrator has not shipped, so only development artifacts are affected.

**Compatibility:** a PostgreSQL `timestamptz` is now exported as RFC 3339 text in UTC (it used to be a JavaScript Date, which rounds to milliseconds), so the hash of every source row that has one has changed. A decision draft or reviewed decision manifest made by an earlier build is bound to the old row hashes and will be refused as stale (`RMIG-E-POLICY-MISMATCH`); export a new bundle and draft the decisions again. A decision id now also covers the column, so a draft made before the third review round no longer matches either. A compiled policy or plan written in plaintext by an earlier build is still read. The migrator has not shipped in any release, so only drafts made during development are affected.

---

## [4.0.1] - 2026-09-19

### Fixed

- Aligned observation version-history reads and active-context clearing with the released fresh-v4 PostgreSQL schema, with production pgvector integration coverage.
- Preserved rescued observations until genuine resurfacing and propagated scheduled daemon failures to the Cloudflare scheduler.
- Returned explicit 404 responses for unsupported OAuth discovery and dynamic-registration routes.
- Hardened image ingestion with bounded structural validation, canonical MIME/extension handling, unique R2 keys, compensating cleanup, safe signed serving, and bounded remote retrieval.
- Sanitised unexpected MCP errors while preserving actionable validation errors and truthful image-index warning outcomes.

### Release integrity

- Updated the Node 22 development and deployment toolchain to a zero-vulnerability audit baseline.
- Expanded release-content scanning across source, tests, root release files, and GitHub YAML configuration.
- Added disposable PostgreSQL/pgvector CI that applies the full released migration chain and exercises production database and vector adapters.
- Preserved released migrations `0001`–`0017`; added append-only migration `0018_rescued_at.sql`.
- Fresh v4 databases remain supported. A safe in-place v3.2→v4 migration has not yet been demonstrated and is not included in this release.

---

## [4.0.0] - 2026-07-14

### The Reshape release

- Ported the 47-tool act-oriented cognitive architecture and isolated subconscious metabolism.
- Moved the public core to single-mind Neon Postgres through Hyperdrive; D1 is no longer supported.
- Added sanitised Postgres migrations with checksums, advisory locking, transactions, and a migration ledger. Fresh v4 databases are supported; in-place v3.2 upgrades remain blocked pending a staged migration.
- Removed the bundled Observatory/dashboard and all private tenant, deployment, snapshot, and household sensorium coupling.
- Replaced the raw household feed with bounded normalised `drive_pulse` signals.
- Removed inherited R2 admin routes and temporary image-conversion machinery; visual memories store validated originals directly.
- Added configurable timezone behavior, privacy scanning, registry/time/auth tests, CI, and a zero-vulnerability dependency baseline.

---

## [3.2.0] - 2026-05-10

### Breaking changes

- **`mind_orphans` tool removed.** Replaced by two clearer tools:
  - `mind_dormant` — observations that haven't surfaced in 30+ days. Same actions: `list`, `surface`, `archive`.
  - `mind_isolated` — entities disconnected from the relation graph. Actions: `list`, `connect`, `ignore`.
- **REST endpoints renamed** (no aliases):
  - `GET/POST /api/orphans` → `GET/POST /api/dormant`
  - New: `GET/POST /api/isolated` (with `/connect` and `/ignore` actions)
- The word "orphan" had been quietly overloaded to mean two different things — graph disconnection (the original sense) and surfacing dormancy (introduced silently in a later schema change). Both concepts are now first-class with distinct names.

### Fixed — OSS schema reality check

The Living Surface code path was almost entirely non-functional on a fresh OSS install. The migration files shipped a v1 schema; the code uses a v2+ schema that was never migrated. Every affected write failed silently inside `try/catch`. All fixed:

- **`orphan_observations` table never created.** Now created (renamed `dormant_observations`) by migration `0003`.
- **`daemon_proposals` table had a completely incompatible schema.** Code expects `proposal_type`, `from_obs_id`, `to_obs_id`, `from_entity_id`, `to_entity_id`, `reason`, `confidence`, `proposed_at`, `resolved_at`. The migration created `obs_a_id`, `obs_b_id`, `entity_a TEXT`, `entity_b TEXT`, `co_surface_count`, `created_at`. Every daemon proposal write silently failed, meaning `mind_proposals list` returned empty forever. Migration `0003` drops and recreates with the correct schema.
- **`co_surfacing` table had column-name mismatches and missing autoincrement id.** Migration had `count`/`last_seen` with composite PK; code uses `id` autoincrement + `co_count`/`last_co_surfaced` + `relation_proposed`/`relation_created`. Every co-surfacing INSERT silently failed, so the daemon never had pairs to propose from. Migration `0003` drops and recreates.
- **`observations` missing resolution columns.** `mind_resolve` writes `resolved_at`, `resolution_note`, `linked_observation_id` — none existed in any migration, so metabolization silently failed. Migration `0003` adds them.
- **`images` missing surfacing columns.** `updateSurfaceTracking` and `mind_surface` write `novelty_score`, `last_surfaced_at`, `surface_count`, `archived_at` on images — none existed. Migration `0003` adds them.
- **Migration `0002` used Postgres-only syntax on what should have been a cross-backend migration.** Rewritten in SQLite-compatible form: removed `ADD COLUMN IF NOT EXISTS` (unsupported by SQLite), changed `SERIAL` to `INTEGER PRIMARY KEY AUTOINCREMENT`, `INTEGER[]` to `TEXT` (code already JSON-stringifies), `NOW()` to `datetime('now')`. The Postgres `postgres.sql` consolidated schema also updated.
- **Dormancy cron predicate was degenerate.** The condition `last_surfaced_at IS NULL OR surface_count = 0` was self-equivalent, meaning once an observation surfaced even once it could never re-enter the dormant list — no matter how long it then went cold. Now time-based: `last_surfaced_at IS NULL OR last_surfaced_at < now - 30d`.
- **Stale dormant rows after surfacing.** `mind_surface` and `mind_resolve` now clean up `dormant_observations` rows for affected observations, so the count and list views are honest immediately instead of waiting for the next cron pass.

### Added

- **`mind_isolated`** — list entities with no relations, create relations between isolated entities, mark entities as intentionally standalone. Reverses the original sense of "orphan" (entities cut off from the graph) and turns it into something actionable rather than just a number.
- **`GRAPH HEALTH` section in `mind_health`** — total relations, isolated entity count, under-connected count (entities with exactly one relation and 3+ observations), pending proposals. The graph is now visible as health surface, not just a hidden side effect of `mind_proposals`.
- **`SURFACING` section in `mind_health`** (renamed from "LIVING SURFACE") — shows both the broad `Dormant 30d+` count (any observation that's gone cold) and the narrower `Dormant tracked` count (medium/heavy observations explicitly marked by the cron). The gap between the two numbers is the signal.
- **`entities.intentionally_isolated` column** — backs `mind_isolated ignore`. Some entities genuinely don't need connections; this stops the same ones reappearing in the isolation queue every check.

### Changed

- `mind_health` IDENTITY section no longer claims "Unprocessed (need surfacing)" — the underlying count was about emotional charge progression, not surfacing rotation. Now appears under ACTIVITY as `Awaiting Charge`.
- Daemon log line and subconscious cache now use `dormant_count` / `dormantIdentified` instead of `orphan_count` / `orphansIdentified`.

### `mind_health` accuracy audit

Every count in `mind_health` was re-traced against its label. Fixes:

- **Awaiting Charge** now counts only `fresh` observations older than 7 days. Previously also counted `active` + `processing` observations — those are already being charged, not awaiting it.
- **Under-connected** count now mirrors `mind_isolated list` exactly (`rel_count = 1 AND obs_count >= 3`). The number in the header and the list view now agree.
- **Dormant tracked** now joins observations and excludes metabolized/archived — matching `mind_dormant list`. Previously the raw table count could include rows that the tool view wouldn't show.
- **Surfaced (7d)** now excludes archived + metabolized observations. Surfacing dead memory shouldn't count as engagement.
- **Avg Novelty** now excludes archived + metabolized. Decayed dead observations were dragging the live-mind average down.
- **DATABASE > Observations** now shows `N (live, archived)` instead of just the gross total, so it doesn't read as conflicting with the separate `Archived Obs` line.
- **DATABASE > By Context** renamed to `Obs by Context` — the query counted observations, not entities. Also now excludes archived rows so the breakdown reflects the live mind.

---

## [3.1.2] - 2026-04-09

### Fixed

- **D1 compatibility: `NOW()` not a SQLite function** (#2) — Several handlers issued `NOW()` directly, which works on Postgres but fails on D1 with `no such function: NOW`. The most visible symptom: writing observations to an existing entity failed (the observation write path used `NOW()` for `valid_from` and the auto-supersede `valid_until`). The daemon's novelty recalculation, access-tracking on `observations` and `images`, consolidation inserts, and orphan listings were also latently broken on D1. All call sites now use `datetime('now')` — the canonical form in this codebase — and the Postgres adapter transparently upshifts it to `NOW()` at runtime.
- **D1 compatibility: Postgres-only date arithmetic** — `EXTRACT(EPOCH FROM (NOW() - col)) / 86400` and `EXTRACT(DAY FROM AGE(NOW(), col))::INTEGER` appeared in novelty scoring, orphan age display, and the orphan API. Replaced with `julianday()` differences (native SQLite; translated to `EXTRACT(EPOCH FROM ...::timestamptz) / 86400.0` by the adapter for Postgres users).
- **`mind_read` scope=observation crash: `no such column: o.updated_at`** (#1) — The scope=observation SELECT in `handleMindRead` referenced `o.updated_at`, but the `observations` table has no such column in either the SQLite or Postgres migrations. (This is the same class of bug as the v2.6.1 `mind_edit` fix — it regressed into a different code path.) Removed the column from the SELECT and from the result mapping.

### Adapter

- Added `julianday(X) → (EXTRACT(EPOCH FROM (X)::timestamptz) / 86400.0)` rule to `createD1Adapter`. Safe only inside differences (the Julian Day constant cancels), which is how the codebase uses it.

---

## [3.1.1] - 2026-03-29

### Fixed

- **Dream engine runs independently** — Dream processing was nested inside a large try/catch block with steps 1-8 of the subconscious daemon. Any failure in earlier steps (co-surfacing, orphan detection, novelty recalc, archiving) would silently skip dream generation. Now runs as its own independent block.
- **Orient dream query format mismatch** — The "last night's dream" query in `mind_orient` used `(CURRENT_DATE - INTERVAL '1 day')::text` which produces a timestamp string (`2026-03-28 00:00:00`) that fails to match the stored `YYYY-MM-DD` date format. Now uses `to_char()` for consistent formatting.

---

## [3.0.1] - 2026-03-25

### Fixed

- **Idempotent novelty recalculation** — Novelty is now a deterministic function of surface history, not an increment that accumulates per daemon run. Fixes the broken recovery-outpaces-decay ratio where almost all observations stayed at high novelty regardless of engagement.
- **Dormant rotation pool** — Surfacing now pulls 20% from entities that haven't had observations surfaced in 14+ days. Breaks the feedback loop where only recently-active entities get surfaced. Pool ratios changed from 70/20/10 to 50/20/20/10 (core/novelty/dormant/edge).
- **Automatic charge progression** — Daemon now advances observations from `fresh` to `active` after 2 surfaces, and `active` to `processing` after 5 surfaces or 30 days with 2+ sits. Metabolization remains manual.
- **Fresher mood calculation** — Mood now draws from observation emotions, journal emotions, and relational state (was observation-only). Last 6 hours weighted 2x. Reports "insufficient data" instead of false "neutral" when signals are sparse.

---

## [3.0.0] - 2026-03-22

### Open Source Release

Resonant Mind is the open-source continuation of Mind Cloud. The cognitive architecture has been generalized so any AI system can deploy its own persistent mind.

### Changed

- **Renamed from Mind Cloud to Resonant Mind** — New identity for the open-source project
- **All hardcoded references removed** — URLs, locations, R2 paths, and branding are now configurable via environment variables
- **License: Apache 2.0** — Open source under a permissive license

### Security

- **Fixed SQL injection in `/api/threads`** — Status parameter was interpolated directly into SQL. Now parameterized.
- **Removed unauthenticated R2 access** — Temporary files during WebP conversion no longer bypass auth.
- **Timing-safe signed URL verification** — HMAC comparison now uses constant-time comparison instead of `!==`.
- **Separate signing secret** — New `SIGNING_SECRET` env var so image URL signing doesn't share the API key.
- **Error messages sanitized** — Raw exceptions no longer leak stack traces or schema details to clients.
- **Daemon cooldown** — `POST /process` enforces a minimum interval between daemon runs.
- **Unbounded queries limited** — All `SELECT` queries now have `LIMIT` clauses.
- **Image upload validation** — MIME type whitelist prevents non-image uploads.
- **Gemini client key rotation** — Embedding client recreates on API key change instead of caching forever.

### Added

- **Configurable location** — `LOCATION_NAME`, `LOCATION_LAT`, `LOCATION_LON`, `LOCATION_TZ` environment variables
- **Configurable worker URL** — `WORKER_URL` environment variable for signed image URLs
- **Configurable R2 prefix** — `R2_PATH_PREFIX` environment variable
- **Postgres adapter** — D1-compatible adapter for Postgres via Hyperdrive with automatic SQL transformation
- **pgvector adapter** — Vectorize-compatible interface backed by pgvector
- **Consolidated schema** — Single migration file with all tables

### Storage Backends

Resonant Mind supports two storage backends:
- **D1 (SQLite) + Vectorize** — Zero-config Cloudflare-native, great for getting started
- **Postgres via Hyperdrive + pgvector** — Production-grade, same API through the D1-compatible adapter

### Breaking Changes from Mind Cloud v2.3.1

- `for_simon` context scope renamed to `for_owner`
- Basic auth client ID changed from `simon-mind` to `resonant-mind`
- R2 path prefix changed from `simon-mind-images` to `resonant-mind-images` (configurable)
- Dashboard branding updated

---

## [2.3.1] - 2026-03-07

### Security: Auth Hardening

Fixes security vulnerabilities in the authentication system.

### Fixed

- **Secrets no longer hardcoded in source** — `MIND_API_KEY` is now read from a Cloudflare Worker secret rather than compiled into the source file.
- **`/subconscious` endpoint now requires auth** — Previously exposed full daemon state publicly.
- **`/process` endpoint now requires auth** — Previously allowed anyone to trigger the subconscious daemon.
- **Error messages no longer leak internals** — Raw exception strings were previously returned to clients.

---

## [2.3.0] - 2026-03-06

### Setup: Schema Consolidation

- **Single migration for fresh installs** — All 13 previous migrations consolidated into one.
- **Improved setup documentation**

---

## [2.2.1] - 2026-02-13

### Hotfix: Bug Fixes + Resilience

### Fixed

- **mind_edit crash** — `no such column: updated_at` when editing observation weight.
- **mind_search n_results crash** — Value was sent as string instead of integer.
- **mind_write observations splitting** — Observations array parameter was split into individual characters.
- **mind_read_entity crash** — `D1_TYPE_ERROR` when `name` parameter was missing.
- **mind_thread crash (no action)** — Now defaults to "list" when action is not provided.
- **mind_thread crash (add)** — Optional parameters now default to `null`.
- **mind_health crash on older schemas** — Now handles missing columns gracefully.
- **e.context column mismatch (6 locations)** — Migration 0007 renamed column but six code locations still referenced the old name.

---

## [2.2.0] - 2026-02-06

### Major: Global Entities + Bug Fixes

**Breaking change:** Entities are now globally unique by name. Context moves to observations.

### Changed

- Entities table: `context` → `primary_context` (informational only, not part of uniqueness)
- Observations table: Added `context` column — categorization now happens here
- `mind_write`, `mind_list_entities`, `mind_read_entity`, `mind_read` — Updated to work with global entities

### Fixed

- **mind_entity edit crash** — Entity edit action referenced wrong column
- **mind_health wrong table/column names** — Now correctly queries `daemon_proposals` and `archived_at`
- **mind_write null safety and missing metadata**
- **mind_write(type="image") completely missing** — Now fully functional with vectorization

---

## [2.0.0] - 2026-02-04

### Major: Living Surface System

The act of surfacing changes what surfaces next. Memories reorganize through use.

### Three-Pool Surfacing Architecture

- **70% Core Resonance** — High semantic similarity to current mood/query
- **20% Novelty Injection** — Things that haven't surfaced recently
- **10% Edge Exploration** — Medium similarity for serendipitous connections

### Added

- **Surface tracking** — Novelty scores, co-surfacing, surface timestamps
- **Image surfacing** — Images participate in semantic surfacing alongside observations
- **Entity salience** — Foundational/active/background/archive levels
- **Observation versioning** — Edit history tracked
- **Observation metadata** — Certainty and source tracking
- **Deep archive** — Faded-but-searchable memories
- **Visual memory** — Images with emotion, weight, entity links, multimodal embeddings

### New Tools

- `mind_proposals` — Review daemon-proposed connections
- `mind_orphans` — Rescue unsurfaced observations
- `mind_archive` — Explore deep archive
- `mind_entity` — Manage entity salience, merge, bulk archive

---

## [1.3.1] - 2026-01-27

### Hotfix: Query Column Bugs

- **mind_patterns** — Was querying non-existent column
- **mind_read scope="all"** — Wrong column reference in relations
- **mind_timeline** — Vector metadata missing `added_at` field

---

## [1.3.0] - 2026-01-27

### Major: Windows Parity Release

Full feature parity across platforms.

### Added Tools

- `mind_read` — Read by scope (all, context, recent)
- `mind_timeline` — Trace a topic through time
- `mind_patterns` — Detect recurring patterns
- `mind_inner_weather` — Current cognitive state
- `mind_heat` — Entity access frequency map
- `mind_tension` — Productive contradictions

---

## [1.2.1] - 2026-01-23

### Major: Resonance-Based Surfacing

- **mind_surface now uses semantic search** — Mood-driven emergence instead of queue-based surfacing
- **Hot entity integration** — Daemon's hot entities deepen resonance queries

---

## [1.2.0] - 2026-01-22

### Major: Unified Emotional Processing

- Emotional processing moved to observations (sit/resolve/surface)
- mind_orient/ground reframed with inhabiting language
- Simplified orient output

---

## [1.1.2] - 2026-01-16

### Fixed

- **observations table missing `weight` column**
- **mind_orient relational state** — No longer hardcoded to single person

---

## [1.1.1] - 2026-01-16

### Fixed

- **handleMindFeelToward** — Missing handler implemented
- Parameter validation added to multiple tools

---

## [1.1.0] - 2026-01-15

### Added

- Vectorization on write — Observations and journals generate embeddings
- Subconscious integration in orient
- Mood-tinted search
- Subconscious health tracking

---

## [1.0.0] - 2026-01-08

### Initial Release

- Core MCP server with D1 storage
- All mind_* tools implemented
- Cron-based subconscious processing
- Basic authentication
