// [TBO-58 P2 2026-07-24] 캘린더 뷰 프리셋 IDOR — 종전엔 로그인만 하면 **타인의 프리셋도 수정/삭제**
//  가능(소유 개념 자체가 없던 실갭, 검증③). created_by 소유자 컬럼 + 가드 신설:
//  수정/삭제 = 소유자 본인 or 매니저 이상(ADMIN_ROLES). 레거시(created_by NULL)는 매니저 이상만.
//  운영 DB는 versioned migration(20260724_01) owner-paste 후 활성 — e2e는 신설 표라 즉시 검증.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

const preset = (name: string) => ({
  name, view: 'week', instructorIds: [], studentIds: [], roomIds: [], subjects: [], statuses: [], groupOnly: false,
});

describe('[TBO-58] view-presets IDOR (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('401/400 — 비로그인 차단, 스키마 위반(필수 누락·미허용 필드) 400', async () => {
    await http.get('/api/view-presets').expect(401);
    await http.post('/api/view-presets').send(preset('anon')).expect(401);
    await http.post('/api/view-presets').set(auth('park_inst')).send({ name: 'x' }).expect(400); // 필수 배열 누락
    await http.post('/api/view-presets').set(auth('park_inst')).send({ ...preset('x'), evil: 1 }).expect(400); // forbidNonWhitelisted
    await http.post('/api/view-presets').set(auth('park_inst')).send({ ...preset('x'), view: 'year' }).expect(400); // IsIn 위반
  });

  it('IDOR — 타 사용자(강사끼리) 프리셋 수정/삭제 403, 본인은 200', async () => {
    const mine = (await http.post('/api/view-presets').set(auth('park_inst')).send(preset('강사1 전용')).expect(201)).body;
    expect(mine.createdBy).toBe(1); // park_inst uid=1 — 소유자 기록
    // 타 강사(jung_inst) → 403 (수정·삭제 모두)
    await http.patch(`/api/view-presets/${mine.id}`).set(auth('jung_inst')).send(preset('탈취 시도')).expect(403);
    await http.delete(`/api/view-presets/${mine.id}`).set(auth('jung_inst')).expect(403);
    // 본인 → 수정 200
    const renamed = (await http.patch(`/api/view-presets/${mine.id}`).set(auth('park_inst')).send(preset('강사1 개명')).expect(200)).body;
    expect(renamed.name).toBe('강사1 개명');
    // 본인 → 삭제 200, 목록 제외
    await http.delete(`/api/view-presets/${mine.id}`).set(auth('park_inst')).expect(200);
    const list = (await http.get('/api/view-presets').set(auth('park_inst')).expect(200)).body as Array<{ id: number }>;
    expect(list.some((p) => p.id === mine.id)).toBe(false);
  });

  it('매니저 이상은 타인 프리셋도 관리 가능(공용 운영) — 404는 부재 시', async () => {
    const owned = (await http.post('/api/view-presets').set(auth('jung_inst')).send(preset('강사2 프리셋')).expect(201)).body;
    // 매니저: 타인 것 수정/삭제 허용(운영 정리 권한)
    await http.patch(`/api/view-presets/${owned.id}`).set(auth('manager')).send(preset('매니저 정리')).expect(200);
    await http.delete(`/api/view-presets/${owned.id}`).set(auth('manager')).expect(200);
    await http.patch('/api/view-presets/999999').set(auth('manager')).send(preset('없음')).expect(404);
    await http.delete('/api/view-presets/999999').set(auth('manager')).expect(404);
  });
});
