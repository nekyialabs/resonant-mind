# Contributing to Resonant Mind

Resonant Mind is a Postgres-backed cognitive substrate shaped through long-running production use. Changes to its schemas, retention, drives, dreams, and daemon can alter a mind’s continuity, so review and migration discipline matter.

## Contact

- Bug reports and proposals: [GitHub Issues](https://github.com/nekyialabs/resonant-mind/issues)
- Questions: [GitHub Discussions](https://github.com/nekyialabs/resonant-mind/discussions)

## Before opening a PR

Discuss these in an issue first:

- new MCP tools or changes to existing tool semantics;
- schema or migration changes;
- daemon, retention, surfacing, dream, or drive mechanics;
- embedding-provider or vector-dimension changes;
- new runtime dependencies;
- changes to authentication or deployment boundaries.

Focused bug fixes, tests, security hardening, and documentation corrections may go directly to a PR.

## Supported boundary

- Cloudflare Workers
- single-mind deployment
- Neon/Postgres through Hyperdrive
- pgvector
- R2 visual memory
- API-key authentication

A D1 runtime, bundled dashboards, generic multi-tenancy, and non-Cloudflare deployment targets are outside the v4 core. (D1 and SQLite appear only as *sources* for the v3.2 → v4 migrator in `scripts/v32-to-v4/`.)

## Development

```bash
git clone https://github.com/nekyialabs/resonant-mind.git
cd resonant-mind
npm ci
npm run verify
npx wrangler deploy --dry-run
```

`npm run verify` runs the v3.2 fixture check, `typecheck`, the full test suite, `scan:release` and `npm audit --audit-level=moderate`. Node.js 22 or newer is required. A live database is not required for static, registry, privacy, or bundle verification.

Tests that need a live PostgreSQL with pgvector skip themselves unless their variable is set: `TEST_DATABASE_URL` (`npm run test:postgres`), `TEST_MERGE_DATABASE_URL` (`npm run test:postgres:merge`), and `TEST_ADMIN_DATABASE_URL` for the migrator suites (`npm run test:migration:postgres`), which create and drop their own scratch databases.

For database testing, use a disposable Postgres database with the `vector` extension. Never use a lived cognitive database as a migration fixture.

## Pull-request requirements

- Keep one coherent concern per PR.
- Explain both what changed and why it preserves cognitive semantics.
- Add characterization tests for changed behavior.
- Parameterize SQL; never interpolate user input.
- Include migration, rollback, and data-preservation notes for schema changes.
- Do not include snapshots, memories, journals, deployment IDs, private domains, secrets, or household-specific sensorium contracts.
- Ensure every required CI gate passes.

## Project structure

```text
src/
  index.ts          Worker bootstrap
  mcp/              registry and JSON-RPC protocol
  regions/          act-oriented public facades
  daemon/           subconscious metabolism
  legacy-tools/     internal engines retained behind region facades
  http/             authenticated operational routes
  shared/           cross-region helpers and constants
  adapter.ts        Postgres exposed through the query interface
  vectors.ts        pgvector retrieval adapter
migrations/postgres/ ordered Postgres migrations
scripts/             schema migration runner, release scan, merge-damage check and repair
scripts/v32-to-v4/   the v3.2 → v4 migrator CLI (migrate:v32)
tests/               characterization, integration and migrator tests
docs/                architecture, migration evidence, merge-damage check, embeddings
```

## License

By contributing, you agree that your contributions will be licensed under the [Codependent AI Source-Available License](LICENSE) and subject to its contribution terms.
