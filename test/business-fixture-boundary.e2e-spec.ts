import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

describe('production data source boundary', () => {
  let app: INestApplication;
  const previousFixtureMode = process.env.TEST_BUSINESS_FIXTURES;

  beforeAll(async () => {
    process.env.TEST_BUSINESS_FIXTURES = '0';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (previousFixtureMode === undefined) delete process.env.TEST_BUSINESS_FIXTURES;
    else process.env.TEST_BUSINESS_FIXTURES = previousFixtureMode;
  });

  it('keeps a fresh database empty when E2E business fixtures are disabled', () => {
    const db = app.get(InMemoryDatabase);
    for (const table of ['users', 'students', 'courses', 'class_sessions', 'availability_blocks']) {
      expect(db.findAll(table)).toHaveLength(0);
    }
    expect(db.findAll('countries').length).toBeGreaterThan(0); // production reference catalog is not mock data
  });

  // [TBO-61 2026-07-24] 대표 실측 이슈: "운영에서 스케줄을 하나도 안 넣었는데 캘린더에 수업이 보인다".
  //  코드 경로 판정 — 앱은 mock 업무 데이터를 스스로 만들지 않으므로(위 테스트), 빈 저장소에서는
  //  데모 계정 로그인조차 불가하다(mock 계정 시드 0 실증) + 부팅·health는 정상. 운영 캘린더에 보인
  //  수업 = DB에 실재하는 과거 데모 시드 행이며 scripts/mock-data.ts(check/delete --suspected)로
  //  소프트 딜리트하면 사라진다(모든 읽기 경로는 deleted_at IS NULL만 본다 — class-sessions.store).
  it('[TBO-61] empty store → no demo accounts, app alive (calendar has nothing to serve)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' });
    expect(login.status).toBe(401);
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});
