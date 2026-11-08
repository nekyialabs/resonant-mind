# v3.2 to v4 operator-assisted migration guide

This is the operator-facing guide for the pre-push release candidate. It documents a deliberate, operator-assisted data move; it is not a release announcement, a support commitment, or permission to upgrade a live system without rehearsal. Read this with [the strict agent runbook](AGENT_MIGRATION_RUNBOOK.md).

## Scope and hard boundary

The migrator reads a source snapshot and writes only to a separately verified, fresh v4 PostgreSQL target. It does not upgrade a v3 database in place, delete v3 data, deploy Workers, switch Hyperdrive, copy R2 objects automatically, call an embedding provider automatically, or cut over automatically.

## Support matrix

The exact supported relational source families are:

| Source | Boundary | Required condition |
|---|---|---|
| Public PostgreSQL v3.2.0 | Supported for the relational export/import path | Exact public v3.2 catalog fingerprint, including the expected PostgreSQL/pgvector shape. |
| Public final D1/SQLite v3.2.0 | Supported for the relational export/import path | Exact final SQLite catalog from `0001_init.sql`, `0002_enhanced_memory.sql`, and `0003_graph_health.sql`; use a local SQLite file or a local SQL export. |
| Remote Cloudflare D1 | Manual export handoff only | The operator runs the remote export and supplies the resulting local SQL file. The CLI never opens the Cloudflare API. |
| Fresh v4 PostgreSQL + pgvector | Only target supported by the importer | Distinct database with no non-system objects; released v4 migrations are applied by the target-preparation phase. |

Drifted, partial, private, pre-`0003`, post-v3.2, unknown, or mixed schemas are refused. Existing v4 targets, SQLite targets, D1 targets, and the source itself are not import targets. This table is a first-release implementation boundary, not a product support promise.

### Source and target safety

1. Treat the v3 source as read-only. PostgreSQL inspection/export uses a repeatable-read read-only snapshot; SQLite opens read-only. Never run migration DDL against the source.
2. Use a new local D1 export file. The export is materialized into a temporary SQLite database; the source SQL file is not rewritten.
3. Use a fresh target identity every time. The target must be distinct from the source and empty of non-system objects. Do not “make room” by deleting rows.
4. Keep connection values out of command arguments. Use `env:VARIABLE_NAME` references such as `env:RMIG_SOURCE` and `env:RMIG_TARGET`; never paste a URL, password, token, key, or passphrase into chat, a ticket, a log, or an argv example.

## What changes in the data

The bundle is deterministic and every transformed row is bound to a `migration_id`, source/bundle hash, policy hash, and audit report. No transformation is silently guessed.

- **Entities, names, and kind:** v3 `entities` routes to v4 `people` or `nodes`. Known kinds are normalized to the v4 checks (for example `kin` to `peer_ai`, and `AI peer`/`peer_ai` to `peer_ai`). A collision-free source ID is retained when valid. A final kind must be reviewed when it is not unambiguous.
- **Duplicate names:** v4 has a globally unique name surface where v3 may have repeated names by `primary_context`. Each collision requires a reviewed `merge` or `rename` decision. A merge names every source ID, one survivor, and deterministic field rules for `name`, kind, context, salience, and timestamps. A rename supplies the final unique name for every affected source ID. Dependent IDs and name-based relation endpoints use the same final map. Unresolved collisions refuse.
- **Observation versions:** `observation_versions.changed_at` becomes `edited_at`; `version_num` is generated in `(observation_id, changed_at, id)` order. Invalid or tied timestamps need an explicit stable-ID tie-break and policy entry.
- **Timestamps and dates:** Accept a strict RFC 3339 timestamp with an offset, or SQLite's exact UTC `YYYY-MM-DD HH:MM:SS` form. Other values, naive timestamps, and epoch-like values are policy items. A reviewed timezone is required before normalization to RFC 3339 UTC. A value that is not a real calendar instant (`2026-02-30`, `T24:00:00`, a minute of 60) is never read as another day: it is a policy item whose only choice is to exclude the row, because no timezone can repair it. Dates require a valid ISO date or a reviewed date mapping. **Empty text (`''`) in a timestamp or date column is not NULL and is not a time, and it is a policy item too, never passed through:** the draft lists it (type `timestamp` or `date`, reason "is empty text, not NULL; the owner must choose") and the owner picks one of `exclude-row`, `replace-timestamp` with `value` (an RFC 3339 instant with an explicit offset; for a date, `normalize-date` with `value`, an ISO date), or `set-null`. `set-null` is offered only where the v4 column can hold NULL, so it is absent for `entities.created_at` and `entities.updated_at` (v4's entity routing trigger fills those with the import time, so the target never holds NULL there) and for `tensions.created_at` on a tension that has been sat with (its `last_visited` defaults from it). `validate` holds the target to exactly the chosen outcome and counts it (`timestamp-reviewed-empty`, `date-reviewed-empty`). A NULL in these columns is not a decision and stays NULL. Every point-in-time column of v3.2 is covered (a test checks the list against both exact source schemas). PostgreSQL's microseconds are kept to the last digit; a fraction finer than a microsecond is refused, never rounded. A PostgreSQL `timestamptz` is exported as RFC 3339 text in UTC, so the row hashes in any decision draft made by an earlier build of this migrator no longer match (and a decision id now covers the column, so an older draft does not match either): such a draft is refused as stale, and you draft the decisions again from a new bundle.
- **Enums and contexts:** Known enum aliases are normalized. Unknown enum values, entity kinds, and contexts need a reviewed mapping to a value allowed by v4 checks; the default is refusal, not coercion. `observations.context` is the one context column v4 constrains, to eight values (`default`, `emotional-processing`, `interests-curiosities`, `creative-space`, `relational-models`, `episodic`, `values-ethics`, `research`): any other value there is a decision, and the review offers only those eight. The other context columns are free text in v4 and keep the longer v3.2 list.
- **JSON:** `links`, `connections`, `tags`, `source_observation_ids`, `data`, and `sit_notes` are parsed and checked for their expected array/object shape. Invalid JSON is a policy item. It may be mapped only with a reviewed, shape-preserving choice; it is never silently replaced with `[]`. A JSON number that a JavaScript number cannot carry exactly (for example `12345678901234567891`, which would be stored as `12345678901234567000`) is the same kind of policy item, and `validate` compares JSON digit for digit.
- **Foreign keys:** Integer and name references are remapped through the final ID/name map. A broken or excluded reference is refused unless a reviewed policy explicitly excludes or nulls a nullable link. Stale source IDs never survive just because an insert would accept them.
- **Dormancy:** `dormant_observations` becomes v4 `orphan_observations` under the documented semantic translation. Attempts and timestamps are preserved and the terminology change is reported.
- **Tensions:** `tensions.sit_count` becomes visits. `status` and `sit_notes` have no direct v4 columns, so every affected row needs a reviewed action such as preserving visits and opening, or preserving visits and resolving with explicit resolution fields. The source row remains represented in the audit/loss report.
- **NULLs that v4 fills in:** v3.2 lets `entities.created_at`, `entities.updated_at`, `entities.salience` and `entities.primary_context` be NULL. v4's own entity routing trigger replaces a NULL `created_at` or `updated_at` with the *import time*, a NULL `salience` with `'active'` and a NULL `primary_context` with `'default'`, in `people`/`nodes`. The migrator does not choose this; it records every case as a `null-replaced-by-v4-default` entry in the loss and audit report (one per row and field), carries it into the dry-run and validation reports, and `validate` checks that the target holds exactly that default (for the timestamps, exactly the import transaction's time, read from the importer's own receipt record) and that every recorded case is visible in the target.
- **Fields without a released target:** Values such as v3 observation access/validity/supersession fields and other dropped fields are listed in the audit report with a reason. They are not silently erased from the accounting of loss.
- **Images:** Image metadata rows and references are transformed after ID decisions. Local image files can be copied through the filesystem adapter, which fingerprints each object it copies (v3.2 stores no hash, size or MIME type for an image, so the tool is the one that observes them). Existing R2 objects require an independent operator/provider transfer and a signed receipt that carries the SHA-256, size and MIME type the operator observed for every object; metadata migration does not prove object availability.
- **Vectors:** Old v3 embedding vectors and external Vectorize state are inventoried and discarded from the target payload. They are never copied into v4 `embeddings` or a vector index. The tool produces a re-embedding job plan for transformed searchable text and image records. Provider execution and receipt production remain external. Until receipts validate, the state is `data-imported-not-search-ready`, not complete.

## Backup and restore rehearsal

Do not begin source inspection until both the backup and restoration rehearsal are evidenced. A backup file existing on disk is not enough: record its size, checksum, source identity, creation time, restricted permissions, and a successful restore/read-only verification without placing secrets in the evidence.

### PostgreSQL v3 backup and restore rehearsal

Use the operator's secret-managed source reference; the placeholders below are not credentials:

```bash
pg_dump --format=custom --file <v3-backup.dump> "$PG_SOURCE"
sha256sum <v3-backup.dump>
createdb "$PG_RESTORE_NAME"
pg_restore --exit-on-error --dbname "$PG_RESTORE" <v3-backup.dump
```

Run `inspect-source` against the restored database using `env:RMIG_RESTORE`, compare the catalog fingerprint and table counts with the original inspection report, and record the restore result. Do not restore over the source. Keep the original dump untouched until the migration and cutover decision are closed.

### D1 manual remote export and rehearsal

Remote Cloudflare D1 manual export command:

```bash
npx wrangler d1 export <binding-or-name> --remote --output <local.sql>
```

Inspect the file, checksum it, and rehearse loading it into a new local SQLite database. Supply only that local file as `--source-kind d1-export --source <local.sql>`. A D1 name, URL, or remote binding passed to the CLI must refuse with `RMIG-E-D1-REMOTE-UNSUPPORTED`. A SQL file that contains `PRAGMA foreign_keys=ON` (or `=TRUE`, `=1`, in any case) is refused with `RMIG-E-D1-SQL-UNSAFE` before anything is loaded, and the refusal names the statement number: `wrangler d1 export` never writes that line (it writes only `PRAGMA defer_foreign_keys=TRUE;`), so delete it and run again. The migrator loads the export with foreign keys off and proves every foreign key itself afterwards. `PRAGMA foreign_keys=OFF` is accepted.

### Independent image/R2 backup

Back up image objects independently of the relational bundle using the provider's approved R2 export/backup mechanism. Record the object inventory, object keys, sizes, MIME findings, per-object checksums, destination, and operator/provider receipt. Do not treat the relational bundle, an R2 listing, or the migrator's image metadata as an object backup.

R2 handoff is operator-assisted: a human or separately authorized provider job performs the copy, then supplies a signed receipt and trusted public-key file to `copy-images --adapter r2`. The receipt must state, for every planned object, the SHA-256, size and MIME type the operator observed (step 10). An unsigned JSON file, a receipt without those values, a missing object, or a partial copy is not completion. Automatic R2/network transfer is unsupported by this lane.

## Encryption and sensitive artifacts

Encrypted bundles are the default. Use a permission-restricted passphrase file with `--passphrase-file <passphrase-file>`; the passphrase itself must never appear in argv, chat, shell history, or an artifact. The bundle envelope records KDF metadata, not the passphrase.

Plaintext is an exceptional, explicitly acknowledged mode. It requires both flags, exactly as implemented:

```text
--allow-plaintext-bundle --acknowledge-plaintext-risk
```

The choice is recorded in the manifest and report, and secret scanning still runs. Do not “fix” a plaintext refusal by removing one flag or by copying sensitive members elsewhere.

The one command that deliberately shows memory content is `review-decisions` (step 5), for the owner who has to decide. Its terminal output and its `--html` file hold migrated content in the clear: neither goes into a chat, a ticket, a log or an agent's hands, and the HTML file is deleted when the decisions are made. No other artifact holds those values: the decision file, the reports and the `--json` results carry hashes, ids and counts.

## Operator command sequence

Every step below is a command of the checked-in CLI, and the whole sequence needs nothing else: the CLI drafts the decisions, applies your review, builds the plan, prepares and fills the target, and validates against the live source and target itself. Run `node scripts/v32-to-v4/cli.mjs --help` for every command with its options, or `node scripts/v32-to-v4/cli.mjs <command> --help` for one; the help is checked against the parsers by a test, so it cannot drift. `--json` may be added to any command for structured result or refusal output on stdout. Values in angle brackets are placeholders, not secrets.

Set secret-bearing environment variables through the operator's secret manager, then use only `env:RMIG_SOURCE` and `env:RMIG_TARGET` references in commands. A passphrase is only ever a file.

**Connections.** Use a direct (non-pooled) connection for the migration wherever the provider offers one. Neon does: its pooled endpoint (the host name with `-pooler`) is PgBouncer in transaction mode, the direct one is not. The source is read in a single read-only transaction and its session settings (`TimeZone`, `DateStyle`, `search_path`, `extra_float_digits`) are set inside that transaction with `set_config`, not as connection options, so a transaction-mode pooler does not break the read the way a startup option would. That has been tested against a session whose defaults differ and against a proxy that refuses startup options the way PgBouncer does, not against Neon or PgBouncer themselves, so treat a pooled endpoint as unproven. If a pooler refuses the transaction or the settings, you will see `RMIG-E-SOURCE-DRIFT` ("PostgreSQL source inspection failed" or "did not apply the snapshot session settings") or `RMIG-E-SOURCE-NOT-READONLY`; switch to the direct connection. The target phases (`prepare-target`, `dry-run`, `import`, `validate`) run the released migrations and take advisory locks inside transactions, so use a direct connection for the target as well. The CLI verifies TLS to the target; for a local PostgreSQL without TLS put `sslmode=disable` in the URL held by the environment variable, and `PG_SSL_NO_VERIFY=1` keeps TLS but skips certificate verification.

### 1. Inspect the source

```bash
node scripts/v32-to-v4/cli.mjs inspect-source \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --report <source-report.json>
```

For a local SQLite or D1 export, use `--source-kind sqlite` or `--source-kind d1-export` and a local path. Continue only when the report says the exact public v3.2 catalog matched. The report includes row counts, ambiguity counts, image inventory, and old-vector inventory.

### 2. Export an encrypted bundle

```bash
node scripts/v32-to-v4/cli.mjs export \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --source-report <source-report.json> \
  --source-fingerprint <actual-fingerprint> \
  --migration-id <migration-id> \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file>
```

The source report and fingerprint options are accepted by the current parser. For the exceptional plaintext mode, replace the passphrase option with both explicit acknowledgement flags. Never mix the modes.

### 3. Verify the bundle

```bash
node scripts/v32-to-v4/cli.mjs verify-bundle \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file>
```

Use the same passphrase file and unchanged bundle. Verification checks stored-byte hashes, authenticated decryption, manifest hash, member counts, and NDJSON hashes.

### 4. Draft the decisions

```bash
node scripts/v32-to-v4/cli.mjs draft-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --out <decisions-draft.json>
```

The draft lists every value the migrator will not decide for you: duplicate entity names, entity kinds outside the v4 vocabulary, timestamps that are empty, have no offset or cannot be read, dates that are empty or cannot be read, malformed JSON, unknown enum values and contexts, broken foreign keys and name references, dormant observations, and tensions. Each item states why, which choices are allowed (`allowed_choices`), and which extra fields a choice needs (`required_choice_fields`). Nothing is guessed and no item has a choice, so a draft cannot be compiled. The command never overwrites an existing file. The draft does not hold the values themselves (only a hash of each observed value), so it is not what the owner decides from: step 5 shows them the values.

### 5. Review the decisions and apply the review

**The owner decides, from the real values, not from a summary.** The draft carries a hash of each observed value and not the value (it is a file that gets passed around, and it must not hold memory content), so nobody can decide a merge, the timezone of a time that has none, or a repaired JSON value from the draft alone. Anyone who opens the bundle to explain an item and frames the options has in effect chosen. So the owner reads the values themself, in the output of `review-decisions`:

```bash
node scripts/v32-to-v4/cli.mjs review-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-draft.json>

node scripts/v32-to-v4/cli.mjs review-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-draft.json> \
  --html <decisions-review.html>
```

`review-decisions` decrypts the bundle locally and renders every item with the real values it concerns next to its allowed choices and what each choice does: for a duplicate name, every colliding entity with its kind, context, dates, the number of observations, images and relations that depend on it and its first observations; for a kind v4 does not know, the value the source holds and the kinds v4 allows; for a time without a timezone, the value and the moment it would be stored as under UTC, +01:00 and -05:00; for malformed JSON, the text the source holds and the shape v4 expects; for a broken reference, the row that holds it and the rows you could link it to. Long values are cut and say how much was cut. A value is shown as JSON text, so a newline, a quote or a control, invisible or direction-changing character is written out and never acted on. The first lines say that the output shows memory content and must not be pasted into a chat.

- Without `--html` it prints to the terminal, for the person at the terminal. With `--html <file>` it writes one local HTML file that the owner opens, and the terminal prints one line and no value. The file is plain and self-contained: no script, no link, no image, no font, no frame, nothing loaded from a network (it uses the reader's own fonts), and a Content-Security-Policy (`default-src 'none'; style-src 'unsafe-inline'`) that forbids every load. It holds memory content in the clear on your disk: open it yourself, do not send it anywhere, and delete it when you have decided.
- The values are never written into the decision file, a report, a log or the `--json` result. `--json` is accepted only together with `--html`, and then prints counts and the path.
- Run on the draft it shows every item as open; run on an edited or reviewed file it also shows the recorded choice, who stated it and any bulk rule, so the owner can check what is about to be applied.
- It refuses a decision file that does not belong to the bundle (another migration, another bundle, a missing, extra, repeated or stale item) and never replaces an existing `--html` file.

**Recording the choices.** The owner states each choice; whoever edits the file (the owner, or an agent writing down exactly what the owner said) adds to every item a `choice`: one of its `allowed_choices` as a string, or an object whose `action` is one of them plus the fields it requires, for example `{ "action": "normalize-utc", "timezone": "+01:00" }`, `{ "action": "rename", "names": { "<id>": "<new name>", "<id>": "<new name>" } }`, or `{ "action": "preserve-visits-and-open", "last_visited": "<RFC 3339 time>" }`; and `stated_by`:

- `"stated_by": "owner"`: the owner said it.
- `"stated_by": "owner-accepted-agent-suggestion"`: an agent suggested it and the owner, having read the values in `review-decisions`, accepted it. It stays visible as such in the reviewed file, the compiled policy and the validation report.
- An optional `"bulk_rule": "<the owner's rule, in their words>"` on each item that one rule settled, for example `"rename every duplicate by appending its context"`. It is kept verbatim (one line, at most 500 characters) and counted in the report, so a reader can see which items were settled by a rule and what the rule said. A bulk approval must name its rule; "approve all" is not one.

A choice an agent made on its own has no value here, and so cannot be recorded: if the owner says "you decide", "whatever is sensible" or "approve all", that is not a choice. Show the options and their consequences again, and record only a choice the owner stated. `apply-decisions` refuses a chosen item with no `stated_by`, a `stated_by` that is neither of the two, and a malformed `bulk_rule`; it cannot tell who is typing, so `--reviewed-by` is the name of the owner who decided, never an agent's.

```bash
node scripts/v32-to-v4/cli.mjs apply-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-draft.json> \
  --reviewed-by "<name of the decision owner>" \
  --out <decisions-reviewed.json>
```

`apply-decisions` selects nothing itself. It records who reviewed and when, recomputes the manifest hash, and applies the library's validation against the verified bundle: an item without a choice, a chosen item without `stated_by`, a wildcard, a choice the item does not allow, a choice missing a required field, a stale or extra item, or a draft made for a different bundle is refused (`RMIG-E-POLICY-UNRESOLVED` or `RMIG-E-POLICY-MISMATCH`) and no file is written. It prints how many choices each kind of statement covers and each bulk rule with the number of items it settled. `compile-policy` and `validate` run the same validation, so a reviewed file edited by hand to drop a statement is refused there too.

### 6. Compile the policy

```bash
node scripts/v32-to-v4/cli.mjs compile-policy \
  --bundle <bundle.rmigrate> \
  --decisions <decisions-reviewed.json> \
  --out <compiled-policy.json> \
  --passphrase-file <passphrase-file>
```

The compiled policy holds migrated content (entity names, merged values), so it is **written encrypted by default**, with the same passphrase file that protects the bundle (AES-256-GCM, the same key derivation). It is plaintext only if you give both `--allow-plaintext-artifact` and `--acknowledge-plaintext-risk`; one of the two alone is refused (`RMIG-E-BUNDLE-PLAINTEXT-ACK`). Every command that reads it opens either form, and a wrong passphrase, a file of the wrong kind or a changed file is refused (`RMIG-E-BUNDLE-DECRYPT`). The file also names the migration it was made for, in its header and under the same authentication, and that id must be the `migration_id` of the artifact inside; `validate` and `plan-reembed`, which are told the migration id, refuse a file made for another one. An encrypted file written by an earlier build (`RMIGART1`, which did not carry the migration id) is refused: write it again. The command prints a summary (hash, loss count, whether the file is encrypted), never the policy, and it never replaces an existing `--out`: choose a new path.

### 7. Build the relational plan

```bash
node scripts/v32-to-v4/cli.mjs plan-relational \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --compiled-policy <compiled-policy.json> \
  --out <relational-staging-plan.json>
```

The compiled policy must be unchanged since `compile-policy` wrote it and bound to this bundle. The plan holds every v4 row, the loss report (what is dropped, what v4 fills in), the image inventory and the re-embedding job plan. A reviewed decision that produces a row v4 cannot hold is a refusal, not a skipped row. The command prints the `bundle_manifest_sha256` and `compiled_policy_sha256` that `prepare-target` takes. The plan holds the migrated content, so like the compiled policy it is written encrypted with the passphrase file unless you give both `--allow-plaintext-artifact` and `--acknowledge-plaintext-risk`. `prepare-target`, `dry-run`, `import`, `plan-images`, `plan-reembed` and `validate` read it (or the compiled policy) with the same `--passphrase-file`, and open a plaintext one without it. The decision files stay plaintext on purpose, because a person edits them; they hold hashes of ambiguous values and the choices you wrote, not the rows.

### 8. Inspect and prepare the fresh target

```bash
node scripts/v32-to-v4/cli.mjs inspect-target \
  --target env:RMIG_TARGET \
  --source env:RMIG_SOURCE

node scripts/v32-to-v4/cli.mjs prepare-target \
  --target env:RMIG_TARGET \
  --source env:RMIG_SOURCE \
  --migration-id <migration-id> \
  --bundle-manifest-sha256 <bundle-manifest-sha256> \
  --compiled-policy-sha256 <compiled-policy-sha256> \
  --plan <relational-staging-plan.json> \
  --passphrase-file <passphrase-file>
```

For a SQLite or D1-export source add `--source-kind sqlite` (or `d1-export`) and give the local path as `--source`; the identity checked against the target is then the file's. `inspect-target` must report a distinct fresh target. A concurrent session's temporary tables do not count as objects; a user table, any other schema, an extension other than `vector`, a view, a sequence, a function or a type does. `prepare-target` applies the released v4 migration set unchanged, verifies its checksums, creates a run-scoped staging schema and prints its name (`schema=`). The optional `--resume-schema <schema>` input is intentionally rejected: there is no general resume contract, so discard an interrupted target and restart against a fresh target. Existing/nonempty, same-source, or wrong-schema targets refuse.

### 9. Dry run, then import

```bash
node scripts/v32-to-v4/cli.mjs dry-run \
  --target env:RMIG_TARGET \
  --plan <relational-staging-plan.json> \
  --staging-schema <staging-schema> \
  --receipt-out <dry-run-receipt.json> \
  --passphrase-file <passphrase-file>

node scripts/v32-to-v4/cli.mjs import \
  --target env:RMIG_TARGET \
  --plan <relational-staging-plan.json> \
  --dry-run <dry-run-receipt.json> \
  --staging-schema <staging-schema> \
  --receipt-out <import-receipt.json> \
  --passphrase-file <passphrase-file>
```

Do not import without a successful dry-run receipt bound to the same plan, target identity, schema, policy, bundle, and migrator version. This is a gate, not a suggestion. The import commits once; the receipt path is reserved before it runs, so a committed import is never left without its receipt file (the same receipt is also recorded in the target's `migration_import_receipts` table).

### 10. Plan and hand off images

The image plan for a migration is the image inventory inside the relational plan, the one derived from the image rows that were imported. Take it from there:

```bash
node scripts/v32-to-v4/cli.mjs plan-images \
  --plan <relational-staging-plan.json> \
  --passphrase-file <passphrase-file> \
  --out <image-plan.json>

node scripts/v32-to-v4/cli.mjs copy-images \
  --plan <image-plan.json> \
  --adapter filesystem \
  --source <image-source-directory> \
  --target <image-target-directory> \
  --receipt-out <image-receipt.json> \
  --passphrase-file <passphrase-file>
```

`plan-images --plan` takes the migration id and the bindings from the relational plan, so it does not accept `--migration-id` or the two hash options with it. `plan-images --input <image-inventory.json>` (rows you supply) and `--source <directory>` (a directory's files) build a standalone inventory with `--migration-id`; that is useful for rehearsing a copy, but such a plan is not bound to the imported rows and `validate` will not accept it as image evidence. `plan-images`, `copy-images`, `plan-reembed` and every other command that writes a file refuse to replace an existing one.

For the external R2 handoff, use the same `copy-images` command with `--adapter r2 --external-receipt <external-r2-receipt.json> --trusted-public-key <trusted-public-key.pem>` instead of filesystem source/target. The operator/provider supplies the receipt; the CLI validates it and does not perform the network copy.

**What a v3.2 image row stores, and how the copy learns the rest.** The v3.2 `images` table stores a path and descriptive columns and nothing about the object: no hash, no size, no MIME type. So for a v3.2 source the image plan states none of them (`expected_sha256`, `expected_size` and `expected_mime` are `null`), and someone has to observe them. For a local copy the tool does. `copy-images --adapter filesystem` reads each source object from `--source` (the path in the row is relative to that directory) and fingerprints it: its SHA-256, its size and a MIME type detected from the bytes (the magic bytes), never from the file name. A JPEG named `.png` is `image/jpeg`, and a file that is not a recognised image is refused. It then writes the copy (never over a different object that is already there), reads the copy back and hashes it, hashes the source once more, and requires all of them to agree. The receipt records, per object, that fingerprint (`source_fingerprint`) and what the copy hashed to, and it is sealed with the migration passphrase (`--passphrase-file`, required for a filesystem copy: a local receipt has no signature, and `validate` accepts an unsigned receipt only with this seal).

A source object that is missing, unreadable, a symlink or reached through one, outside the source root, not an image, or changed while it was being copied refuses the whole copy: the command exits 2 with `RMIG-E-IMAGE-INCOMPLETE`, names each failed object by its target key and a reason (`missing`, `symlink`, `escapes-root`, `unsafe-path`, `unreadable`, `not-a-recognised-image`, `source-changed-after-fingerprint`, `source-changed-during-copy`, `copy-differs-from-source`, `target-holds-a-different-object`, `differs-from-plan`), and writes no receipt. Every source object is fingerprinted before anything is written, so a missing or unsafe object leaves the target directory untouched. An object that changed while it was being copied may leave its copy in the target directory; the next run refuses to replace it, so move it away and copy again. If a plan does state values (a source that stores them), the source, the copy, the receipt and the re-hash must all match them as well.

**What proves the image copy, and who decides.** The tool cannot see a copy made outside it, so `validate` decides what a receipt may prove from how you invoke it and never from a field in the receipt (a receipt's own `external_handoff` is ignored). The receipt that `copy-images --adapter filesystem` writes is a plain JSON file with no signature, and its hash can be recomputed by anyone who can write the file, including from the target directory itself. A receipt written to match the copied objects would prove nothing, so an unsigned receipt completes the images only when the tool has seen both ends and the receipt is the one the copy made:

1. You name the directory the objects were copied to, `--image-target-dir <directory>`, and `validate` reads every planned object there itself.
2. The receipt carries the keyed seal the copy made with the migration passphrase (`receipt_seal`, the same seal scheme as the report), and `validate` has that passphrase file to check it. A receipt with no seal leaves the images pending (`pending_reason: receipt-not-sealed`); a seal that does not verify is a finding (`image-receipt-seal-invalid`); a seal `validate` has no passphrase to check leaves them pending (`receipt-seal-needs-the-passphrase-file`). The seal shows who wrote the receipt; it does not show that the copy is right.
3. The objects are held to something other than the receipt. Either the plan itself states SHA-256, size and MIME type for every object (a source that stores them), or you name the directory the objects were copied from, `--image-source-dir <directory>` (it needs `--image-target-dir`), and `validate` re-hashes the source objects now, by the rules the copy uses (relative to that directory, no symlink, no path outside it, a regular file, a MIME type from the bytes). The source must be an image and equal the copied object, the fingerprint the receipt recorded and any value the plan states: a changed source is `image-source-differs-from-copy-fingerprint` and `image-source-differs-from-target`, a missing one `image-object-missing-in-source-dir`, a non-image `image-source-not-an-image`. Without it, and with a plan that states no values (every v3.2 source), the images stay pending, with `pending_reason: source-dir-required-to-check-an-unsigned-receipt`; that is not a finding, because the evidence is not wrong, only not enough.

With `--trusted-public-key`, a valid signature by that key is required instead, whatever else you supply, and the seal is not needed. With neither (an R2 handoff, or any copy you do not point `validate` at) an unsigned receipt can never complete the images (`external-image-receipt-invalid`). The report records which of four things the state rests on (`images.basis`): `tool-rehashed-source-and-target` (the tool re-read the source and the copy now and they are the same, and the receipt's fingerprint is that; the strongest), `tool-rehashed-target-against-plan` (the copy matches the values the plan states for every object; the originals were not read), `signed-receipt-rehashed-target` (a receipt signed by a key you trust, and the copy matches it) or `signed-receipt-attested` (only a signature you trust says the copy was made; the tool verified the signature, not the objects). The report says what the objects were held to (`images.expected_values`: how many are pinned by the plan and how many only by the receipt's fingerprint), and `status` prints it as `images_fingerprint` (`source-now`, `plan`, `copy-time-receipt` or `plan-and-copy-time-receipt`). Only the first is a look at the original sources, and only as they are when `validate` runs.

**A receipt for objects the tool cannot read (R2 or another store).** Whoever made the copy signs the receipt (Ed25519, the key you trust in `--trusted-public-key`), and for every planned image it must carry an entry bound to that row (the plan's `target_key`, `source_logical_path` and `target_locator`; an `image_id` or `source_id`, if the entry names one, must be the row's) and the values the operator observed for the object:

```json
{ "target_key": "images/7-0a1b2c3d4e5f6071", "source_logical_path": "images/portrait.png",
  "target_locator": { "store": "object", "key": "images/7-0a1b2c3d4e5f6071" }, "verified": true,
  "sha256": "<64 hex digits>", "source_sha256": "<the same 64 hex digits>", "size": 48213, "mime": "image/png" }
```

`sha256`, `size` and `mime` (an `image/...` type) are required whatever the plan holds; `source_sha256` must equal `sha256`; a `source_fingerprint` object, if present, must equal them; and where the plan states a value the receipt must state the same one. A signed receipt whose entries lack these is refused (`external-image-receipt-invalid`, reason `fingerprint-missing-or-malformed`), so is one that omits a planned image or lists one that is not planned. The signature proves who said it, not that it is true: the state is `signed-receipt-attested`.

### 11. Plan provider re-embedding

```bash
node scripts/v32-to-v4/cli.mjs plan-reembed \
  --input <relational-staging-plan.json> \
  --passphrase-file <passphrase-file> \
  --images <image-plan.json> \
  --out <reembed-plan.json> \
  --migration-id <migration-id> \
  --bundle-manifest-sha256 <bundle-manifest-sha256> \
  --compiled-policy-sha256 <compiled-policy-sha256>
```

The provider/network job is external. Do not claim readiness until every planned job has a receipt, or a reviewed defer decision reports `data-imported-not-search-ready`.

**What the re-embedding receipts can and cannot prove.** `validate` holds the receipts to the embedding model you state with `--embedding-model <model>` (required with `--reembed-receipts`; the model a v4 deployment embeds with is `MODEL` in `src/embeddings.ts`, `gemini-embedding-2-preview` in this release) and to the dimension of the target's own `embeddings.embedding` column, which `validate` reads from the target (`vector(768)`). Receipts for another model or dimension, receipts that disagree with each other, and receipts for rows that changed or are gone are findings. A receipt for an image job must also name the object that was embedded (`object_sha256`, `source_sha256`, `object_size`, `object_mime`, with the job's `source_logical_path` and `target_key`), and it must be the object that was copied: the plan's values where the plan states them (a v3.2 job states none, so its `object_*` fields are `null`), otherwise the fingerprint of the validated image copy. An image job cannot be verified without that image evidence (reason `object-binding-unverifiable`), so supply the image evidence in the same `validate` run. Even when all of that holds, re-embedding is **attested, not observed**: the tool cannot see the provider's work or the vectors, and the report says so (`reembed.basis: receipts-attested`, `observed_by_tool: false`).

### 12. Validate against the live systems, then read status

```bash
node scripts/v32-to-v4/cli.mjs validate \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-reviewed.json> \
  --plan <relational-staging-plan.json> \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --target env:RMIG_TARGET \
  --migration-id <migration-id> \
  --dry-run-receipt <dry-run-receipt.json> \
  --import-receipt <import-receipt.json> \
  --image-plan <image-plan.json> \
  --image-receipt <image-receipt.json> \
  --image-target-dir <image-target-directory> \
  --image-source-dir <image-source-directory> \
  --reembed-plan <reembed-plan.json> \
  --reembed-receipts <reembed-receipts.json> \
  --embedding-model <embedding-model> \
  --out <validation-report.json>

node scripts/v32-to-v4/cli.mjs status \
  --report <validation-report.json> \
  --passphrase-file <passphrase-file> \
  --cutover-evidence <cutover-evidence.json> \
  --operator-cutover-ack
```

`validate` reads the live source and the live target itself; it does not take snapshot files. The image and re-embedding options are optional. `--trusted-public-key <trusted-public-key.pem>` verifies a signed external image receipt, `--image-target-dir` lets `validate` re-hash the copied objects itself, `--image-source-dir` the objects they were copied from, and `--embedding-model` is required with `--reembed-receipts` (steps 10 and 11). Read-only throughout, it checks:

- **The decisions and the plan.** The reviewed decisions compile (again) to the policy the plan was built from, and the plan is exactly what that policy produces from the bundle.
- **The receipts.** The dry-run and import receipts are internally valid, derived from this plan, bound to this bundle, policy and target, and the import receipt equals the record the importer committed inside the target.
- **The source.** The live source still holds, row for row, what the bundle holds, with the same catalog fingerprint; a source that moved since the export is a finding.
- **The target, column by column.** Every mapped column of every source row is compared with what the target holds, in exact text: timestamps as exact microsecond instants (not text, not milliseconds), JSON as a value, numbers, ids, and text byte for byte. A cell may differ from the source only where the reviewed policy accounts for that exact cell (a remapped id, an enum alias, a normalized timestamp, a reviewed decision, a v4 default for a NULL), and each such difference is counted by kind in the report. The plan is then compared with the target row by row as well, over every column the target holds and not only the ones a plan row states: a column the plan leaves out may hold NULL, the column's own default, a value the database computes, or (for `identity.kind`) the value v4's trigger derives, and anything else is `target-column-not-in-plan`. A column that holds a value the plan did not state must hold what its default gives: `now()`, `CURRENT_TIMESTAMP` and `transaction_timestamp()` are evaluated as exactly the import's own time (the whole import is one transaction, and the importer records its time), and `nextval(...)` as an integer within the sequence's range, read from the target. A default the tool cannot evaluate (any other function or expression, or `now()` when the import record is missing) is a finding, `default-expression-not-evaluated`, that names the table and column; the report lists each such column with the number of cells (`comparison.plan_to_target.default_expressions_not_evaluated`), and because it is a finding the state is `refused`, never ready. There is no acknowledgement that sets it aside: a value the tool cannot confirm is not confirmed. (The released v4 schema has none, so a migration into it does not meet this.) Missing rows, extra rows and duplicates are findings.
- **The target's own integrity.** Every constraint validated, every index valid, every foreign key re-proved with an anti-join, every unique index free of duplicates (a unique index that is partial or built on an expression is not in the released schema, so it is a finding, `unique-index-unexpected`, and is not evaluated), every released CHECK expression re-evaluated against the stored rows (only a CHECK that is exactly one of the released v4 schema's, listed in `scripts/v32-to-v4/spec/v4-checks.json`, is ever run; any other CHECK in the target is a finding, `check-constraint-unexpected`, and its text is never executed, because it would run with the validator's rights; a released CHECK that is missing is `check-constraint-missing`), every id sequence beyond the largest id, every entity routed to exactly one people/nodes row, observation versions numbered without gaps and in time order, the released migration set recorded.
- **External evidence.** Evidence is held to the plans `validate` derives itself, never to the files it is handed. The image plan you supply must be, in canonical form, the image inventory in the relational plan that `validate` rebuilds from the bundle and the decisions (a smaller, an empty or a different image plan is a finding even when its receipt matches it exactly), every image row the target holds must be listed in it and every listed image must have its row, and its receipt must cover every planned object. The re-embedding plan must be the one these imported rows produce, and its receipts are checked against the content the target holds now: a receipt whose row changed or is gone is a finding (`target-content-changed`, `target-row-missing`). The target does not hold an image's bytes (they are in the object store), so they are proven only as step 10 describes: the tool's own re-hash of `--image-target-dir` (with the source objects in `--image-source-dir`, or values the plan states, and the seal on the copy's receipt), or a signed receipt, which is attested and not verified. For an image job, the re-embedding check holds the stored `images` row to the planned `images` row, column by column, and the receipt must name the object that was copied (step 11). Re-embedding receipts are held to the stated model and to the target's embedding dimension and are reported as `receipts-attested`. Evidence that is not supplied is not an error: the state stays `data-imported-images-pending` or `data-imported-not-search-ready`, never `ready-for-cutover`. A plan with no images, or no jobs, has nothing external to prove.

The report states counts, sanctioned differences by kind, invariants, who stated the reviewed choices (`decisions.stated_by`, the owner's bulk rules verbatim with the number of items each settled, and the ids of the choices that began as an agent's suggestion), and findings by check (table, column, and an integer id or a hash of the key, never row content), and its hash. Any finding makes `validate` write the report with status `refused` and exit with `RMIG-E-VALIDATION`; it never overwrites an earlier report, and the refusal names the report's real path (or says the path is withheld when it contains text that looks like a secret; the report is then at the `--out` you gave).

**What `validate` takes from the compiled output, and what it derives itself.** Column by column it compares the live target with the verified source rows, and derives for itself: timestamp instants, JSON values (digit for digit, so a number JSON.parse would round is a difference; an exponent is compared exactly however large; a document that repeats an object key at any depth is a difference, and in the source a `malformed-json` decision item, because JSON.parse would silently keep only the last copy; `-0` and `0` are one value, because PostgreSQL numeric cannot hold a negative zero), enum and context mappings (a case fold, an alias or a reviewed map is accepted only if the compiled policy recorded that exact value for that exact cell), version numbering, the values a reviewed entity merge gives the survivor (from the source rows and the reviewed field rules, not from the policy's own field values), a reviewed rename, and the reasons a row is skipped as merged. What it still takes from the compiled policy is stated here so nothing is assumed: the id map (target ids and tables of non-merged rows), the link map (reviewed re-links and nullifications), the name map used for relation endpoints, the list of reviewed exclusions together with the rows excluded because they depend on an excluded row, and entity kinds that a reviewed decision chose. Those come from the same reviewed decisions `validate` recompiles itself, so they are as good as the decisions, but they are not re-derived a second time.

**The seal.** `report_sha256` is a plain hash and anyone can recompute it after an edit. So when `validate` has a passphrase file (`--passphrase-file`, or `RM_MIGRATION_PASSPHRASE_FILE`) it also stores a keyed seal in the report: an HMAC whose key is derived (scrypt, a fresh salt per report) from that file. `status --report <report> --passphrase-file <passphrase-file>` verifies the seal and reports a state only for a report whose hash is its own and whose seal verifies. A report that was edited, or sealed with another file, is refused (exit 2). A report with no seal is labelled `unverified` with the plain statement that it is **not proof**; it is never reported as `ready-for-cutover`. The seal shows that the report was produced by a holder of the passphrase file and is unchanged since; it does not make the holder trustworthy. Cutover evidence that is supplied but does not validate (or is for another report) makes `status` answer `refused` and exit 2; it is never quietly set aside for a milder state. `status` must be read after validation and after any separately created cutover evidence. It does not perform cutover.

**Exit codes of `status`.** `0` means the report was verified (its hash is its own and its seal verifies) and its state was read. That is a statement about the report, not about readiness: `data-imported-images-pending` also exits 0, so read the state before deciding anything. `2` means `refused` (a report that does not match its own hash, a seal that does not verify, or cutover evidence that does not validate; the same code as every other refusal). `3` means `unverified`: the report carries no seal, so it is read for what it claims and proves nothing. A script that gates on `status` must treat `3`, like `2`, as not proven. `1` is an unexpected internal failure.

**What `status` tells you, and what it does not.** `status` never connects to the target. What it prints is what `validate` proved at the time it ran (`validated_at`) for the target it ran against (`target_identity_sha256`); the line says so, and carries `current_target_checked=false`. Only running `validate` again checks the target as it is now, so run it again before any decision that depends on the target's current state. The line also says what each part of the state rests on:

| Part | Values | Meaning |
| --- | --- | --- |
| relational | `verified-by-tool` | The source, plan and target were compared by the tool itself, column by column. |
| images | `tool-rehashed-source-and-target` / `tool-rehashed-target-against-plan` / `signed-receipt-rehashed-target` / `signed-receipt-attested` / `nothing-planned` / `pending` | The tool re-read the source and the copy and they are the same; or the copy matches values the plan states; or it matches a receipt signed by a key you trust; or only that signature says the copy was made. Only the first looks at the original sources. `images_fingerprint` says what the objects were held to: `source-now`, `plan`, `copy-time-receipt` (the copy's own record, signed) or `plan-and-copy-time-receipt`. |
| reembedding | `attested-by-receipts` / `nothing-planned` / `pending` | The receipts are checked against the plan, the stated model and dimension and the stored rows; the vectors are never observed. |
| cutover | `none` / `attested-by-operator` | With valid hash-bound cutover evidence the state is `complete-operator-attested`: the operator's statement that the cutover was made and read back, which this tool cannot observe. It is never verified. |

The state `complete-operator-attested` was called `complete-after-operator-cutover-evidence` in builds before the fourth review round; the CHANGELOG records the rename.

## Risks, sizing, and quiescence

- **Write races:** Quiesce v3 writes before inspection and keep the source frozen through the final comparison. If writes cannot be stopped, do not present a static export as a cutover source.
- **Semantic loss:** Review the loss/audit report, not just row counts. A row-count match can coexist with changed kind, timestamps, JSON, FK, tension, or dormancy meaning.
- **Target capacity:** Size from the source report's table counts, bundle member bytes, transformed plan size, image inventory, and re-embedding job count. Reserve working space for the encrypted bundle, temporary D1 materialization, reports, and staging overhead; do not substitute a fixed generic estimate.
- **Database pressure:** The dry run is the capacity and invariant check. Watch connection limits, transaction duration, lock/wait time, staging growth, and pgvector/index build time. Stop if the target changes unexpectedly or the operator cannot retain receipts.
- **Image/object divergence:** Metadata can import while an object copy is incomplete. Treat each object receipt and checksum as a separate gate.
- **Search readiness:** Data import is not search readiness. Legacy vectors are discarded and provider re-embedding is external.
- **Cutover risk:** A valid migration report does not deploy or switch application traffic. Schedule a human-approved maintenance window and retain untouched v3 until acceptance is complete.

## Troubleshooting

Every refusal is fail-closed. Refusals use exit code 2 (`2`), human text on stderr by default, and JSON on stdout when --json is set. Unexpected internal failures use exit code 1 (`1`); success is 0 (`0`). `status` alone has a third code, `3`, for a report it cannot verify (see the exit codes of `status` above). Preserve the refusal report and apply only its remediation—never suppress it or edit an artifact to make a check pass.

| Code | Meaning and operator action |
|---|---|
| `RMIG-E-NODE-VERSION` | Node is below 22. Run with Node.js 22 or newer. |
| `RMIG-E-SOURCE-ARG` | A source kind/path or command option is missing/invalid. Use only the documented parser options. |
| `RMIG-E-SOURCE-FINGERPRINT` | The source is not the exact public v3.2 schema. Restore a supported snapshot; do not infer compatibility. |
| `RMIG-E-SOURCE-DRIFT` | The source changed or drifted during the operation, or the database did not apply the snapshot session settings. Restore an unchanged snapshot and restart inspection; if the source is behind a connection pooler, use the direct connection. |
| `RMIG-E-SOURCE-NOT-READONLY` | Source access was not read-only. Grant read-only access and rerun. |
| `RMIG-E-D1-REMOTE-UNSUPPORTED` | A remote D1 name/URL was supplied. Run the manual `wrangler d1 export` and use the local SQL file. |
| `RMIG-E-D1-SQL-UNSAFE` | The D1 SQL export contains unsupported statements/schema, or turns foreign-key enforcement on (`PRAGMA foreign_keys=ON`; the refusal gives the statement number). Produce a standard local export, or delete that line. |
| `RMIG-E-BUNDLE-PLAINTEXT-ACK` | Plaintext mode lacks both explicit flags. Use encryption or provide both flags after risk review. |
| `RMIG-E-BUNDLE-INTEGRITY` | Bundle members or hashes changed. Regenerate from the verified source. |
| `RMIG-E-BUNDLE-DECRYPT` | The passphrase does not match the unchanged bundle. Use the correct secret-managed passphrase file. |
| `RMIG-E-SECRET-DETECTED` | Secret scanning found a sensitive value. Remove or resolve the finding before continuing. |
| `RMIG-E-POLICY-UNRESOLVED` | A decision remains unresolved. Review every policy item and compile again. |
| `RMIG-E-POLICY-MISMATCH` | Policy is not bound to this unchanged bundle. Compile against the exact bundle. |
| `RMIG-E-SAME-SOURCE-TARGET` | Source and target identities are the same. Choose a distinct fresh v4 PostgreSQL database. |
| `RMIG-E-TARGET-NOT-FRESH` | Target has non-system objects. Choose another empty target; never delete rows to bypass the gate. |
| `RMIG-E-TARGET-SCHEMA` | Target schema or released migration set is wrong. Prepare a fresh target with the exact released schema. |
| `RMIG-E-DRY-RUN-REQUIRED` | Apply was attempted without an accepted matching dry-run receipt. Complete the bound dry run. |
| `RMIG-E-DRY-RUN` | PostgreSQL staging dry run did not pass. Resolve the reported invariant/capacity issue and rerun on a clean target. |
| `RMIG-E-TARGET-CHANGED` | Target identity/schema changed after preparation. Restore the expected target state and rerun staging and dry-run validation. |
| `RMIG-E-ENTITY-COMPAT` | Entity compatibility/routing is inconsistent. Regenerate the plan with reviewed `people`/`nodes` routing. |
| `RMIG-E-RECEIPT-MISMATCH` | A receipt is not bound to the exact migration inputs. Regenerate it from the unchanged inputs. |
| `RMIG-E-IMAGE-INCOMPLETE` | An image object is missing, unsafe, not an image or changed while it was copied (`copy-images` names each failed object by its target key and a reason, and writes no receipt), or a receipt is incomplete or states no fingerprint for an object. Complete and verify every planned copy. |
| `RMIG-E-REEMBED-INCOMPLETE` | Re-embedding receipts are incomplete. Finish the external job or use a reviewed defer policy. |
| `RMIG-E-CHECKPOINT` | Checkpoint chain or artifact binding is invalid. Do not splice or edit it; use a new clean run. |
| `RMIG-E-CHECKPOINT-FAULT` | Test fault injection is enabled outside its test context. Unset it and rerun. |
| `RMIG-E-VALIDATION` | Final validation found a violation. The report is written anyway (status `refused`, findings by check). Resolve every finding and validate again to a new report path. |
| `RMIG-E-COMMAND-UNKNOWN` | Command is not listed. Run `--help` and choose a listed command. |
| `RMIG-E-COMMAND-NOT-IMPLEMENTED` | The named phase is not implemented in this checkout. Use an implemented phase; do not invent flags or bypass the phase. |

The exact refusal form is:

```text
<RMIG-E-CODE>: <safe summary> <remediation>. Report: <safe report path>
```

With `--json`, preserve `{ code, phase, summary, safe_details, remediation, report_path }`. Never paste secret-bearing details into the report or chat.

### A `dreams` table you added yourself

v3.2's dream engine writes to a `dreams` table that no v3.2 migration creates: `0001`–`0003` and `postgres.sql` have none. On a stock v3.2 install the dream step failed silently every night, so a stock v3.2 mind has no dreams to carry, and the migrator has no mapping for them. If you created the table yourself to make dreams work, `inspect-source` refuses with `RMIG-E-SOURCE-FINGERPRINT`, as it should: the schema is no longer the public v3.2 one.

To migrate anyway, keep the dreams out of the migration and bring them across afterwards:

1. Take your backup as usual, and work only on a copy: the local `wrangler d1 export` file for D1, a restored copy for PostgreSQL. Never change the live v3.2 database.
2. Save the dream rows from the copy (for example `SELECT * FROM dreams`, to CSV). Then remove the table from the copy: for a D1 export, delete its `CREATE TABLE dreams` statement, any `CREATE INDEX` on it and every `INSERT INTO dreams`; for a restored PostgreSQL copy, `DROP TABLE dreams`. `inspect-source` on that copy now matches the fingerprint.
3. Run the whole migration from that copy until `status` reports `ready-for-cutover`.
4. Only then insert the saved rows into v4's `dreams` table (`id`, `dream_date`, `content`, `emotional_seed`, `fragments`, `recurring_dream_id`, `recurrence_count`, `created_at`). Keep their `id`s, so `recurring_dream_id` still points at the right row; set `vectorized_at` to NULL, so the nightly sweep embeds a few each night; and set `composed_by = 'template'`, which is how v4 labels dreams from before composed dreams. Then move the id sequence past them: `SELECT setval(pg_get_serial_sequence('dreams', 'id'), (SELECT max(id) FROM dreams));`

`validate` does not compare `dreams`, because v3.2 has no such table to compare with, so rows added in step 4 do not change its result. Adding them after `ready-for-cutover` keeps the proof about everything else clean.

### Image rows with the path `pending`

A v3.2 image row keeps where its file is in `images.path`. On a v3.2 deployment that never had R2 enabled the path is the literal `pending`, and no file exists for the row anywhere: it holds the description, the links and the other metadata, and nothing to copy. To count them, run this against the v3.2 database (for D1, `npx wrangler d1 execute <binding-or-name> --remote --command "<the query>"`):

```sql
SELECT count(*) AS pending, (SELECT count(*) FROM images) AS total FROM images WHERE path = 'pending';
```

If `pending` is 0, this section does not apply. If it is not, the migrator reads each such row as an image to copy from a file called `pending`. `plan-images` lists one object for it, and the filesystem copy (`copy-images --adapter filesystem`) refuses with `RMIG-E-IMAGE-INCOMPLETE`, reason `missing` for each of those objects, and writes no receipt. One such row refuses the whole copy, so a mind that has some real images too gets no receipt for those either. Nothing is written to the target directory.

The migration stays at `data-imported-images-pending`. That state is accurate, and the import itself did not fail:

- The relational data, these rows included, is imported and checked column by column like any other; `validate` does not look at an image's file for that.
- The tool cannot report the images as complete, so it never reports `ready-for-cutover` or `complete-operator-attested` for this mind. The re-embedding plan has a job for each of these rows too, and a receipt for an image job must name the object that was copied, so those jobs cannot be receipted either.
- Nothing is lost. There was no file in v3.2 to lose. In v4 such a row is a description with its links and no picture: v4 serves an image only from a path that starts `r2://images/`, and a `pending` path answers 404.

The migrator has nothing made for these rows: no decision, policy item or `plan-images`/`copy-images` option excludes them or marks them as having no file, and a signed receipt would have to state the SHA-256, size and MIME type observed for an object that does not exist. Do not place a file called `pending` in the source directory to satisfy the copy; it would make the receipt say a picture was copied when none was. The state stays as it is. Whether to cut over from it is your decision, which the migrator does not make for you; if you do, record the `pending` count from the query above with the evidence listed in "Cutover and rollback".

## Interruption and restart

There is no general end-to-end resume contract for an operator run. The CLI exposes bounded checkpoint plumbing for internal artifact binding, but that is not permission to resume an arbitrary interrupted migration or reuse a partially written target. If an import, target preparation, image handoff, provider phase, or validation is interrupted or its evidence is ambiguous:

1. stop and preserve the receipts and logs;
2. do not retry writes into the interrupted target;
3. verify the untouched v3 source and backup;
4. discard/quarantine the target according to the operator's retention policy;
5. start again on a new fresh target with the same or a new reviewed migration ID, after checking artifact hashes.

A repeated command is not a proof that a partial target is safe.

## Cutover and rollback

Cutover is a human action after `validate` and `status` show readiness (`ready-for-cutover` rests on the tool's relational checks plus attested re-embedding, and on images as `status` names them) and the operator has separately recorded:

- source quiescence and final source identity;
- backup and restore rehearsal evidence;
- target identity, fresh-state evidence, and migration-set hash;
- policy, dry-run, import, image, re-embedding, and validation receipts;
- application smoke-test evidence on v4;
- a named approver and maintenance-window decision.

During cutover, stop writes, route the application to v4 through the normal deployment/change process, run smoke tests, and record the exact time and target identity. The migrator does not deploy, switch routing, or delete v3.

Rollback means stop v4 traffic and restore the application to the untouched v3 database using the normal operational change process. There is no reverse copy from v4 to v3. Do not mutate v3 to “undo” a cutover and do not delete the v3 backup until the retention window and acceptance decision are complete.

## Sensitive artifact retention

Keep the encrypted bundle, manifests, decisions, the compiled policy and the relational staging plan (both hold the migrated content and are encrypted with the passphrase file unless you wrote them as plaintext, in which case treat them like a plaintext bundle), source/target reports, image inventory, external receipts, and validation evidence only for the approved audit/rollback window. Restrict filesystem and object permissions, keep passphrases outside the artifact directory, and do not place sensitive values in filenames, logs, chat, or issue trackers. After the window, destroy the bundle, plaintext temporary exports, local D1 materializations, passphrase file, copied image staging area, and provider handoff artifacts using the organization's approved secure-destruction procedure. Retain only redacted hashes and non-sensitive evidence required by policy.
