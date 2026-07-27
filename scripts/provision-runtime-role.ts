// [TBO-34 C2-C 2026-07-23] 최소 DML runtime role 프로비저닝 — migration(owner)과 runtime(DML 전용)
//  역할 분리. owner URL(DATABASE_URL)로 실행하며, 생성되는 role은 CREATE/ALTER/DROP이 불가능하고
//  public 스키마의 DML(SELECT/INSERT/UPDATE/DELETE)과 시퀀스 사용만 가진다. 멱등 실행.
//  사용: RUNTIME_ROLE_NAME(기본 taco_runtime) RUNTIME_ROLE_PASSWORD(필수) DATABASE_URL=<owner url>
//    npx ts-node scripts/provision-runtime-role.ts [--apply]
//  비밀번호·URL은 로그에 남기지 않는다(상시 보안 규약). Neon 적용 절차는 RUNBOOK 문서 참조.
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { loadLocalEnv } from '../src/config/load-env';
import {
  buildRuntimeRoleUrl,
  directDatabaseUrl,
  runtimeRoleConnectionBaseUrl,
} from '../src/database/database-url';

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
loadLocalEnv();

async function main(): Promise<void> {
  const url = directDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL(owner)이 필요합니다.');
  const runtimeConnectionBase = runtimeRoleConnectionBaseUrl();
  if (!runtimeConnectionBase) throw new Error('runtime connection base URL이 필요합니다.');
  const role = process.env.RUNTIME_ROLE_NAME?.trim() || 'taco_runtime';
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('RUNTIME_ROLE_NAME은 소문자·숫자·언더스코어만 허용됩니다.');
  const outputFile = process.env.RUNTIME_ROLE_OUTPUT_FILE?.trim();
  const password = process.env.RUNTIME_ROLE_PASSWORD || (APPLY && outputFile ? randomBytes(32).toString('hex') : undefined);
  if (APPLY && !password) {
    throw new Error('RUNTIME_ROLE_PASSWORD 또는 RUNTIME_ROLE_OUTPUT_FILE이 필요합니다(로그에 남기지 않음).');
  }

  const client = new Client({ connectionString: url, ssl: resolvePgSsl() });
  await client.connect();
  try {
    const { rows: [who] } = await client.query('select current_user, current_database() as db');
    console.log(`[provision] 실행 주체=${who.current_user} db=${who.db} role=${role} mode=${APPLY ? 'APPLY' : 'dry-run'}`);

    const statements = [
      // 1) role 생성(존재 시 비밀번호만 갱신) — LOGIN, 상속 최소화
      { sql: `create role ${role} login password $pw$`, note: 'role 생성(LOGIN, DML 전용)' },
      // 2) 스키마 사용권(생성권 아님 — PG15+는 public CREATE 기본 회수됨, 명시 revoke로 이중 방어)
      { sql: `grant usage on schema public to ${role}`, note: 'schema USAGE' },
      { sql: `revoke create on schema public from ${role}`, note: 'schema CREATE 회수(이중 방어)' },
      // 3) 현재·미래 테이블 DML + 시퀀스
      { sql: `grant select, insert, update, delete on all tables in schema public to ${role}`, note: '기존 표 DML' },
      { sql: `grant usage, select on all sequences in schema public to ${role}`, note: '기존 시퀀스' },
      { sql: `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`, note: '미래 표 DML(마이그레이션 생성분)' },
      { sql: `alter default privileges in schema public grant usage, select on sequences to ${role}`, note: '미래 시퀀스' },
    ];

    for (const { sql, note } of statements) {
      const rendered = sql.replace('$pw$', password ? `'${password.replace(/'/g, "''")}'` : "'dry-run'");
      if (!APPLY) { console.log(`[dry-run] ${note}`); continue; }
      try {
        await client.query(rendered);
        console.log(`[apply] ${note} — ok`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '42710') { // duplicate role — 비밀번호 갱신으로 수렴(멱등)
          await client.query(`alter role ${role} login password '${(password ?? '').replace(/'/g, "''")}'`);
          console.log(`[apply] ${note} — 기존 role 비밀번호 갱신(멱등)`);
        } else throw e;
      }
    }

    // 검증 readback — role 권한 스냅샷(비밀번호·URL 미출력)
    const { rows: [roleState] } = await client.query(
      'select exists(select 1 from pg_roles where rolname=$1) as exists',
      [role],
    );
    if (!APPLY) {
      console.log(`[readback] ${role}: exists=${roleState.exists} (dry-run은 권한을 변경하지 않음)`);
    } else {
      const { rows: [check] } = await client.query(
        `select has_schema_privilege($1, 'public', 'CREATE') as can_create,
                has_schema_privilege($1, 'public', 'USAGE') as can_use`, [role]);
      console.log(`[readback] ${role}: schema USAGE=${check.can_use} CREATE=${check.can_create} (CREATE는 false여야 함)`);
      if (check.can_create) throw new Error(`[provision] ${role}이 여전히 CREATE 권한을 가짐 — 수동 확인 필요`);
    }

    if (APPLY && password) {
      const runtimeUrl = buildRuntimeRoleUrl(url, runtimeConnectionBase, role, password);
      const runtime = new Client({ connectionString: runtimeUrl, ssl: resolvePgSsl() });
      await runtime.connect();
      try {
        const { rows: [runtimeCheck] } = await runtime.query(`
          SELECT current_user,
                 has_schema_privilege(current_user, 'public', 'USAGE') AS can_use,
                 has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
                 COALESCE(bool_and(
                   has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE')
                 ), true) AS all_table_dml
          FROM pg_tables
          WHERE schemaname = 'public'
          GROUP BY current_user
        `);
        if (runtimeCheck?.current_user !== role || !runtimeCheck.can_use || runtimeCheck.can_create || !runtimeCheck.all_table_dml) {
          throw new Error('[provision] runtime role 권한 readback 불일치');
        }
        console.log(`[readback] ${role}: login=true schema USAGE=true CREATE=false all-table-DML=true`);
      } finally {
        await runtime.end();
      }

      if (outputFile) {
        writeFileSync(outputFile, `${runtimeUrl}\n`, { encoding: 'utf8', mode: 0o600 });
        chmodSync(outputFile, 0o600);
        console.log('[provision] runtime URL을 권한 0600 임시 파일에 기록했습니다(경로·값 비출력).');
      }
    }
    console.log(APPLY
      ? '[provision] 완료 — 런타임 DATABASE_URL을 이 role 자격으로 교체하세요(절차: RUNBOOK-BACKUP-MONITORING).'
      : '[provision] dry-run 완료 — 적용은 --apply.');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('[provision] 실패:', (e as Error).message); process.exit(1); });
