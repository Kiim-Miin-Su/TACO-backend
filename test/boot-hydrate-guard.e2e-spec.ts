// [TBO-57 핫픽스 2026-07-24] 부팅 hydrate 표-부재 생존 회귀 — 실측 사고 재현 방지.
//  운영(런타임 DDL 금지)에서 migration owner-paste 전에 신설 표 hydrate가 부팅을 죽였다
//  (/api/health 포함 전 라우트 다운). hydrateIfPresent는 표가 없으면 경고 후 [] 반환(부팅 생존),
//  엄격 hydrate는 계속 throw(기능 단위 fail-closed 유지)를 검증한다.
//  실행: RUN_MONEY_RACE_E2E=1 + DATABASE_URL(PG 전용 — DDL 비활성 분기는 PG에서만 의미).
import { INestApplication } from '@nestjs/common';
import { createTestApp } from './setup-app';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import type { PostgresCollectionSpec } from '../src/database/postgres-collection.store';

const enabled = process.env.RUN_MONEY_RACE_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

// 존재하지 않는 표 — createSql은 no-op(DDL 비활성 분기 검증이 목적이라 실행되지도 않아야 함).
const GHOST_SPEC = {
  table: 'ghost_table_boot_guard_xyz',
  createSql: 'SELECT 1',
  indexes: [],
} as unknown as PostgresCollectionSpec;

describeDb('[TBO-57 핫픽스] 부팅 hydrate 표-부재 생존 (PG e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.TEST_BUSINESS_FIXTURES = '0';
    app = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    delete process.env.RUNTIME_SCHEMA_DDL;
    await app.close();
  });

  it('런타임 DDL 비활성 + 표 부재: hydrate=[] 생존(부팅 계약), READ·쓰기는 SQL fail-closed', async () => {
    const store = app.get(PostgresCollectionStore);
    process.env.RUNTIME_SCHEMA_DDL = 'false'; // 운영 정책 재현(명시 비활성 — production 분기와 동일 경로)
    // 부팅·재수화 경로: 죽지 않고 빈 배열(경고 로그) — 콜드스타트 생존 계약(원천 픽스)
    await expect(store.hydrate(GHOST_SPEC)).resolves.toEqual([]);
    // 실제 READ·쓰기: 부재 표는 SQL 오류로 fail-closed — 조용한 메모리 폴백 금지
    await expect(store.findActive(GHOST_SPEC)).rejects.toThrow();
    await expect(store.insert(GHOST_SPEC, { codeHash: 'x' } as never)).rejects.toThrow();
    delete process.env.RUNTIME_SCHEMA_DDL;
    // DDL 허용 환경(비운영)에서는 ensureReady가 표를 만들어 정상 동작(기존 계약 무변)
    const SPEC_OK = { ...GHOST_SPEC, table: 'ghost_table_boot_guard_ok', createSql: `
      CREATE TABLE IF NOT EXISTS ghost_table_boot_guard_ok (
        id serial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by integer
      )` } as unknown as PostgresCollectionSpec;
    await expect(store.hydrate(SPEC_OK)).resolves.toEqual([]);
  });
});
