// [TBO-58 P2 2026-07-24] 리포트 템플릿 실패 경로 홈 스위트 — 종전엔 성공 흐름만 분산 커버(검증③).
//  설계 메모: 템플릿은 "강사 공용 자산"(전 직원 CRUD 허용이 의도) — 체크리스트의 '비관리자 403'은
//  N/A 판정. 여기서는 401(비로그인)·404(부재 삭제)·400(스키마)·생성→삭제 사이클을 응집 검증.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('[TBO-58] report-templates 실패 경로 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('401 — 비로그인은 목록/생성/삭제 전부 차단', async () => {
    await http.get('/api/report-templates').expect(401);
    await http.post('/api/report-templates').send({ name: 'x', content: 'y' }).expect(401);
    await http.delete('/api/report-templates/1').expect(401);
  });

  it('400 — 스키마 위반(필수 누락·길이 초과·미허용 필드)', async () => {
    await http.post('/api/report-templates').set(auth('park_inst')).send({ name: '이름만' }).expect(400); // content 누락
    await http.post('/api/report-templates').set(auth('park_inst')).send({ name: 'a'.repeat(41), content: 'c' }).expect(400); // 40자 초과
    await http.post('/api/report-templates').set(auth('park_inst')).send({ name: 'n', content: 'c', evil: 1 }).expect(400); // forbidNonWhitelisted
  });

  it('404 — 없는 템플릿 삭제', async () => {
    await http.delete('/api/report-templates/999999').set(auth('manager')).expect(404);
  });

  it('생성 → 목록 → 삭제(soft) 사이클 — 강사가 만들고 지울 수 있다(공용 자산 규약)', async () => {
    const row = (await http.post('/api/report-templates').set(auth('park_inst'))
      .send({ name: 'QA 정규수업 기본', content: '오늘 수업 요약…', homework: '단어 30개' }).expect(201)).body;
    const listed = (await http.get('/api/report-templates').set(auth('manager')).expect(200)).body as Array<{ id: number }>;
    expect(listed.some((t) => t.id === row.id)).toBe(true); // 공용 — 다른 직원에게도 보인다
    await http.delete(`/api/report-templates/${row.id}`).set(auth('park_inst')).expect(200);
    const after = (await http.get('/api/report-templates').set(auth('park_inst')).expect(200)).body as Array<{ id: number }>;
    expect(after.some((t) => t.id === row.id)).toBe(false); // soft delete — 목록 제외
    await http.delete(`/api/report-templates/${row.id}`).set(auth('manager')).expect(404); // 재삭제 404
  });
});
