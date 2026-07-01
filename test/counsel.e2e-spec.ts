import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 상담(counsel) 모듈 e2e — 시드 목록 + rounds↔forms FK 무결성.
describe('Counsel API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  it('GET /counsel — 상담 접수 3건(시드)', async () => {
    const forms = (await http.get('/api/counsel').expect(200)).body;
    expect(forms.length).toBe(3);
    const statuses = forms.map((f: { status: string }) => f.status).sort();
    expect(statuses).toEqual(['pending', 'registered', 'requested']);
  });

  it('상담 탭 배지 기준: status≠dropped ∧ nextContactAt 없음 → 2건(등록·신규)', async () => {
    const forms = (await http.get('/api/counsel').expect(200)).body;
    const badge = forms.filter((f: { status: string; nextContactAt?: string }) => f.status !== 'dropped' && !f.nextContactAt);
    expect(badge.length).toBe(2);
  });

  it('GET /counsel/rounds — 회차 4건, 모두 유효한 counselFormId(FK 무결성)', async () => {
    const forms = (await http.get('/api/counsel').expect(200)).body;
    const formIds = new Set(forms.map((f: { id: number }) => f.id));
    const rounds = (await http.get('/api/counsel/rounds').expect(200)).body;
    expect(rounds.length).toBe(4);
    expect(rounds.every((r: { counselFormId: number }) => formIds.has(r.counselFormId))).toBe(true);
  });

  it('GET /counsel/rounds?counselFormId=1 — 폼1의 회차 2건', async () => {
    const rounds = (await http.get('/api/counsel/rounds?counselFormId=1').expect(200)).body;
    expect(rounds.length).toBe(2);
    expect(rounds.every((r: { counselFormId: number }) => r.counselFormId === 1)).toBe(true);
  });
});
