import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/**
 * Minimal, dependency-free migration runner: applies every .sql file in
 * db/migrations, in filename order, that isn't already recorded in
 * schema_migrations. No down-migrations — per docs/architecture/
 * 02-database-schema.md, migrations are additive/forward-only.
 */
export async function runMigrations(pool: pg.Pool): Promise<{ applied: string[] }> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const already = new Set(rows.map((r) => r.filename));

  const applied: string[] = [];
  for (const file of files) {
    if (already.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return { applied };
}
