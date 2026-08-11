import { getPool, closePool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

const { applied } = await runMigrations(getPool());
if (applied.length === 0) {
  console.log("No pending migrations.");
} else {
  console.log(`Applied ${applied.length} migration(s):`);
  for (const f of applied) console.log(`  - ${f}`);
}
await closePool();
