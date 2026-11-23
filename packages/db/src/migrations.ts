import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client.ts';

/**
 * Migrations are plain SQL, applied in filename order, each recorded in
 * schema_migrations so re-running is a no-op. Deliberately not a generated
 * schema: the audit-log triggers and partial unique indexes below are the
 * safety guarantees, and they need to be readable and reviewable as SQL.
 *
 * The engine runs this at boot, so a deploy can never start trading against a
 * schema older than its code.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply every pending migration; returns the file names applied. */
export async function runMigrations(sql: Sql): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    done.push(file);
  }
  return done;
}
