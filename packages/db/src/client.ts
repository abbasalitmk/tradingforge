import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;

let instance: Sql | null = null;

export function db(url = process.env.DATABASE_URL): Sql {
  if (instance) return instance;
  if (!url) throw new Error('DATABASE_URL is not set');
  instance = postgres(url, {
    max: 10,
    idle_timeout: 30,
    // "already exists, skipping" on idempotent DDL is expected noise. Real
    // problems arrive as errors, not notices.
    onnotice: (n) => {
      if (n.code !== '42P07' && n.code !== '42710' && n.code !== '42P06') {
        console.warn('[pg notice]', n.message);
      }
    },
    // Money is BIGINT paise. Returning it as a JS string and parsing here is
    // safe up to Number.MAX_SAFE_INTEGER (~₹90,071,992,547 — far beyond any
    // account this will run against), and avoids BigInt leaking into arithmetic.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  });
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}
