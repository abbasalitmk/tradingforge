import { db, closeDb } from './client.ts';
import { runMigrations } from './migrations.ts';

/** CLI: `npm run migrate`. The engine also applies pending migrations at boot. */
async function main(): Promise<void> {
  const sql = db();
  const applied = await runMigrations(sql);
  for (const file of applied) console.log(`✓ ${file}`);
  console.log(applied.length === 0 ? 'up to date' : `applied ${applied.length} migration(s)`);
  await closeDb();
}

main().catch((e: unknown) => {
  console.error('migration failed:', e);
  process.exit(1);
});
