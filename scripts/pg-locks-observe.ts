// [B9 E5 2026-07-16] pg_locks 관찰자 — 동시성 e2e가 도는 동안 옆에서 폴링해 ① 미승인 잠금
//  (granted=false)의 최대 동시 수 ② 교착(deadlock) 카운터 증가를 기록한다(29E E5 "교착 0 확인").
//  읽기 전용. 사용: DATABASE_URL=... npx ts-node scripts/pg-locks-observe.ts <초, 기본 60>
//  종료 시 JSON 요약 출력 — deadlocksDelta>0 이면 exitCode 1.
import { Client } from 'pg';
import { assertPgUrlPolicy, resolvePgSsl } from '../src/database/pg-ssl';

async function main() {
  const durationSec = Number(process.argv[2] ?? 60);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 필요');
  assertPgUrlPolicy(url);
  const client = new Client({ connectionString: url, ssl: resolvePgSsl() });
  try {
    await client.connect();
    const dbName = (await client.query('SELECT current_database() AS db')).rows[0].db as string;
    const deadlocksOf = async () =>
      Number((await client.query('SELECT deadlocks FROM pg_stat_database WHERE datname=$1', [dbName])).rows[0]?.deadlocks ?? 0);
    const before = await deadlocksOf();
    let maxWaiting = 0;
    let samples = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < durationSec * 1000) {
      const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted');
      maxWaiting = Math.max(maxWaiting, Number(rows[0].n));
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const after = await deadlocksOf();
    const deadlocksDelta = after - before;
    console.log(JSON.stringify({ ok: deadlocksDelta === 0, db: dbName, durationSec, samples, maxWaitingLocks: maxWaiting, deadlocksBefore: before, deadlocksAfter: after, deadlocksDelta }));
    if (deadlocksDelta !== 0) process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
