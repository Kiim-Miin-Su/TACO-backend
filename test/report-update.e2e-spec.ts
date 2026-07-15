// [E0.6 H1] PATCH /reports/:id — 기존 보고서 본문/숙제 수정(임시 저장 경로 신설) e2e.
//  규칙: 본인(또는 관리자)만 · 승인(approved) 후 불변 · 빈 homework는 명시 null(비움).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

describe('Report content update (e2e, E0.6 H1)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    tokens.park = await login('park_inst'); // 시드 보고서 1·3의 명의 강사
    tokens.jung = await login('jung_inst');
    tokens.admin = await login('admin');
  });
  afterAll(async () => { await app.close(); });

  it('owner updates content/homework; empty homework clears to null', async () => {
    const updated = await http.patch('/api/reports/1').set(bearer(tokens.park))
      .send({ content: '수정된 진도 — 요지 파악 정답률 90%.', homework: '워크북 20p' }).expect(200);
    expect(updated.body).toMatchObject({ id: 1, content: '수정된 진도 — 요지 파악 정답률 90%.', homework: '워크북 20p' });
    const cleared = await http.patch('/api/reports/1').set(bearer(tokens.park))
      .send({ homework: '' }).expect(200);
    expect(cleared.body.homework ?? null).toBeNull(); // 빈 문자열 = 명시 null(비움)
    expect(cleared.body.content).toBe('수정된 진도 — 요지 파악 정답률 90%.'); // 부분 수정 — content 유지
  });

  it('rejects non-owner (403), empty patch (400), and edits after approval (400)', async () => {
    await http.patch('/api/reports/1').set(bearer(tokens.jung))
      .send({ content: '타인 명의 수정 시도' }).expect(403);
    await http.patch('/api/reports/1').set(bearer(tokens.park)).send({}).expect(400);
    await http.patch('/api/reports/999').set(bearer(tokens.park)).send({ content: 'x' }).expect(404);
    // 승인 후 불변(시수 반영) — 관리자 승인 → 본인 수정도 400
    await http.post('/api/reports/1/approve').set(bearer(tokens.admin)).expect(201);
    await http.patch('/api/reports/1').set(bearer(tokens.park))
      .send({ content: '승인 후 수정 시도' }).expect(400);
    expect(db.findById<{ content: string }>('session_reports', 1)?.content).toBe('수정된 진도 — 요지 파악 정답률 90%.');
  });
});
