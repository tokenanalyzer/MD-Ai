# db

`migrations/` — versioned SQL, applied in numeric order, see
`docs/architecture/02-database-schema.md`.

`schema/` — Drizzle ORM schema definitions mirroring the migrations, used
for typed query building (not for generating migrations — SQL migrations
are the source of truth, Drizzle schema is kept in sync with them by hand
or `drizzle-kit introspect`).

`client.ts` — single Postgres pool instance, exported for use by
`core/*` modules.
