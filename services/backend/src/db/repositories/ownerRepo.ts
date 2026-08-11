import type pg from "pg";

export interface OwnerRow {
  id: string;
  display_name: string;
  created_at: Date;
}

/** Single-user system: creates the one `owner` row on first boot if it doesn't exist yet. */
export async function ensureOwner(pool: pg.Pool, displayName: string): Promise<OwnerRow> {
  const existing = await pool.query<OwnerRow>("SELECT * FROM owner LIMIT 1");
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query<OwnerRow>(
    "INSERT INTO owner (display_name) VALUES ($1) RETURNING *",
    [displayName],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("Failed to create owner row");
  return row;
}

export async function getOwner(pool: pg.Pool): Promise<OwnerRow | undefined> {
  const { rows } = await pool.query<OwnerRow>("SELECT * FROM owner LIMIT 1");
  return rows[0];
}
