// [TBO-34 C2-C 2026-07-23] runtime role 거부 스모크 — 로컬 fresh PG에서 최소 DML role을 실제로
//  프로비저닝하고 다음을 실증한다(수용 기준 "runtime role CREATE/ALTER/DROP denial test"):
//   ① DML(INSERT/SELECT/UPDATE/DELETE) 성공  ② CREATE TABLE 거부  ③ ALTER TABLE 거부
//   ④ DROP TABLE 거부  ⑤ INDEX 생성 거부.
//  provision-runtime-role.ts와 같은 grant 경로를 소비해(스크립트 재사용) 스모크와 운영 절차가
//  동일한 단일 진실원을 갖는다. 사용: DATABASE_URL=<owner url> npx ts-node scripts/runtime-role-db-smoke.ts
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { resolvePgSsl } from '../src/database/pg-ssl';

const ROLE = 'taco_runtime_smoke';
const PASSWORD = `smoke-${Math.random().toString(36).slice(2, 10)}`; // 스크래치 전용 — 출력 금지

async function expectDenied(client: Client, label: string, sql: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42501' || code === '0LP01') { console.log(`  ✓ ${label} 거부(권한 부족)`); return; }
    throw new Error(`${label}: 예상(42501)과 다른 오류 ${code}`);
  }
  throw new Error(`${label}: 거부돼야 하는데 성공함 — role 과권한`);
}

async function main(): Promise<void> {
  const ownerUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!ownerUrl) throw new Error('DATABASE_URL(owner)이 필요합니다.');

  const owner = new Client({ connectionString: ownerUrl, ssl: resolvePgSsl() });
  await owner.connect();
  await owner.query('create table if not exists runtime_role_smoke (id serial primary key, note text)');
  await owner.query(`drop role if exists ${ROLE}`);
  await owner.end();

  // 같은 grant 경로 재사용 — provision 스크립트를 APPLY로 실행(스모크 전용 role)
  execFileSync('npx', ['ts-node', 'scripts/provision-runtime-role.ts', '--apply'], {
    env: { ...process.env, RUNTIME_ROLE_NAME: ROLE, RUNTIME_ROLE_PASSWORD: PASSWORD },
    stdio: 'inherit',
  });

  const url = new URL(ownerUrl);
  url.username = ROLE;
  url.password = PASSWORD;
  const runtime = new Client({ connectionString: url.toString(), ssl: resolvePgSsl() });
  await runtime.connect();
  try {
    console.log('[smoke] runtime role 연결 — DML 양성/DDL 음성 검증');
    await runtime.query(`insert into runtime_role_smoke (note) values ('dml-ok')`);
    const { rows } = await runtime.query('select count(*)::int as n from runtime_role_smoke');
    if (rows[0].n < 1) throw new Error('SELECT readback 실패');
    await runtime.query(`update runtime_role_smoke set note = 'updated' where note = 'dml-ok'`);
    await runtime.query(`delete from runtime_role_smoke where note = 'updated'`);
    console.log('  ✓ DML(INSERT/SELECT/UPDATE/DELETE) 성공');
    await expectDenied(runtime, 'CREATE TABLE', 'create table smoke_denied (id int)');
    await expectDenied(runtime, 'ALTER TABLE', 'alter table runtime_role_smoke add column hacked int');
    await expectDenied(runtime, 'DROP TABLE', 'drop table runtime_role_smoke');
    await expectDenied(runtime, 'CREATE INDEX', 'create index smoke_idx on runtime_role_smoke (note)');
  } finally {
    await runtime.end();
  }

  // 정리(owner) — 스크래치 role·표 제거
  const cleaner = new Client({ connectionString: ownerUrl, ssl: resolvePgSsl() });
  await cleaner.connect();
  await cleaner.query('drop table if exists runtime_role_smoke');
  await cleaner.query(`drop owned by ${ROLE}`);
  await cleaner.query(`drop role if exists ${ROLE}`);
  await cleaner.end();
  console.log('[smoke] runtime-role denial 스모크 통과 — DML 전용 경계 실증 완료');
}

main().catch((e) => { console.error('[smoke] 실패:', (e as Error).message); process.exit(1); });
