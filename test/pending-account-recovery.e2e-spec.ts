// [핫픽스 2026-07-20 대표 실사용 보고] 레거시 미인증 pending 계정 구제·정리 e2e. 검증:
//  ① 미인증 승인 403(기존 게이트) — 그러나 **반려는 서버가 막지 않는다**(대표 보고 "반려도 안 된다"는
//    FE 일반화 메시지/구버전 배포의 증상 — 서버 회귀 방지로 고정)
//  ② 인증 메일 재발송(새 48h 토큰) → verify-email → 승인 성공 (강민지 케이스의 정상 경로)
//  ③ 가입 신청 삭제 — 식별자 tombstone 해제 + RRN 파기 + soft delete + audit → 같은
//    아이디/이메일 재가입 가능(하드 UNIQUE로 반려만으론 영구 차단되던 문제)
//  ④ 가드: 재발송은 미인증 pending만 · 삭제는 pending/rejected만 · 강사 403
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { USERS_SPEC } from '../src/database/calendar-asset-specs';
import { verifiedSignupChallenge } from './signup-helper';

type UserRow = {
  id: number; webId: string; email?: string | null; status: string; emailVerified?: boolean;
  rrnEncrypted?: string | null; deletedAt?: string | null;
};

describe('Legacy pending account recovery + delete (e2e, hotfix 2026-07-20)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let store: PostgresCollectionStore;
  let admin = '';
  let inst = '';
  const auth = (t: string) => sudoAuthHeaders(app, t);

  // 레거시(구 링크 가입) 시뮬레이션 — TBO-31 이후 생성 경로는 전부 verified라 직접 삽입으로 재현.
  const insertLegacyPending = async (webId: string, email: string) =>
    store.insert<UserRow & { name: string; role: string; passwordHash: string }>(USERS_SPEC, {
      webId, name: '레거시대기', email, role: 'instructor', status: 'pending',
      passwordHash: '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpDgYaN3BB/L8/1PqFOSGzX8vC/P2', // bcrypt 임의값
      emailVerified: false, rrnEncrypted: 'legacy-enc-blob',
    } as never);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    store = app.get(PostgresCollectionStore);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('① 미인증 pending: 승인 403 — 반려는 정상 동작(서버는 막지 않는다)', async () => {
    const acc = await insertLegacyPending('legacy_kang', 'kang@legacy.test');
    await http.post(`/api/auth/approve/${acc.id}`).set(auth(admin)).send({}).expect(403); // 인증 게이트
    // 반려 성공 — 이메일 인증과 무관(대표 보고 회귀 방지 고정)
    const rejected = (await http.post(`/api/auth/reject/${acc.id}`).set(auth(admin))
      .send({ reason: '연락 두절 — 정리' }).expect(201)).body;
    expect(rejected.status).toBe('rejected');
  });

  it('② 재발송 → verify-email → 승인 성공 (구제 정상 경로)', async () => {
    const acc = await insertLegacyPending('legacy_verify', 'verify@legacy.test');
    const sent = (await http.post(`/api/auth/pending/${acc.id}/resend-verification`).set(auth(admin))
      .send({}).expect(201)).body;
    expect(sent.ok).toBe(true);
    expect(String(sent.devVerifyLink)).toContain('/verify-email?token='); // 비prod devLink 관례
    const token = String(sent.devVerifyLink).split('token=')[1];
    await http.get(`/api/auth/verify-email?token=${token}`).expect(200);
    expect(db.findById<UserRow>('users', acc.id)!.emailVerified).toBe(true);
    const approved = (await http.post(`/api/auth/approve/${acc.id}`).set(auth(admin)).send({}).expect(201)).body;
    expect(approved.status).toBe('active');
    // 승인 후(active) 재발송 → 404(승인 대기 계정 아님)
    await http.post(`/api/auth/pending/${acc.id}/resend-verification`).set(auth(admin)).send({}).expect(404);
  });

  it('③ 삭제: 식별자 해제·RRN 파기·soft delete → 같은 아이디/이메일로 재가입 가능', async () => {
    const acc = await insertLegacyPending('legacy_del', 'del@legacy.test');
    await http.delete(`/api/auth/pending/${acc.id}`).set(auth(admin))
      .send({ reason: '오가입 정리 — 재가입 예정' }).expect(200);
    const row = db.findById<UserRow>('users', acc.id, { withDeleted: true } as never)
      ?? db.findAll<UserRow>('users', { withDeleted: true } as never).find((u) => u.id === acc.id);
    expect(row).toBeDefined();
    expect(row!.webId).toMatch(/^del_/); // tombstone — 원 아이디 해제
    expect(row!.email ?? null).toBeNull(); // 이메일 해제
    expect(row!.rrnEncrypted ?? null).toBeNull(); // 개인정보 파기
    expect(row!.deletedAt).toBeTruthy();
    // 같은 아이디·이메일 재가입 — OTP 정상 흐름으로 성공(UNIQUE 충돌 없음)
    const challengeId = await verifiedSignupChallenge(http, 'del@legacy.test');
    await http.post('/api/auth/signup').send({
      webId: 'legacy_del', name: '재가입', email: 'del@legacy.test', password: 'password123',
      rrn: '950101-1234567', emailChallengeId: challengeId, role: 'instructor',
    }).expect(201);
  });

  it('④ 가드: active 계정 삭제 400 · 재발송 non-pending 404 · 강사 403', async () => {
    await http.delete('/api/auth/pending/1').set(auth(admin)).send({ reason: '활성 삭제 시도' }).expect(400); // park=active
    await http.post('/api/auth/pending/999/resend-verification').set(auth(admin)).send({}).expect(404);
    const acc = await insertLegacyPending('legacy_guard', 'guard@legacy.test');
    await http.post(`/api/auth/pending/${acc.id}/resend-verification`).set(auth(inst)).send({}).expect(403);
    await http.delete(`/api/auth/pending/${acc.id}`).set(auth(inst)).send({ reason: '강사 시도' }).expect(403);
  });
});
