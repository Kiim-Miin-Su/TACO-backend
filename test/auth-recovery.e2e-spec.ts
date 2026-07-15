// [TBO-29C C5] 비로그인 복구 e2e — 아이디 찾기·비밀번호 재설정(열거 방지·토큰 수명·세션 무효).
//  test env는 SMTP 미설정(setup이 SMTP_* 제거) → dev 폴백(devWebId/devResetUrl)으로 흐름을 검증한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { USERS, type StaffAccount } from '../src/modules/users/user.entity';

describe('[TBO-29C C5] credential recovery (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const adminEmail = () => db.findBy<StaffAccount>(USERS, (a) => a.webId === 'admin')[0]?.email ?? '';

  it('아이디 찾기 — 미가입 이메일도 동일 응답(열거 방지), 가입 이메일은 dev 폴백으로 webId 확인', async () => {
    const unknown = await http.post('/api/auth/recover-id').send({ email: 'nobody@nowhere.test' }).expect(201);
    expect(unknown.body.ok).toBe(true);
    expect(unknown.body.devWebId).toBeUndefined();

    const known = await http.post('/api/auth/recover-id').send({ email: adminEmail() }).expect(201);
    expect(known.body.ok).toBe(true);
    expect(known.body.message).toBe(unknown.body.message); // 응답 메시지 동일
    expect(known.body.devWebId).toBe('admin'); // dev 폴백(무SMTP·비production)만 노출

    const events = db.findAll<{ eventType: string }>('auth_events').filter((e) => e.eventType === 'recover_id_requested');
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('비밀번호 재설정 — 아이디+이메일 불일치는 토큰 미발급(동일 응답), 일치는 링크 발급 → 재설정 → 구세션 무효 → 재사용 400', async () => {
    // 기존 세션 확보(재설정 후 무효화 검증용)
    const oldToken = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(200);

    // 불일치(이메일 다름) — 동일 응답 + 토큰 미발급
    const miss = await http.post('/api/auth/recover-password').send({ webId: 'admin', email: 'wrong@nowhere.test' }).expect(201);
    expect(miss.body.ok).toBe(true);
    expect(miss.body.devResetUrl).toBeUndefined();

    // 일치 — dev 폴백으로 재설정 URL 확보
    const hit = await http.post('/api/auth/recover-password').send({ webId: 'admin', email: adminEmail() }).expect(201);
    expect(hit.body.message).toBe(miss.body.message);
    const url = String(hit.body.devResetUrl);
    const token = new URL(url).searchParams.get('token')!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    // 평문 토큰은 저장되지 않는다(sha256만)
    const row = db.findBy<StaffAccount>(USERS, (a) => a.webId === 'admin')[0];
    expect(row.passwordResetTokenHash).toBeDefined();
    expect(row.passwordResetTokenHash).not.toBe(token);

    // 약한 비밀번호 400
    await http.post('/api/auth/reset-password').send({ token, newPassword: 'short' }).expect(400);

    // 재설정 성공
    await http.post('/api/auth/reset-password').send({ token, newPassword: 'reset-pass-9999' }).expect(201);

    // 새 비밀번호 로그인 OK · 옛 비밀번호 401 · 구 JWT 무효(auth_version+1)
    const fresh = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'reset-pass-9999' }).expect(201)).body.accessToken;
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(401);
    await http.get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(401);
    await http.get('/api/auth/me').set('Authorization', `Bearer ${fresh}`).expect(200);

    // 토큰 재사용 400(명시 NULL 소거)
    await http.post('/api/auth/reset-password').send({ token, newPassword: 'reset-pass-0000' }).expect(400);

    // 원복(다른 스위트 오염 방지 — admin/demo1234 시드 계약 유지)
    const back = (await http.post('/api/auth/recover-password').send({ webId: 'admin', email: adminEmail() }).expect(201)).body;
    const backToken = new URL(String(back.devResetUrl)).searchParams.get('token')!;
    await http.post('/api/auth/reset-password').send({ token: backToken, newPassword: 'demo1234' }).expect(201);
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
  });

  it('만료 토큰 400 — 무효/만료/재사용 동일 메시지(토큰 상태 열거 방지)', async () => {
    const hit = await http.post('/api/auth/recover-password').send({ webId: 'park_inst', email: db.findBy<StaffAccount>(USERS, (a) => a.webId === 'park_inst')[0]?.email ?? '' }).expect(201);
    const token = new URL(String(hit.body.devResetUrl)).searchParams.get('token')!;
    const inst = db.findBy<StaffAccount>(USERS, (a) => a.webId === 'park_inst')[0];
    // write-through로 만료 조작 — InMemoryDatabase 직접 주입은 PG 권위 경로에 비가시(C0 발견 ③ 규칙).
    const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
    const { USERS_SPEC } = await import('../src/database/calendar-asset-specs');
    await app.get(PostgresCollectionStore).update<StaffAccount>(USERS_SPEC, inst.id, { passwordResetExpiresAt: new Date(Date.now() - 1000).toISOString() } as never);
    const expired = await http.post('/api/auth/reset-password').send({ token, newPassword: 'whatever-999' }).expect(400);
    const invalid = await http.post('/api/auth/reset-password').send({ token: 'f'.repeat(48), newPassword: 'whatever-999' }).expect(400);
    expect(expired.body.message).toBe(invalid.body.message);
  });
});
