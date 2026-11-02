# Entity merge before 4.1.2: what it can have left behind, and how to check

**Who this is for:** anyone whose mind ran an entity merge (`graph_shape` → `merge`, or `POST /api/entities/merge`) on Resonant Mind 4.0.0 to 4.1.1. Earlier releases (3.x, Mind Cloud) used the same merge code, so a mind migrated from them may carry the same vector problems; the check below reads the v4 schema, so run it on the v4 database.

**If you never merged two entities, nothing here applies to you.** Running the check costs nothing either way: it is read-only.

**Please read this whole page before changing anything.** We cannot see your data, so we cannot tell you what happened in your mind or check a repair for you. What follows is what we know, a check that only reads, and repair notes for you (the owner) to decide on, one at a time. Every repair below changes your data, and every one of them is your decision. If you are unsure, change nothing: 4.1.2 stops new damage from happening, and nothing below gets worse while you wait.

## What happened

Until 4.1.2, merging entity A into entity B moved A's memories (`observations`) and relations to B, then deleted A. It did not move anything else that pointed at A, so:

| | What the old merge did | What you can see | Check |
|---|---|---|---|
| 1 | Left A's memory vectors filed under A (key `obs-A-…`, metadata name "A") | Search shows the old name | MD-3 |
| 2 | Left A's own entity vector behind | Entity search can surface A | MD-4 |
| 3 | Later, deleting a moved memory left its vector behind | Search can surface a memory that no longer exists | MD-1 |
| 4 | Later, editing a moved memory created a second vector | Search can return it twice, one with the old text | MD-2 |
| 5 | Left the memories' `person_id`/`node_id` pointing at A | Merged memories missing from the bonds view | MD-5 |
| 6 | Unlinked A's images (`entity_id` set to NULL) | Images attached to no entity | MD-7 |
| 7 | **Deleted A's thread links** (database cascade) | Threads no longer mention the merged entity | not detectable |
| 8 | Stopped half-way if A had a consolidation group: memories moved, A not deleted, an error returned | Both entities exist; some memories point two ways | MD-6 |
| 9 | **Merging an entity into itself deleted the entity and every one of its memories** | Memories gone | MD-1 (their vectors may remain) |

Nothing in 1 to 6 or 8 deleted a memory: the rows are still there, filed or linked wrongly. Rows 7 and 9 did delete data. For 9, the memory's vector (MD-1) may still hold its text in the `content` column, and may be the only copy left besides your backups.

4.1.2 fixes the merge: it carries all of the above to B in one atomic statement (either everything moves or nothing changes), refuses to merge an entity into itself, and the release is tested against a real PostgreSQL + pgvector database. It does **not** repair what an earlier merge already left; that is what this page is for.

## Step 1 — back up

Take a backup you know how to restore before anything else, even though the check itself only reads:

```bash
pg_dump --format=custom --file=mind-before-merge-check.dump "$PG_URL"
```

## Step 2 — run the check (read-only)

From a checkout of 4.1.2:

```bash
PG_URL='postgres://…' npm run check:merge-damage
# or, for an agent:
PG_URL='postgres://…' npm run check:merge-damage -- --json
```

It opens one `READ ONLY` transaction, runs `SELECT`s, rolls back, and prints a count and the row ids (at most 50) for each check. It never writes and never prints memory content. Exit code `0`: nothing found; `1`: findings; `2`: the check could not run. TLS works as for `db:migrate` (verified by default, `PG_SSL_NO_VERIFY=1` to skip verification, `sslmode=disable` in the URL for a local database).

A finding is not proof that a merge caused it: an old bug elsewhere, a manual edit or an earlier migration can leave the same shape. The table above says what each finding *usually* means.

## For agents running this for someone

- Run the backup (or confirm the owner has one) and the check. Both are safe. Show the owner the report as it is.
- **Do not run any repair below unless the owner has said yes to that specific repair**, after seeing what it changes. "Fix whatever you find", "do what's sensible" or "approve all" is not a yes to a specific repair: present the repairs again and let the owner choose. Record what they chose and when.
- **Never delete MD-1 vectors before the owner has reviewed them** (see below): they can be the last copy of a deleted memory.
- Do not paste memory content (the `content` column, observation text) into a chat or an issue. Show it to the owner locally.
- If anything in the report surprises you or doesn't match this page, stop and tell the owner. Don't improvise a repair.

## Step 3 — repairs, one at a time, owner's choice

Upgrade to 4.1.2 first: on an older release, deletes and edits keep producing MD-1 and MD-2. Each block below is wrapped in a transaction that ends in `ROLLBACK`, so running it as written changes nothing and shows how many rows it *would* change. Only when the owner has agreed, change `ROLLBACK` to `COMMIT` and run it again. Run the check again after each one. Order matters where it says so.

**MD-1 — vectors of deleted memories. Review before anything.** Export them first and let the owner read them locally:

```sql
\copy (SELECT id, source_id, content, metadata FROM embeddings e WHERE source_type = 'observation' AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id) ORDER BY id) TO 'orphan-vectors.csv' CSV HEADER
```

If any of them are memories the owner wants back (likely after a merge of an entity into itself), re-create them as new memories with `mind_write` before going further. Only then, if the owner wants the leftovers gone:

```sql
BEGIN;
DELETE FROM embeddings e WHERE source_type = 'observation'
  AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id);
ROLLBACK;  -- COMMIT only after the owner has reviewed the export
```

**MD-2 — more than one vector per memory. Do this before MD-3.** Keeps the vector at the memory's current key (where edits write, so it holds the newest text), otherwise the newest:

```sql
BEGIN;
DELETE FROM embeddings e
 WHERE e.source_type = 'observation'
   AND EXISTS (SELECT 1 FROM observations o WHERE o.id = e.source_id)
   AND e.id <> (
     SELECT k.id FROM embeddings k JOIN observations o ON o.id = k.source_id
      WHERE k.source_type = 'observation' AND k.source_id = e.source_id
      ORDER BY (k.id = 'obs-' || o.entity_id || '-' || o.id) DESC, k.created_at DESC NULLS LAST, k.id DESC
      LIMIT 1);
ROLLBACK;
```

**MD-3 — vectors filed under the old entity.** Re-files each vector under its memory's current entity and name. The vector values are not recomputed. Fails with a duplicate-key error (and changes nothing) while MD-2 still has findings, including when MD-2 was only dry-run; commit MD-2 first.

```sql
BEGIN;
UPDATE embeddings e
   SET id = 'obs-' || o.entity_id || '-' || o.id,
       metadata = jsonb_set(COALESCE(e.metadata, '{}'::jsonb), '{entity}', to_jsonb(x.name))
  FROM observations o JOIN entities x ON x.id = o.entity_id
 WHERE e.source_type = 'observation' AND e.source_id = o.id
   AND (e.id <> 'obs-' || o.entity_id || '-' || o.id OR e.metadata->>'entity' IS DISTINCT FROM x.name);
ROLLBACK;
```

**MD-4 — entity vectors of deleted entities.**

```sql
BEGIN;
DELETE FROM embeddings e WHERE source_type = 'entity'
  AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = e.source_id);
ROLLBACK;
```

**MD-5 — person/node link pointing at a deleted entity.** Points each memory's subject at the entity it already belongs to (`entity_id`):

```sql
BEGIN;
UPDATE observations o
   SET person_id = CASE WHEN EXISTS (SELECT 1 FROM people p WHERE p.id = o.entity_id) THEN o.entity_id END,
       node_id   = CASE WHEN NOT EXISTS (SELECT 1 FROM people p WHERE p.id = o.entity_id)
                         AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = o.entity_id) THEN o.entity_id END
 WHERE COALESCE(o.person_id, o.node_id) IS DISTINCT FROM o.entity_id
   AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.id = COALESCE(o.person_id, o.node_id));
ROLLBACK;
```

**MD-6 — a merge that stopped half-way.** No query here: the owner decides. For each finding, `person_id`/`node_id` is the entity the merge came *from* and `entity_id` the one it went *into*. If the owner still wants that merge, run it again on 4.1.2 (it now carries consolidation groups); if not, leave it.

**MD-7 — unlinked images.** No query here. The database no longer knows which entity an image should belong to; `person_id`/`node_id` hold the id of the entity it used to belong to, which the owner can match against their own record of the merge. Re-attach by hand only where the owner says where.

**MD-8 — relations naming a missing entity.** No query here: the owner decides whether to rename, re-point or delete each one.

**Thread links (not detectable).** If they matter, compare `thread_entities` with the backup taken before the merge, or with an older backup.

## If something goes wrong

Restore the backup from step 1 (`pg_restore --clean --dbname="$PG_URL" mind-before-merge-check.dump`), and open an issue on the repository with the check's `--json` output, which holds ids and counts but no memory content. Please don't attach memory content.
