// [TBO-76 76D] PATCH /reports/:id — 작성값(content/progressPage/homework) 수정.
//  규칙: 조인 헤더와 분리 · 본인(또는 관리자)만 · 승인 후 불변 · 빈 선택값은 명시 null.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

describe('Report content update (e2e, E0.6 H1)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};
  let draftId = 0;

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

  it('owner updates authored fields; empty progress/homework clears to null', async () => {
    const updated = await http.patch('/api/reports/1').set(bearer(tokens.park))
      .send({
        content: '수정된 수업 내용 — 요지 파악 정답률 90%.',
        progressPage: 'Vocab #6 PDF 12-15p',
        homework: '워크북 20p',
      }).expect(200);
    expect(updated.body).toMatchObject({
      id: 1,
      content: '수정된 수업 내용 — 요지 파악 정답률 90%.',
      progressPage: 'Vocab #6 PDF 12-15p',
      homework: '워크북 20p',
    });
    const cleared = await http.patch('/api/reports/1').set(bearer(tokens.park))
      .send({ progressPage: '', homework: '' }).expect(200);
    expect(cleared.body.progressPage ?? null).toBeNull();
    expect(cleared.body.homework ?? null).toBeNull(); // 빈 문자열 = 명시 null(비움)
    expect(cleared.body.content).toBe('수정된 수업 내용 — 요지 파악 정답률 90%.'); // 부분 수정 — content 유지
  });

  it('create persists progressPage and joined detail reads the same session/student/course authority', async () => {
    const session = (await http.post('/api/schedule').set(bearer(tokens.admin)).send({
      courseId: 10,
      sessionDate: '2097-07-29',
      startTime: '03:00',
      durationMinutes: 60,
      studentIds: [1],
      force: true,
    }).expect(201)).body.row;
    const created = (await http.post('/api/reports').set(bearer(tokens.park)).send({
      sessionId: session.id,
      studentId: 1,
      content: 'Vocab #6 문장 만들기와 전치사 교정',
      progressPage: 'Vocab #6 PDF 문장 만들기',
      homework: 'Vocab #6 문장 완성과 단어 암기',
      status: 'draft',
    }).expect(201)).body;
    draftId = created.id;
    expect(created.progressPage).toBe('Vocab #6 PDF 문장 만들기');

    const detail = (await http.get(`/api/reports/${created.id}`).set(bearer(tokens.park)).expect(200)).body;
    expect(detail).toMatchObject({
      progressPage: 'Vocab #6 PDF 문장 만들기',
      context: {
        student: { id: 1, name: expect.any(String) },
        session: { id: session.id, sessionDate: '2097-07-29' },
        course: { id: 10, name: expect.any(String) },
        instructor: { id: session.instructorId, name: expect.any(String) },
      },
    });
  });

  it('soft-deletes only an owner/admin draft and writes metadata-only audit', async () => {
    await http.delete(`/api/reports/${draftId}`).set(bearer(tokens.jung)).expect(403);
    await http.delete('/api/reports/1').set(bearer(tokens.park)).expect(400);
    expect((await http.delete(`/api/reports/${draftId}`)
      .set(bearer(tokens.park)).expect(200)).body).toEqual({ id: draftId, deleted: true });
    await http.get(`/api/reports/${draftId}`).set(bearer(tokens.park)).expect(404);
    const audits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'session_reports' && row.entityId === draftId && row.action === 'delete');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain('Vocab #6 문장 만들기와 전치사 교정');
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
    expect(db.findById<{ content: string }>('session_reports', 1)?.content).toBe('수정된 수업 내용 — 요지 파악 정답률 90%.');
  });
});
