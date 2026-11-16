# Auto-supersede before 4.2.0: memories that may have been retired by mistake

**Who this is for:** anyone whose mind ran Resonant Mind 4.1.5 or earlier and writes long observations (journal-like paragraphs, notes, narrative) with `mind_write`. If your observations are mostly short facts, little here applies to you, but the check costs nothing: it is read-only.

**Please read this whole page before changing anything.** We cannot see your data, so we cannot tell you which of your memories were retired by mistake. What follows is what we know, a check that only reads, and one repair for you (the owner) to decide on. Nothing is deleted by any of this: a retired memory is still in the database, only hidden from search. If you are unsure, change nothing: 4.2.0 stops new cases from happening, and nothing below gets worse while you wait.

## What happened

When you added an observation to an entity, Resonant Mind looked for older observations on the same entity whose vector was at least 85% similar, and **retired** them as "superseded": it set `valid_until`, `superseded_by` on the old row and `supersedes` on the new one. `mind_search` hides retired observations unless `include_expired` is set.

That works for short facts ("lives in Leeds" then "lives in York"). For long observations written in one voice, similarity mostly measures topic and style, not replacement, so an observation that was *not* a rewrite could retire a different one. In one real mind, 270 of 810 observations had been retired this way; the retired ones were typically about 1,300 characters long and shared very few words with the one that retired them. Nothing reported the total.

4.2.0 changes this:

- Automatic retiring only happens when **both** observations are 280 characters or fewer.
- A longer pair that would have been retired becomes a **possible supersede** proposal in `ritual_tend`. Accepting it retires the older one; rejecting it keeps both. Nothing is retired without your say.
- `AUTO_SUPERSEDE` lets you choose the threshold (a number above 0 up to 1; default 0.85) or turn the whole thing off (`off`: nothing is retired and no proposals are made).
- `mind_health` shows how many observations are superseded in total and in the last 7 days.

4.2.0 does **not** un-retire anything that was retired before. That is what this page is for.

## Step 1 — back up

Take a backup you know how to restore before anything else, even though the check itself only reads:

```bash
pg_dump --format=custom --file=mind-before-supersede-check.dump "$PG_URL"
```

## Step 2 — run the check (read-only)

From a checkout of 4.2.0:

```bash
PG_URL='postgres://…' npm run check:supersede
# or, for an agent:
PG_URL='postgres://…' npm run check:supersede -- --json
```

It opens one `READ ONLY` transaction, runs one `SELECT`, rolls back, and prints counts and, for each retired observation: its id, the id of the one that retired it, the entity id, both text lengths, both added dates, when it was retired, and a **word overlap** figure (0 to 1: the share of 4-letter-or-longer words the two share). It reads the text only to measure it, and never writes and never prints memory content. The human report lists the first 50 pairs; `--json` lists all of them. Exit code `0`: nothing superseded; `1`: some are; `2`: the check could not run. TLS works as for `db:migrate` (verified by default, `PG_SSL_NO_VERIFY=1` to skip verification, `sslmode=disable` in the URL for a local database).

How to read it:

- **Both sides 280 characters or less:** short facts, the case auto-supersede was built for. Usually right.
- **Either side longer, with low overlap** (the report counts overlap below 0.2): most likely a memory that was retired although it was not rewritten. These are the ones to look at.
- Overlap is a hint, not a verdict. Only you can tell whether a newer observation really replaces an older one.

## Step 3 — repair, owner's choice

The owner reads the pairs they care about **locally** (the database, not a chat), and picks the old ids to bring back. This undoes the retirement of exactly those observations: it clears `superseded_by` and `valid_until` on the old row, and `supersedes` on the new row that points at it. Nothing else changes, and the memories' vectors were never touched, so they show up in search again at once.

The block is wrapped in a transaction that ends in `ROLLBACK`, so running it as written changes nothing and shows how many rows it *would* change. Only when the owner has agreed, change `ROLLBACK` to `COMMIT` and run it again. Replace `101, 102` with the chosen old ids.

```sql
BEGIN;
-- the newer rows that point back at the chosen old ones
UPDATE observations SET supersedes = NULL
 WHERE supersedes IN (101, 102);
-- the chosen old rows
UPDATE observations SET superseded_by = NULL, valid_until = NULL
 WHERE id IN (101, 102) AND superseded_by IS NOT NULL
RETURNING id;
ROLLBACK;  -- COMMIT once the owner has agreed
```

Run `npm run check:supersede` again afterwards: the count should fall by the number of ids you chose.

A newer observation can hold only one `supersedes` pointer, so if it retired several older ones, only one of them is named there. The old rows (`superseded_by`) are what matter: they are what hides a memory.

## For agents running this for someone

- Run the backup (or confirm the owner has one) and the check. Both are safe. Show the owner the report as it is.
- **Do not run the repair unless the owner has said yes to that specific repair**, naming the ids, after seeing what it changes. "Fix whatever you find", "bring them all back" or "do what's sensible" is not a yes to specific ids: present the pairs again and let the owner choose. Record what they chose and when.
- Do not paste memory content (the `content` column, observation text) into a chat or an issue. Show it to the owner locally.
- If anything in the report surprises you or doesn't match this page, stop and tell the owner. Don't improvise a repair.

## If something goes wrong

Restore the backup from step 1 (`pg_restore --clean --dbname="$PG_URL" mind-before-supersede-check.dump`), and open an issue on the repository with the check's `--json` output, which holds ids, lengths, dates and counts but no memory content. Please don't attach memory content.
