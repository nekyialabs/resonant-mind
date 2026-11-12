# Resonant Mind v4 architecture

Resonant Mind is a single-mind cognitive substrate deployed as a Cloudflare Worker over Neon Postgres through Hyperdrive.

## Runtime boundaries

- **Postgres/pgvector:** structured memory, identity, relational state, drives, dreams, daemon state, and semantic vectors.
- **Hyperdrive:** pooled runtime access from the Worker. Schema migrations connect directly to Neon.
- **R2:** original visual-memory objects. Database paths use the deployment-neutral `r2://images/` namespace.
- **Gemini embeddings:** text and multimodal vectors.
- **Workers AI:** manifest dream composition.

D1 and Vectorize as runtimes, multi-tenant household routing, and a bundled dashboard are not part of v4. (Inside the Worker, `env.DB` and `env.VECTORS` are adapters over Postgres and pgvector that keep the older query interface; they are not D1 or Vectorize.)

## Cognitive topology

> Regions are kinds of act. Organs are kinds of state.

The MCP surface is grouped into Ritual, Attention, Surgery, Compass, Spine, Bonds, Episodes, Active, Weather, Dreams, Drives, Inner Appetite, Network, and Ops. `src/mcp/registry.ts` is the source of truth for the 47 public tools.

State organs include observations, entities/people/nodes, relations, journals, images, identity, compass/provenance, relational weather, threads/tensions, dreams, drives/events/states, inner entries, proposals, orphans, and the subconscious snapshot.

## Subconscious metabolism

Every 30 minutes the daemon independently runs bounded passes for mood and affect, graph warmth, novelty and charge, proposals, orphan detection, archive and retention, consolidation, reflection, dreams, bonds, somatic markers, drives, redolence, identity proposals, stale threads, and compass exercise.

Pass failures are isolated so one optional organ does not silence the remainder of the tick. The final subconscious snapshot feeds orient, bond, and dream surfaces.

## Drives and sensorium

The public core accepts only reviewed normalised signals through `drive_pulse`:

- `inner_valence`
- `inner_arousal`
- `social_presence`
- `social_warmth`
- `care_deficit`
- `contact_hunger`
- `circadian_night`

Raw household, wearable, calendar, relationship, or health feeds belong in deployment-specific adapters outside this repository. The daemon merges only fresh pulse rows and always computes its own affect and circadian signals internally.

## Time

`LOCATION_TIMEZONE` controls orient periods, daemon night work, drive circadian state, and dream gating. UTC is the default and invalid zones fail safely to UTC.

## Images

Images are capped at 10MB decoded, identified from their bytes as JPEG, PNG, GIF, or WebP, and stored directly in R2 with a canonical extension and MIME type. Base64 and multipart inputs are bounded before and after decoding/parsing. Remote HTTPS retrieval uses manually validated redirects, a finite absolute timeout, and declared plus streamed byte ceilings; literal local/private/special-use hosts are rejected, but the Worker runtime cannot provide application-level DNS pinning. Signed view URLs use HMAC with bounded expiry and constant-time verification, and responses derive an allowlisted type from the canonical key with `nosniff` rather than reflecting R2 metadata. No unauthenticated temporary-object route or bundled image-conversion proxy exists.

## Schema

The Postgres migration runner uses an advisory lock, transactions, SHA-256 checksums, and a `schema_migrations` ledger. It supports fresh v4 databases and refuses an untracked existing schema.

A v3.2 mind is moved by the separate `migrate:v32` CLI (since 4.1.0), which reads the v3.2 source read-only and writes into a fresh, separate v4 database; it never upgrades in place. See the [user migration guide](../USER_MIGRATION_GUIDE.md).

## Entity merge

Both merge doors (`graph_shape` merge and `POST /api/entities/merge`) share one engine. Since 4.1.2 a merge is a single PostgreSQL statement: memories, their vectors, images, thread links, consolidation groups, relations and relational state all move to the surviving entity, or nothing changes. Merging an entity into itself is refused. For damage left by merges before 4.1.2, see [merge-damage-check.md](merge-damage-check.md).
