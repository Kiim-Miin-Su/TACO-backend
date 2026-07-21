import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

type Candidate = { id: number; role: string; status: string };

async function candidates(): Promise<Candidate[]> {
  return dataSource.query(`SELECT id, role, status
    FROM users
    WHERE deleted_at IS NULL AND email_verified = false AND status = 'pending'
    ORDER BY id`);
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const before = await candidates();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, candidates: before }, null, 2));
    return;
  }
  if (before.some((row) => row.role === 'super_admin' || row.role === 'manager')) {
    throw new Error('대표/매니저 후보가 포함되어 자동 정리를 중단합니다.');
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [36, 7]);
    const locked: Candidate[] = await manager.query(`SELECT id, role, status
      FROM users
      WHERE deleted_at IS NULL AND email_verified = false AND status = 'pending'
      ORDER BY id FOR UPDATE`);
    if (locked.some((row) => row.role === 'super_admin' || row.role === 'manager')) {
      throw new Error('대표/매니저 후보가 포함되어 자동 정리를 중단합니다.');
    }
    if (!locked.length) return;
    const [actor] = await manager.query(`SELECT id FROM users
      WHERE role = 'super_admin' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1`);
    if (!actor?.id) throw new Error('repair audit actor가 될 활성 대표가 없습니다.');
    for (const row of locked) {
      await manager.query(`UPDATE users
        SET status='rejected', auth_version=auth_version+1, deleted_at=now(), deleted_by=$1, updated_at=now()
        WHERE id=$2 AND deleted_at IS NULL AND email_verified=false AND status='pending'`, [actor.id, row.id]);
      await manager.query(`INSERT INTO audit_log (entity, entity_id, action, actor_id, changes, reason)
        VALUES ('users', $1, 'delete', $2, $3::jsonb, $4)`, [
        row.id,
        actor.id,
        JSON.stringify({ status: { before: 'pending', after: 'rejected' }, deletedAt: { before: null, after: '[set]' } }),
        'TBO-36 legacy unverified pending account soft-delete repair',
      ]);
    }
  });
  console.log(JSON.stringify({ ok: true, repaired: before, remaining: await candidates() }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
