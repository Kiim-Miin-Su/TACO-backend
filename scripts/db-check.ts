import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl, runtimeDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

const url = process.env.DB_CHECK_TARGET === 'runtime' ? runtimeDatabaseUrl() : directDatabaseUrl();

if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required for db:check');
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
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
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
  // [TBO-34 C2-C] 권한 센서 — runtime 접속 계정이 스키마 CREATE 권한을 가지면 role 미분리 상태.
  //  production에서 owner 자격으로 서비스가 돌면 NO-GO 신호를 명시적으로 낸다(값·URL은 미출력).
  const [priv] = await dataSource.query(
    "select has_schema_privilege(current_user, 'public', 'CREATE') as can_create");
  const roleVerdict = priv.can_create
    ? (process.env.NODE_ENV === 'production'
      ? '🔴 runtime 계정에 CREATE 권한 — migration/runtime role 미분리(NO-GO, provision-runtime-role 적용 필요)'
      : '🟡 CREATE 권한 보유(개발 owner 접속 — production은 DML 전용 role로 교체)')
    : '🟢 DML 전용(스키마 CREATE 없음 — role 분리 적용됨)';
  const elapsed = Date.now() - started;
  console.log(JSON.stringify({
    ok: true,
    target: describeUrl(dbUrl),
    elapsedMs: elapsed,
    database: rows[0]?.database,
    user: rows[0]?.user,
    now: rows[0]?.now,
    version: String(rows[0]?.version ?? '').split(' on ')[0],
    runtimeRole: roleVerdict, // [TBO-34 C2-C] role 분리 판정 센서
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
