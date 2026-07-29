import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID } from '../src/database/migrations/auth-refresh-token-integrity.migration';

loadLocalEnv();
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: resolvePgSsl(),
  extra: {
    max: 1,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

type Finding = { count: number; sampleIds: number[] };
const CAP = 20;

async function finding(countSql: string, idsSql: string): Promise<Finding> {
  const [count] = await dataSource.query(countSql);
  const sampleIds =
    Number(count.n) === 0
      ? []
      : (await dataSource.query(idsSql)).map((row: { id: number }) => Number(row.id));
  return { count: Number(count.n), sampleIds };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const [tables] = await dataSource.query(
    `SELECT
       to_regclass('public.auth_refresh_tokens') IS NOT NULL AS tokens_present,
       to_regclass('public.users') IS NOT NULL AS users_present`,
  );
  if (!tables.tokens_present || !tables.users_present) {
    throw new Error('auth_refresh_tokens/users table is missing');
  }

  const userOrphans = await finding(
    `SELECT COUNT(*)::int AS n
       FROM auth_refresh_tokens t
       LEFT JOIN users u ON u.id=t.user_id
      WHERE u.id IS NULL`,
    `SELECT t.id
       FROM auth_refresh_tokens t
       LEFT JOIN users u ON u.id=t.user_id
      WHERE u.id IS NULL
      ORDER BY t.id LIMIT ${CAP}`,
  );
  const replacementOrphans = await finding(
    `SELECT COUNT(*)::int AS n
       FROM auth_refresh_tokens t
       LEFT JOIN auth_refresh_tokens successor ON successor.id=t.replaced_by_id
      WHERE t.replaced_by_id IS NOT NULL AND successor.id IS NULL`,
    `SELECT t.id
       FROM auth_refresh_tokens t
       LEFT JOIN auth_refresh_tokens successor ON successor.id=t.replaced_by_id
      WHERE t.replaced_by_id IS NOT NULL AND successor.id IS NULL
      ORDER BY t.id LIMIT ${CAP}`,
  );
  const selfLinks = await finding(
    `SELECT COUNT(*)::int AS n FROM auth_refresh_tokens WHERE replaced_by_id=id`,
    `SELECT id FROM auth_refresh_tokens WHERE replaced_by_id=id ORDER BY id LIMIT ${CAP}`,
  );
  const invalidExpiry = await finding(
    `SELECT COUNT(*)::int AS n FROM auth_refresh_tokens WHERE expires_at <= created_at`,
    `SELECT id FROM auth_refresh_tokens WHERE expires_at <= created_at ORDER BY id LIMIT ${CAP}`,
  );
  const crossUserLinks = await finding(
    `SELECT COUNT(*)::int AS n
       FROM auth_refresh_tokens t
       JOIN auth_refresh_tokens successor ON successor.id=t.replaced_by_id
      WHERE successor.user_id <> t.user_id`,
    `SELECT t.id
       FROM auth_refresh_tokens t
       JOIN auth_refresh_tokens successor ON successor.id=t.replaced_by_id
      WHERE successor.user_id <> t.user_id
      ORDER BY t.id LIMIT ${CAP}`,
  );
  const cycleRoots = await finding(
    `WITH RECURSIVE chain AS (
       SELECT id AS root_id, id, replaced_by_id, ARRAY[id] AS path, false AS cycle
         FROM auth_refresh_tokens
       UNION ALL
       SELECT chain.root_id, successor.id, successor.replaced_by_id,
              chain.path || successor.id, successor.id = ANY(chain.path)
         FROM chain
         JOIN auth_refresh_tokens successor ON successor.id=chain.replaced_by_id
        WHERE chain.replaced_by_id IS NOT NULL AND NOT chain.cycle
     )
     SELECT COUNT(DISTINCT root_id)::int AS n FROM chain WHERE cycle`,
    `WITH RECURSIVE chain AS (
       SELECT id AS root_id, id, replaced_by_id, ARRAY[id] AS path, false AS cycle
         FROM auth_refresh_tokens
       UNION ALL
       SELECT chain.root_id, successor.id, successor.replaced_by_id,
              chain.path || successor.id, successor.id = ANY(chain.path)
         FROM chain
         JOIN auth_refresh_tokens successor ON successor.id=chain.replaced_by_id
        WHERE chain.replaced_by_id IS NOT NULL AND NOT chain.cycle
     )
     SELECT DISTINCT root_id AS id FROM chain WHERE cycle ORDER BY root_id LIMIT ${CAP}`,
  );

  const findings = {
    userOrphans,
    replacementOrphans,
    selfLinks,
    cycleRoots,
    invalidExpiry,
    crossUserLinks,
  };
  const blockers = Object.values(findings).reduce((sum, item) => sum + item.count, 0);
  console.log(
    JSON.stringify(
      {
        ok: blockers === 0,
        migrationTarget: AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
        findings,
        verdict:
          blockers === 0
            ? '적용 가능 — orphan/self-link/cycle/invalid-expiry/cross-user-link 0'
            : `적용 금지 — 차단 행/루트 합계 ${blockers}`,
      },
      null,
      2,
    ),
  );
  if (blockers > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

