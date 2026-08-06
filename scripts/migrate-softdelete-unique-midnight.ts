// [TBO-86J] soft delete partial unique 잔여(users.email ci·subjects.code) + 자정 크로스 CHECK.
//  기본 dry-run(전체 실행 후 rollback 미리보기), APPLY=1일 때만 커밋+ledger 기록. 재실행 멱등.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SESSION_MIDNIGHT_CHECK,
  SOFTDELETE_UNIQUE_INDEXES,
  SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID,
  SOFTDELETE_UNIQUE_MIDNIGHT_SQL,
} from '../src/database/migrations/softdelete-unique-midnight.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false,
  entities: [], migrations: [], ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

type Executor = { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };

async function state(executor: Executor = dataSource) {
  const indexes = await executor.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
    [[...SOFTDELETE_UNIQUE_INDEXES]],
  ) as Array<{ indexname: string }>;
  const [check] = await executor.query(
    `SELECT COUNT(*)::int AS present, COUNT(*) FILTER (WHERE convalidated)::int AS validated
       FROM pg_constraint WHERE conname=$1 AND conrelid='public.class_sessions'::regclass`,
    [SESSION_MIDNIGHT_CHECK],
  ) as Array<{ present: number; validated: number }>;
  // 구식 전체 UNIQUE 잔존 여부(교체 완료 판정) — email/code 단일 컬럼 unique constraint
  const [legacy] = await executor.query(
    `SELECT
       (SELECT COUNT(*)::int FROM pg_constraint c
         WHERE c.conrelid='public.users'::regclass AND c.contype='u' AND array_length(c.conkey,1)=1
           AND c.conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.users'::regclass AND attname='email')) AS users_email,
       (SELECT COUNT(*)::int FROM pg_constraint c
         WHERE c.conrelid='public.subjects'::regclass AND c.contype='u' AND array_length(c.conkey,1)=1
           AND c.conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.subjects'::regclass AND attname='code')) AS subjects_code`,
  ) as Array<{ users_email: number; subjects_code: number }>;
  const [invalid] = await executor.query(
    `SELECT
       (SELECT COUNT(*)::int FROM (
          SELECT lower(email) FROM users WHERE deleted_at IS NULL AND email IS NOT NULL
          GROUP BY lower(email) HAVING COUNT(*) > 1) d) AS dup_email,
       (SELECT COUNT(*)::int FROM (
          SELECT code FROM subjects WHERE deleted_at IS NULL GROUP BY code HAVING COUNT(*) > 1) d) AS dup_code,
       (SELECT COUNT(*)::int FROM class_sessions WHERE end_time IS NOT NULL AND end_time <= start_time) AS bad_time`,
  ) as Array<{ dup_email: number; dup_code: number; bad_time: number }>;
  const [ledgerTable] = await executor.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  ) as Array<{ present: boolean }>;
  const [ledger] = ledgerTable?.present
    ? await executor.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID]) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return {
    indexes: indexes.map((row) => row.indexname),
    checkPresent: check?.present === 1,
    checkValidated: check?.validated === 1,
    legacyUsersEmailUnique: legacy?.users_email ?? -1,
    legacySubjectsCodeUnique: legacy?.subjects_code ?? -1,
    duplicateActiveEmail: invalid?.dup_email ?? -1,
    duplicateActiveCode: invalid?.dup_code ?? -1,
    invalidSessionTime: invalid?.bad_time ?? -1,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.indexes.length === SOFTDELETE_UNIQUE_INDEXES.length
  && value.checkPresent && value.checkValidated
  && value.legacyUsersEmailUnique === 0
  && value.legacySubjectsCodeUnique === 0
  && value.duplicateActiveEmail === 0
  && value.duplicateActiveCode === 0
  && value.invalidSessionTime === 0;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 10]);
      for (const sql of SOFTDELETE_UNIQUE_MIDNIGHT_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('softdelete/midnight dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 10]);
    if (!complete(await state(manager))) {
      for (const sql of SOFTDELETE_UNIQUE_MIDNIGHT_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('softdelete/midnight migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('softdelete/midnight ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
