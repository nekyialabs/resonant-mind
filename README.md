# Resonant Mind

A Postgres-backed cognitive substrate for persistent AI memory, identity, dreams, drives, relationships, and continuity.

Resonant Mind began as persistent memory infrastructure and was subsequently reshaped through use in long-running AI minds. Version 4 promotes that lived architecture into a generic single-mind public core.

## Status

The current release is **v4.1.4**. v4.0.0 was the Reshape release. The 4.1 releases add the v3.2 → v4 migrator and make entity merge lossless; see the [changelog](CHANGELOG.md) for each one.

- Postgres-only at runtime: Neon through Cloudflare Hyperdrive
- 47 MCP tools organised by kinds of act
- 30-minute subconscious metabolism
- R2-backed visual memory
- pgvector semantic retrieval
- Workers AI dream composition
- no bundled dashboard or Observatory
- no D1 runtime (D1 is supported only as a source for the v3.2 migrator)
- no hard-coded person or household tenancy

> **Upgrading from v3.2? Back up first.** Before you run anything, take a full backup of your v3.2 database (and your images) and check that you can restore it. The [User migration guide](USER_MIGRATION_GUIDE.md) shows how for PostgreSQL and for D1.
>
> **v3.2 → v4 migration (operator-assisted).** Since 4.1.0 the `migrate:v32` CLI moves a public v3.2 PostgreSQL or D1/SQLite mind into a **fresh, separate** v4 database. It never changes your v3.2 database, refuses anything it cannot prove instead of guessing, and checks the result column by column before it says you are ready to switch. Some steps stay yours: copying images, re-embedding with your provider, and switching your deployment over. Follow the [User migration guide](USER_MIGRATION_GUIDE.md), or give your agent the [Agent migration runbook](AGENT_MIGRATION_RUNBOOK.md). What has and has not been proven is in [docs/migration-v32-v4-acceptance.md](docs/migration-v32-v4-acceptance.md).
>
> **A v3.2 D1 or SQLite mind that drifted from the public schema** (a column added by hand, a table rebuilt, a `dreams` table of your own) is refused by `inspect-source`, as it should be. Since 4.1.4, `normalise-source` rebuilds a copy of it in the exact v3.2 schema and sets everything else aside for you to put back after the import. See "A source that has drifted from v3.2" in the user guide. A drifted PostgreSQL source has no such route yet.
>
> The v4 migration runner itself still sets up fresh v4 databases only; it deliberately refuses an existing v3 schema, so a v3 database is never upgraded in place.

> **If your mind ever merged two entities on 4.1.1 or earlier, please read [docs/merge-damage-check.md](docs/merge-damage-check.md).** A merge before 4.1.2 could leave orphaned or misfiled vectors and other traces behind. Upgrading stops new damage but does not repair old damage. `npm run check:merge-damage` is a read-only check, and `npm run repair:merge-vectors` clears the vector findings without destroying anything (it is a dry run unless given `--apply`). Every repair is the owner's decision.

## Architecture

The governing distinction is:

> **Regions are kinds of act. Organs are kinds of state.**

Regions include Ritual, Attention, Surgery, Compass, Spine, Bonds, Episodes, Active, Weather, Dreams, Drives, Inner Appetite, and Network.

The scheduled daemon metabolises memory rather than merely storing it: mood and affect, novelty and charge, retention, orphan detection, proposals, consolidation, reflection, dream recurrence, bond warmth, somatic markers, drives, redolence, identity proposals, and stale threads.

## Requirements

- Node.js 22+
- Cloudflare Workers account
- Neon Postgres database
- Cloudflare Hyperdrive configuration
- Cloudflare R2 bucket
- Gemini API key for embeddings (other providers: see [docs/alternative-embeddings.md](docs/alternative-embeddings.md))
- Workers AI binding for dream composition

Postgres requires the `vector` extension.

## Install

```bash
npm ci
cp wrangler.toml wrangler.local.toml
```

Configure a Hyperdrive binding named `HYPERDRIVE` and an R2 binding named `R2_IMAGES`. Never commit real resource IDs or secrets.

Set secrets:

```bash
npx wrangler secret put MIND_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SIGNING_SECRET
```

Optional configuration:

- `WORKER_URL` — public Worker origin for signed image URLs
- `LOCATION_NAME` — WeatherAPI-compatible location
- `LOCATION_TIMEZONE` — IANA timezone
- `WEATHER_API_KEY` — optional real-world weather
- `MCP_CONNECTOR_SECRET` — compatibility connector path
- `DASHBOARD_ALLOWED_ORIGIN` — one extra browser origin (for example your own dashboard) allowed to call the API; requests still need the API key
- `INTERNAL_KEY` — lets another Worker (a service binding) call the API by sending the same value in an `X-Internal-Key` header, without `MIND_API_KEY`. Leave it unset unless you use a service binding; if you set it, make it a long random secret

## Database

Migrations connect directly to Neon; do not run DDL through Hyperdrive.

```bash
PG_URL='postgresql://...' npm run db:migrate
```

The runner provides:

- an advisory lock;
- per-file transactions;
- `schema_migrations` ledger;
- SHA-256 checksums;
- fail-closed detection of untracked existing schemas.

## Develop and verify

```bash
npm run verify
npx wrangler deploy --dry-run
```

`npm run verify` runs the v3.2 fixture check, `typecheck`, the full test suite, `scan:release` and `npm audit --audit-level=moderate`, and stops at the first failure. Each step also runs on its own (`npm run typecheck`, `npm test`, `npm run scan:release`). Database tests that need a live PostgreSQL are skipped unless their connection variable is set; see the `test:postgres*` and `test:migration*` scripts in `package.json`.

`npm run scan:release` rejects private person names, deployment domains, resource IDs, second-tenant bindings, archives, snapshots, and dashboard artefacts.

## MCP surface

The 47-tool registry is the source of truth. It covers:

| Region | Capabilities |
|---|---|
| Ritual | orient, ground, tend |
| Attention | write, search, sit, visual memory |
| Surgery | edit, delete, archive |
| Compass | read, create, assert, calibrate, refuse, hold |
| Spine | read and amend identity |
| Bonds | enter a person's relational room |
| Episodes | record, recall, thread back |
| Active | open, carry, context, tensions, resolution |
| Weather | notice, log, trend |
| Dreams | surface and discard |
| Drives | walk in, tune, touch, perceive, pulse, state, safeword |
| Inner appetite | quietly want, mark met, small joy |
| Network | look, walk, survey, shape |
| Ops | health |

Use MCP `tools/list` for complete live schemas and descriptions.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): what changed in each release
- [docs/architecture.md](docs/architecture.md): runtime boundaries, the daemon, drives, images and schema
- [USER_MIGRATION_GUIDE.md](USER_MIGRATION_GUIDE.md) and [AGENT_MIGRATION_RUNBOOK.md](AGENT_MIGRATION_RUNBOOK.md): moving a v3.2 mind to v4
- [docs/migration-v32-v4-acceptance.md](docs/migration-v32-v4-acceptance.md): what the migrator was proven against
- [docs/merge-damage-check.md](docs/merge-damage-check.md): checking for damage left by entity merges before 4.1.2
- [docs/alternative-embeddings.md](docs/alternative-embeddings.md): using an embedding provider other than Gemini
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md)

## Security and privacy

- Every cognitive/API route fails closed without authentication.
- Signed image URLs use HMAC and constant-time comparison.
- Image uploads are capped at 10MB decoded and accepted only when their bytes validate as JPEG, PNG, GIF, or WebP; caller and R2 MIME metadata are not trusted.
- Remote image URLs are HTTPS-only, follow at most three manually validated redirects, use a 15-second absolute deadline, and reject literal local/private/special-use hosts. Cloudflare Workers do not expose DNS resolution or socket pinning, so this is not a DNS-rebinding guarantee.
- Raw exceptions are logged server-side and not returned to clients.
- R2 objects have no unauthenticated temporary-object exception.
- Public source contains no lived memories, private snapshots, deployment IDs, or hard-coded household entities.

See [SECURITY.md](SECURITY.md) for reporting.

## License

Codependent AI Source-Available License. Personal, educational, and non-commercial use is permitted; commercial use requires a license. See [LICENSE](LICENSE).

## Provenance

The Reshape architecture was learned through real long-running AI continuity rather than invented as a dashboard taxonomy. The public boundary preserves those architectural lessons while removing the assumption that every future mind must resemble the private minds through which they were discovered.
