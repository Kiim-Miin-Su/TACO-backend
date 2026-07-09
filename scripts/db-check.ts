import 'reflect-metadata';
import { DataSource } from 'typeorm';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL or DATABASE_URL_UNPOOLED is required for db:check');
  process.exit(1);
}
const dbUrl = url;

const started = Date.now();
const dataSource = new DataSource({
  type: 'postgres',
  url: dbUrl,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  extra: {
    max: Number(process.env.DB_POOL_MAX ?? 1),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

function describeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

async function main() {
  await dataSource.initialize();
  const rows = await dataSource.query('select current_database() as database, current_user as user, version() as version, now() as now');
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({
    ok: true,
    target: describeUrl(dbUrl),
    elapsedMs: elapsed,
    database: rows[0]?.database,
    user: rows[0]?.user,
    now: rows[0]?.now,
    version: String(rows[0]?.version ?? '').split(' on ')[0],
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(JSON.stringify({
      ok: false,
      target: describeUrl(dbUrl),
      error: e instanceof Error ? e.message : String(e),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
