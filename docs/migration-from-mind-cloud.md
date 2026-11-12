# Migrating to Resonant Mind v4

The [user migration guide](../USER_MIGRATION_GUIDE.md) and the [agent migration runbook](../AGENT_MIGRATION_RUNBOOK.md) are the source of truth for the exact public v3.2 boundaries, evidence gates, CLI options, refusals, external handoffs, and manual cutover and rollback. This page only points the way.

## Fresh installations

Create an empty Neon Postgres database with the `vector` extension, set `PG_URL`, and run:

```bash
npm run db:migrate
```

The migration runner records checksums and refuses to modify an existing untracked schema.

## Existing v3.2 installations

Since 4.1.0 the `migrate:v32` CLI moves a public v3.2 mind (PostgreSQL, or D1/SQLite) into a **fresh, separate** v4 database. It never upgrades a v3 database in place and never changes the v3.2 source. Do not point the fresh-install runner at an existing v3 database: it refuses an untracked schema.

1. Back up the v3.2 database and its images, and rehearse the restore.
2. Follow the [user migration guide](../USER_MIGRATION_GUIDE.md) step by step: inspect, export an encrypted bundle, review every decision yourself, import into a fresh target, copy images, re-embed, then `validate` and `status`.
3. Switch your deployment over yourself, only after `status` reports `ready-for-cutover`. Rollback means pointing the deployment back at the untouched v3.2 configuration.

A D1 or SQLite mind whose schema drifted from the public v3.2 one can be rebuilt on a copy with `normalise-source` (4.1.4) first; see "A source that has drifted from v3.2" in the guide. A drifted PostgreSQL source has no such route yet.

What has and has not been proven is in [migration-v32-v4-acceptance.md](migration-v32-v4-acceptance.md).

## Private AI-mind deployments

Do not run the public migration chain against a private lived Mind. Private deployments have their own applied migration history and tenant configuration. Promote architecture through source review; never treat a live cognitive database as a public migration fixture.
