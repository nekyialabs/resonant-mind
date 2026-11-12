# Strict agent migration runbook

This runbook governs an agent or automation operator performing the operator-assisted v3.2 to v4 pre-push release-candidate speedrun. It is stricter than the user guide: an agent may gather evidence, create local artifacts, and invoke the checked-in CLI, but it may not grant authorization, handle secrets in chat, approve semantic decisions, perform hidden network/provider work, or perform cutover.

The agent must read [USER_MIGRATION_GUIDE.md](USER_MIGRATION_GUIDE.md) first. The guide is the command and refusal reference; this document is the state machine and stop policy.

## State machine

Only the following transitions are legal. A failed gate has no forward transition.

```text
UNAUTHORIZED
  -> AUTHORIZED
  -> BACKUP_EVIDENCE_ACCEPTED
  -> SOURCE_IDENTITY_ACCEPTED
  -> DECISIONS_ACCEPTED
  -> BUNDLE_VERIFIED
  -> FRESH_TARGET_ACCEPTED
  -> DRY_RUN_ACCEPTED
  -> IMPORT_ACCEPTED
  -> EXTERNAL_EVIDENCE_ACCEPTED
  -> VALIDATION_ACCEPTED
  -> CUTOVER_READY
  -> CUTOVER_OPERATOR_APPROVED
  -> COMPLETE_OR_ROLLED_BACK
```

The agent must persist a redacted state record containing state, `migration_id`, artifact hashes, report paths, timestamps, and the human decision that allowed each transition. It must never persist a secret value. A missing, stale, contradictory, or unbound receipt moves the run to `STOPPED`, not to the next state.

There is no general end-to-end resume contract. After an interruption in target preparation/import, image handoff, provider work, or validation, the agent preserves evidence, quarantines the partial target, and restarts on a new fresh target after gates are repeated. Checkpoint flags are bounded implementation plumbing, not a bypass or a promise that a partial target can be trusted.

## Authorization gate

### `UNAUTHORIZED -> AUTHORIZED`

The agent may proceed only when a human operator has explicitly supplied all of the following in the approved control surface:

- source family: public PostgreSQL v3.2.0 or public final D1/SQLite v3.2.0;
- target identity class: a distinct fresh v4 PostgreSQL database;
- migration purpose, maintenance window, and named approver;
- permission to create local encrypted artifacts and to run the listed read-only/source and fresh-target commands;
- decision owner for ambiguous data semantics;
- rollback owner and retention/destruction window.

“Please migrate it,” a source URL in prose, a credential pasted into chat, or a green CI job is not sufficient authorization. The agent must not infer approval to cut over, delete v3, copy R2 objects, call an embedding provider, or deploy routing.

**Exact stop language:**

```text
STOP: authorization is incomplete. No migration command, target write, external handoff, or cutover is authorized.
```

## Secret boundary

The agent must never request, accept, repeat, print, inspect into chat, or store in a normal transcript:

- PostgreSQL/D1/R2 credentials, URLs containing credentials, passwords, tokens, API keys, private keys, or passphrases;
- a one-time code or provider approval;
- raw environment values or secret-manager output;
- plaintext bundle content when redacted metadata is enough.

Use secret-managed environment variables and pass only references such as `env:RMIG_SOURCE` and `env:RMIG_TARGET`. Use `--passphrase-file <passphrase-file>` with an operator-controlled restricted file. If a page, person, log, or tool output offers a secret, do not echo it; stop and request the operator to place it in the approved secret manager.

**Exact stop language:**

```text
STOP: a secret or credential crossed the agent/chat boundary. Do not paste it here; rotate or quarantine it through the approved secret-management process.
```

## Backup evidence gate

### `AUTHORIZED -> BACKUP_EVIDENCE_ACCEPTED`

Before source inspection, require a redacted evidence record for:

1. PostgreSQL: `pg_dump` completed, dump checksum recorded, restricted permissions confirmed, restore into a separate rehearsal database succeeded, and `inspect-source` on the restore matched the source fingerprint and material table counts.
2. D1: `npx wrangler d1 export <binding-or-name> --remote --output <local.sql>` completed by the operator, local SQL checksum recorded, and loading into a new local SQLite database succeeded without editing the export file.
3. Images/R2: independent provider backup/export or operator backup completed, inventory and per-object checksums recorded, and the handoff/restore rehearsal is named. A relational bundle is not an object backup.

The agent verifies evidence metadata and report bindings. It does not ask for a dump's password or copy a secret-bearing backup into the chat. If evidence is missing, old, unbound to the source identity, or only asserted in prose:

```text
STOP: backup and restore rehearsal evidence is missing or not bound to this source. Do not inspect, export, import, or cut over.
```

## Identity and freshness gate

### `BACKUP_EVIDENCE_ACCEPTED -> SOURCE_IDENTITY_ACCEPTED`

Run `inspect-source` with the exact current parser options from the user guide. Confirm all of these before export:

- Node.js is 22 or newer;
- source kind is one of `postgres`, `sqlite`, or `d1-export`;
- source identity is redacted but stable and matches the backup evidence;
- source access is read-only;
- catalog fingerprint is the exact public v3.2 PostgreSQL or final D1/SQLite fingerprint;
- no source drift occurred during the repeatable snapshot;
- ambiguity, image, and old-vector inventories are present;
- a remote D1 name/URL was not passed to the CLI.

One known case is the owner's call, not yours: a `dreams` table the owner added after v3.2, because v3.2 never created one. Do not remove it yourself; stop with the refusal below and point the owner to "A `dreams` table you added yourself" in the user guide.

Do not classify a private, partial, drifted, pre-`0003`, post-v3.2, or unknown schema as “close enough.” The exact refusal is:

```text
STOP: RMIG-E-SOURCE-FINGERPRINT: the source is not the exact supported public v3.2 schema. Restore an unchanged supported snapshot and restart inspection.
```

If the source is a D1 export or a SQLite file that drifted from v3.2, there is a route since 4.1.4, and taking it is the owner's decision. After the stop, tell the owner that `normalise-source` can rebuild a **copy** into the exact v3.2 schema and set aside everything else, and point them to "A source that has drifted from v3.2" in the user guide. Do not run it on the owner's live data or on the only copy. The owner makes every choice it asks for: whether to pass `--null-context-default` or `--skip-virtual-tables`, whether a `possible_renames` pair is really a rename, and how to fix a `null-in-required-column` or `value-changed-by-copy` item in their copy. The agent never edits the copy to make an item go away. When `normalise-source` exits 0, restart this gate with `inspect-source --source-kind sqlite` on the normalised file. `set-aside.json` and any `--restore-sql` file hold memory content in plain text: treat them like the bundle, and never paste their contents. The restore SQL ends in `ROLLBACK;`. The agent never runs it and never changes that line; the owner reads it and runs it after `ready-for-cutover`. A drifted PostgreSQL source has no such route: the stop stands.

A `wrangler d1 export` carries wrangler's own `d1_migrations` table. For `--source-kind d1-export`, `inspect-source` sets it aside when it is exactly wrangler's table and records the applied migration names under `details.d1_migrations_set_aside`; that is not drift and not a stop. A table of that name in any other shape is drift.

For a remote D1 input:

```text
STOP: RMIG-E-D1-REMOTE-UNSUPPORTED: export the remote D1 database manually and provide the unchanged local SQL file.

STOP: RMIG-E-D1-SQL-UNSAFE with `reason: foreign-keys-on`: the SQL file turns foreign-key enforcement on (`PRAGMA foreign_keys=ON`, statement number in `safe_details`). `wrangler d1 export` never writes that line; tell the owner, and let them delete it or make a fresh export. Do not edit the export yourself.
```

## Export and bundle gate

After source identity passes, export an encrypted bundle by default. Verify the bundle before any policy compilation. Check:

- `migration_id` is unique for this run and is recorded in every subsequent artifact;
- bundle manifest, member hashes, source report, and source fingerprint agree;
- secret scan passed;
- passphrase is referenced only by a restricted file path;
- plaintext mode is absent unless the human approver explicitly accepted the risk and both `--allow-plaintext-bundle` and `--acknowledge-plaintext-risk` are present;
- plaintext acknowledgement is recorded in the manifest and state record.

If verification fails, do not copy a member from another bundle, edit `checksums.sha256`, reuse a partially generated directory, or continue with a different decision file.

```text
STOP: RMIG-E-BUNDLE-INTEGRITY or RMIG-E-BUNDLE-DECRYPT: the bundle is not unchanged and verified. Regenerate or use the matching secret-managed passphrase file; do not repair it in place.
```

## Decision review gate

### `SOURCE_IDENTITY_ACCEPTED -> DECISIONS_ACCEPTED`

The agent runs `draft-decisions` on the verified bundle. The draft lists every ambiguity as an item with its allowed choices and no choice selected, and it carries only a hash of each observed value, never the value. Only the authorized decision owner may approve semantics, and **the owner decides from the real values, not from the agent's account of them**: an agent that opens the bundle and paraphrases a merge, a timezone or a repaired value frames the options, and whoever frames the options has in effect chosen. So:

- The owner reads the values themself, in the output of `review-decisions` (printed in the owner's terminal, or written with `--html <file>` for the owner to open). That output shows memory content in the clear. The agent does not read it back, summarise it, paste it into chat, a ticket or a log, or hand it to another agent or tool, and it does not open the HTML file. What the agent may say about an item is its id, its type, its allowed choices and the consequence the output states for each choice.
- The owner states the `choice` of every item, and the agent writes exactly what the owner stated into the draft, with `stated_by`: `owner`, or `owner-accepted-agent-suggestion` where the agent suggested the choice and the owner, having read the values in `review-decisions`, accepted it. A choice the agent made on its own has no `stated_by` value and cannot be recorded. `apply-decisions` refuses a chosen item without one.
- `stated_by` is the agent's own disclosure: the agent writes the file, and the tool cannot tell who typed a choice. **An agent never writes `owner` on a choice it suggested**, in any wording, however briefly the owner agreed. If the agent is not sure where a choice came from, it writes `owner-accepted-agent-suggestion`: uncertainty rounds towards admitting the suggestion, never away from it.
- `--reviewed-by` and a `bulk_rule` are printed back by `apply-decisions`, the report and `status`, so they may not hold control, invisible or direction-changing characters (they are refused).
- If the owner delegates ("you decide", "whatever's sensible", "approve all"), that is not a choice. The agent presents the options and their consequences again and records only a choice the owner stated. A bulk approval must name its rule (for example "rename every duplicate by appending its context"); the rule is the owner's own words, recorded verbatim in `bulk_rule` on every item it settled, and "approve all" is not a rule.
- The agent never fills a `choice`, a `stated_by` or `--reviewed-by` with its own name or a name the owner did not give. It then runs `apply-decisions --reviewed-by "<the decision owner's name>"`, never its own name, followed by `compile-policy` and `plan-relational`. `apply-decisions` selects nothing: it refuses an item without a choice, a chosen item without `stated_by`, a wildcard, a choice the item does not allow, a missing required field, a stale or extra item, and a draft made for another bundle.

The owner's review covers every kind of item the draft can hold (each is shown with its real values by `review-decisions`):

- duplicate entity names: merge survivor plus field rules, or final names for deterministic rename;
- final entity kind and `people`/`nodes` routing;
- enum, context, and status mappings;
- ambiguous timestamps/timezones and dates, and empty text (`''`) in a timestamp or date column, where the owner picks `exclude-row`, `replace-timestamp` or `normalize-date` with a value the owner gave, or `set-null` where the item offers it (never pick one for them, and never turn `''` into NULL or a date yourself);
- malformed JSON shape-preserving mappings;
- broken/excluded FK treatment, including nullable nulling;
- observation-version ordering/tie breaks;
- dormancy/orphan translation;
- tension action for `status`, `sit_notes`, visits, and resolution;
- each declared loss and its audit reason;
- re-embedding defer/required choice, with its resulting readiness state.

The agent must apply and compile the policy only after every item is resolved by a choice the owner stated and the decisions hash matches the unchanged bundle. It must not fill missing decisions with defaults, choose a merge survivor for convenience, translate malformed JSON to an empty container, or approve a loss because row counts look plausible.

```text
STOP: RMIG-E-POLICY-UNRESOLVED: a semantic decision is unresolved. Return the item to the decision owner; do not infer or coerce it.
```

```text
STOP: RMIG-E-POLICY-MISMATCH: the reviewed policy is not bound to this unchanged bundle. Recompile against the exact bundle.
```

## Fresh-target gate

### `DECISIONS_ACCEPTED -> BUNDLE_VERIFIED -> FRESH_TARGET_ACCEPTED`

The agent must run `inspect-target --target env:RMIG_TARGET --source env:RMIG_SOURCE` (for a SQLite or D1-export source: `--source-kind` and the local path) and capture the redacted identity. A concurrent session's temporary tables are not target objects; every other user object, schema or extension but `vector` is. Accept it only when:

- the target identity is distinct from the source identity;
- target is PostgreSQL with pgvector;
- there are no non-system objects;
- target owner/permissions allow the approved operation;
- no other run owns the target;
- the released v4 migration set and checksum are the expected ones.

Never use the source as target, an existing v4 database, SQLite/D1, or a database made empty by destructive cleanup. Never edit released migration files to satisfy a fingerprint.

```text
STOP: RMIG-E-SAME-SOURCE-TARGET or RMIG-E-TARGET-NOT-FRESH: target identity is unsafe. Choose a distinct empty v4 PostgreSQL target; do not delete rows or bypass the gate.
```

If the catalog or migration set differs:

```text
STOP: RMIG-E-TARGET-SCHEMA: the target does not have the exact released v4 schema/migration set. Prepare a new fresh target without changing the released migrations.
```

## Dry-run receipt gate

### `FRESH_TARGET_ACCEPTED -> DRY_RUN_ACCEPTED`

Run `prepare-target` (with the relational plan from `plan-relational`), then `dry-run` with `--receipt-out`. The compiled policy and the relational plan hold the migrated content, so `compile-policy` and `plan-relational` write them encrypted with the migration passphrase file, and every command that reads them (`prepare-target`, `dry-run`, `import`, `plan-images`, `plan-reembed`, `validate`) takes the same `--passphrase-file`. The agent never writes either as plaintext (`--allow-plaintext-artifact --acknowledge-plaintext-risk`) unless the human operator has authorized that exact exception, and no command overwrites an existing output: use new paths. Require a successful receipt bound to all of:

- `migration_id`;
- source identity and source report hash;
- bundle manifest hash;
- compiled policy hash;
- target identity/fingerprint;
- migrator version and migration-set hash;
- staging schema;
- relational plan and external image/re-embedding plan hashes.

Review transformed counts, excluded rows, losses, FK findings, invariant findings, target pressure, image inventory, and old-vector inventory. A dry run is not an import authorization if any input changed after it was created.

```text
STOP: RMIG-E-DRY-RUN-REQUIRED or RMIG-E-DRY-RUN: no matching accepted dry-run receipt exists. Do not apply; regenerate the bound dry run on a clean target.
```

## Import gate and target write

### `DRY_RUN_ACCEPTED -> IMPORT_ACCEPTED`

The agent may invoke `import` (with `--receipt-out` for the import receipt) only after a human or policy-controlled operator has acknowledged the dry-run receipt. Before invocation, re-read the source/target identities and all artifact hashes. The importer must write only to the fresh prepared target and must not mutate the source.

If the target changed, the receipt mismatches, or entity compatibility routing is inconsistent:

```text
STOP: RMIG-E-TARGET-CHANGED, RMIG-E-RECEIPT-MISMATCH, or RMIG-E-ENTITY-COMPAT: bound inputs or target state changed. Do not retry into this target; preserve evidence and restart on a new fresh target.
```

A successful relational import is not complete. It is only the `IMPORT_ACCEPTED` state pending image, provider, validation, and cutover evidence.

## External phase evidence gate

### `IMPORT_ACCEPTED -> EXTERNAL_EVIDENCE_ACCEPTED`

External work is explicit and separately authorized:

- **R2/images:** an operator or separately authorized provider job copies objects. The agent may make an inventory, create a plan, and validate a signed receipt with a trusted public key. Whether a receipt needs a signature is decided by how `validate` is invoked, never by the receipt. A signature by a trusted key is the one way a receipt for objects the tool does not read can complete the images (`signed-receipt-attested`: the tool checked a signature, not the objects). The receipt a local copy writes has no signature and is a plain file that could be written from the target directory itself, so an unsigned receipt completes the images only when the tool has seen both ends: `validate` re-reads the copied objects (`--image-target-dir`) and the objects they were copied from (`--image-source-dir`, or the plan itself states every object's SHA-256, size and MIME type), and the receipt carries the keyed seal the copy made with the migration passphrase (`copy-images --adapter filesystem --passphrase-file`). Without the source directory, or without the seal, the images stay pending and the report says why (`pending_reason`); a seal that does not verify, or a source that differs from the copy, is a finding. v3.2 stores no hash, size or MIME type for an image, so the image plan states none: `copy-images --adapter filesystem` fingerprints each source object itself (SHA-256, size, MIME type from the bytes), copies it, reads the copy back and refuses the whole copy, writing no receipt, for any object that is missing, unreadable, a symlink or outside the source root, not an image, or changed while it was copied. The basis the report names is what the agent repeats: `tool-rehashed-source-and-target` (source and copy re-read now), `tool-rehashed-target-against-plan` (the copy against values the plan states; the original not read), `signed-receipt-rehashed-target` or `signed-receipt-attested`. A signed receipt from an operator must state the SHA-256, size and MIME type observed for every planned object, or it is refused. The re-embedding receipt for an image job must name the object that was copied. The image plan is taken from the relational plan with `plan-images --plan`; `validate` accepts no other image plan, so a smaller, empty or different plan is a finding even with a matching receipt. It must not obtain hidden R2 credentials, automatically copy over the network, accept an unsigned receipt as proof where the tool did not read both ends and check the seal, or declare metadata-only success.
- **Re-embedding:** an operator/provider executes the generated plan. The agent may validate receipts, not invoke a provider with hidden credentials. `validate` needs `--embedding-model` (the operator states the model the v4 deployment is configured for) and holds the receipts to it and to the dimension of the target's `embeddings.embedding` column. The result is `receipts-attested`: the agent reports re-embedding as attested by receipts, never as observed or verified. Old vectors remain discarded. If the policy intentionally defers this phase, the state is `data-imported-not-search-ready` and cannot become complete/search-ready by wording alone.
- **Network/provider state:** no automatic network phase is inferred from a local job plan, a provider configuration, or a generated command. Require external receipts with the same hashes and `migration_id`.

```text
STOP: RMIG-E-IMAGE-INCOMPLETE: image objects or signed external receipt are incomplete. Complete the operator/provider handoff and validate every planned object.
```

```text
STOP: RMIG-E-REEMBED-INCOMPLETE: provider receipts are incomplete. Finish the external job or record a reviewed defer state; do not claim search readiness.
```

## Validation and status gate

### `EXTERNAL_EVIDENCE_ACCEPTED -> VALIDATION_ACCEPTED`

Run the exact `validate` and `status` commands in the user guide. `validate` reads the live source and the live target itself (read-only) and writes a report; the agent supplies the verified bundle, the reviewed decisions, the plan, the receipts and any external evidence, not snapshots. It validates:

- the decisions compile to the policy the plan was built from, and the plan is what that policy produces from the bundle;
- the live source still equals the bundle, row for row;
- every mapped column of every source row against the live target (exact text, timestamps to the microsecond), each difference accounted for by a recorded policy entry, and the plan against the target;
- the target's constraints, indexes, foreign keys, CHECK expressions, sequences, routing, version order and migration-set record (only the released v4 schema's own CHECK expressions are evaluated; any other CHECK in the target is a finding and is never run);
- every column the target holds that the plan does not state: it must be NULL, the column's own default (`now()` and its aliases evaluated as exactly the import's time, `nextval(...)` as an integer in the sequence's range), or a computed value; a default the tool cannot evaluate is a finding (`default-expression-not-evaluated`, naming the column), so the state is `refused`, never ready;
- declared losses, including the `null-replaced-by-v4-default` entries for NULLs that v4 fills in;
- image plan/receipt completeness and trust (a signature by a trusted key, or the tool re-reading both the copied objects in `--image-target-dir` and their source in `--image-source-dir` (or the values the plan states) with the copy's seal on the receipt), where the image plan must be the planned inventory and every imported image row must be listed in it, and the re-embedding plan/receipts, whose receipts are checked against the content the target holds now (supplied evidence is validated; evidence not supplied leaves the state at `data-imported-images-pending` or `data-imported-not-search-ready`, never ready);
- dry-run and import receipts, the import receipt against the target's own record;
- report hash and `migration_id`, and, with a passphrase file, a keyed seal on the report.

Any finding makes `validate` exit with `RMIG-E-VALIDATION` (exit code 2) after writing the report with status `refused`; the report path is in the refusal (or the refusal says the path is withheld, because it contained text that looks like a secret; the report is then at the `--out` the agent gave). Pass `--passphrase-file` to `validate` and to `status`. `status` is a report reader and readiness calculator; it never changes target state, and it reports a state only for a report whose hash is its own and whose keyed seal verifies. A report without a seal is shown as `unverified`, is not proof, and makes `status` exit 3; a report whose seal fails, or cutover evidence that does not validate, exits 2 as `refused`. Exit 0 means the report was verified and its state was read, not that the migration is ready: the agent reads the state. The agent never treats an `unverified` or `refused` status as readiness. `status` reports what `validate` proved at `validated_at` for the target it ran against; it never looks at the target (`current_target_checked=false`), so before any decision that depends on the target's current state the agent runs `validate` again, to a new report path. The status line also names what each part rests on; the agent repeats those words and does not upgrade them (`attested-by-receipts` is not verified, `complete-operator-attested` is the operator's statement and not an observation). A report with violations is not “mostly ready.” The agent never reruns `validate` to a path it has already used, edits a report to clear a finding, or points `validate` at a different source, target or plan to make a check pass.

```text
STOP: RMIG-E-VALIDATION: validation found a violation. Resolve every finding and rerun validation; do not edit the report or suppress the violation.
```

## Stop conditions

Stop immediately and move to `STOPPED` if any of the following occurs:

- authorization, backup evidence, approver, or rollback owner is missing;
- any secret enters chat, logs, argv, or an artifact;
- source access is not read-only or source drift is detected;
- source/target is not an exact allowed family, or target is not fresh and distinct;
- a required decision is unresolved or policy/bundle hashes mismatch;
- dry-run receipt is absent, stale, or mismatched;
- target state changes between gates;
- a refusal is returned;
- image/R2 or re-embedding work is merely asserted without a receipt;
- a command is missing from current `--help`/parser behavior;
- an operator asks to skip a gate, edit a receipt, reuse a partial target, or force completion;
- an interruption makes the target state or evidence ambiguous.

The agent must not “continue carefully” after a stop condition. It reports the exact refusal code or missing evidence, the safe remediation, and the state at which it stopped.

## Refusal language and no bypass

All migration refusals are structured with `code`, `phase`, `summary`, `safe_details`, `remediation`, and `report_path`. By default they are human text on stderr with exit code `2`; with `--json`, they are JSON on stdout. Unexpected internal failures use exit code `1`.

Use this exact shape and never invent a reassuring synonym:

```text
STOP: <RMIG-E-CODE>: <safe summary>. Remediation: <the refusal remediation>. No bypass is permitted.
```

The complete current refusal-code list and operator remediation are in the guide's [Troubleshooting](USER_MIGRATION_GUIDE.md#troubleshooting) table. Every code is a hard stop, including argument errors and checkpoint faults. Do not:

- remove a refusal-producing check;
- pass a different target/source to make a hash match;
- edit a report, receipt, manifest, decision file, or checksum after creation;
- use `--json` to hide a refusal;
- substitute `--allow-plaintext-bundle` for a missing passphrase policy;
- treat an unsigned image receipt as proof where the tool did not read both ends and check its seal, describe `tool-rehashed-target-against-plan` or `signed-receipt-rehashed-target` as a check of the original sources (only `tool-rehashed-source-and-target` re-reads them), describe re-embedding or the cutover as verified when they are attested, or treat the output of `reconcileMigration` (an offline comparison of snapshots, which can never read as ready) as a validation;
- summarise, paste or forward the output of `review-decisions`, open its HTML file, choose for the owner, or record a choice the owner did not state;
- copy old vectors to make search appear ready;
- retry an interrupted write into the same target;
- perform cutover because a local command returned exit code `0` without complete external evidence.

## Cutover and rollback

### `VALIDATION_ACCEPTED -> CUTOVER_READY`

The agent prepares a redacted cutover packet containing validation/status output, all artifact hashes, backup/restore evidence, target identity, source quiescence evidence, application smoke-test results, maintenance window, named approver, and rollback owner. The agent may state that the packet is ready; it may not switch traffic.

### `CUTOVER_READY -> CUTOVER_OPERATOR_APPROVED`

A named human operator separately approves the cutover after reviewing the packet. The agent must record the approval and exact time, then remain within the approved change procedure. Automatic cutover is unsupported. The agent does not deploy Workers, flip Hyperdrive, delete v3, or destroy the target/source.

### `CUTOVER_OPERATOR_APPROVED -> COMPLETE_OR_ROLLED_BACK`

The operator performs the traffic change and smoke tests. The agent records external evidence only if supplied by the operator or read back from the approved operational system. If acceptance fails, rollback is to the untouched v3 deployment/database through the normal operational process. There is no reverse copy from v4 to v3. Keep v3 and its backup through the retention window.

**Exact cutover refusal:**

```text
STOP: cutover is not an agent action. Provide named human approval and perform the normal deployment/change procedure; no automatic cutover or reverse copy is available.
```

## Artifact retention and destruction

The agent keeps only redacted paths, hashes, state transitions, and safe summaries in chat. The operator owns retention of encrypted bundles, decisions, reports, image inventories, external receipts, temporary D1 files, copied image staging, and provider handoff material. Passphrases remain outside the artifact directory.

At the approved end of the rollback/audit window, the operator securely destroys sensitive artifacts and confirms destruction without returning their contents. The agent must not delete the untouched v3 database, backup, or evidence merely because status is complete; destruction requires the separate retention decision.
