// [TBO-79 E5 2026-07-30] 계정·세션 응답의 계약 ↔ 실제 wire 일치 회귀.
//
//  결함: `toSafe()`가 StaffAccount에서 비밀 6개만 빼고 전부 spread하는데 계약
//  `StaffAccountSummary`는 그 진부분집합이었다. authVersion·mustChangePassword·approvedBy·
//  approvedAt·lastLoginAt·university·major·birthYear 8개가 계약 밖으로 흘러나갔고,
//  타입 가드는 `const contract: StaffAccountSummary = safe;` 한 줄이라 **초과집합만** 증명했다.
//  frontend는 그래서 detail 호출부에서 필드를 손으로 덧붙이고 있었다.
//
//  이제 user.entity.ts의 양방향 단언이 컴파일 타임에 초과·누락을 둘 다 막는다. 이 스위트는
//  런타임 wire가 실제로 그 모양인지(= 단언이 현실을 반영하는지) 확인한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders, mondayISO, addDaysISO } from './setup-app';

jest.setTimeout(20000);

/** SafeAccount(= StaffAccountSummary)가 가질 수 있는 키의 전체 집합. */
const ACCOUNT_SUMMARY_KEYS = new Set([
  'id', 'webId', 'name', 'email', 'phone', 'role', 'status', 'countryCode', 'timeZone',
  'profileVersion', 'emailVerified', 'authVersion', 'mustChangePassword',
  'approvedBy', 'approvedAt', 'lastLoginAt', 'university', 'major', 'birthYear',
  'createdAt', 'updatedAt', 'deletedAt', 'deletedBy',
]);

const STAFF_PROFILE_KEYS = new Set([
  'id', 'webId', 'name', 'email', 'phone', 'role', 'status', 'countryCode', 'timeZone',
  'profileVersion', 'emailVerified', 'smsVerificationAvailable',
]);

describe('[TBO-79] 계정·세션 wire ↔ 계약 일치 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('E5 — GET /users 응답 키가 StaffAccountSummary를 벗어나지 않는다', async () => {
    const rows = (await http.get('/api/users').set(bearer('admin')).expect(200)).body as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const unexpected = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!ACCOUNT_SUMMARY_KEYS.has(key)) unexpected.add(key);
    }
    expect([...unexpected]).toEqual([]);
    // 비밀은 어떤 응답에도 없다.
    for (const secret of ['passwordHash', 'rrnEncrypted', 'emailVerifyTokenHash', 'passwordResetTokenHash']) {
      expect(JSON.stringify(rows)).not.toContain(secret);
    }
  });

  it('E5 — GET /users/:id 는 요약 + rrnMasked(StaffAccountDetail)다', async () => {
    const detail = (await http.get('/api/users/1').set(as('admin')).expect(200)).body as Record<string, unknown>;
    const unexpected = Object.keys(detail).filter((key) => key !== 'rrnMasked' && !ACCOUNT_SUMMARY_KEYS.has(key));
    expect(unexpected).toEqual([]);
    // 종전에 계약 밖이라 FE가 손으로 덧붙이던 필드들 — 이제 계약이 안다.
    expect(detail).toHaveProperty('rrnMasked');
    expect(Object.keys(detail)).toEqual(expect.arrayContaining(['authVersion', 'profileVersion', 'createdAt', 'updatedAt']));
  });

  it('E5 — GET /users/me/profile 응답 키가 StaffProfile과 정확히 일치한다', async () => {
    const profile = (await http.get('/api/users/me/profile').set(bearer('admin')).expect(200)).body as Record<string, unknown>;
    const unexpected = Object.keys(profile).filter((key) => !STAFF_PROFILE_KEYS.has(key));
    expect(unexpected).toEqual([]);
    // 계약이 optional에서 required로 정정된 두 필드 — 서버가 항상 채운다.
    expect(typeof profile.emailVerified).toBe('boolean');
    expect(typeof profile.smsVerificationAvailable).toBe('boolean');
    expect(typeof profile.role).toBe('string');
    expect(typeof profile.status).toBe('string');
  });

  it('E5 — POST /auth/login 은 계약이 선언한 필드만 돌려준다(accessToken 포함)', async () => {
    const body = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'account']);
    expect(Object.keys(body.account as object).sort()).toEqual(['id', 'mustChangePassword', 'name', 'role']);
  });

  it('E5 — PUT /schedule/:id/pay-amount 는 형제 라우트와 같은 enrich된 행을 돌려준다', async () => {
    const PAST = addDaysISO(mondayISO(), -49);
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: PAST, startTime: '08:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    await http.patch(`/api/schedule/${created.id}`).set(as('admin'))
      .send({ instructorAttendance: 'present', force: true }).expect(200);

    const paid = (await http.put(`/api/schedule/${created.id}/pay-amount`).set(as('admin'))
      .send({ amount: 55000 }).expect(200)).body as { row: Record<string, unknown> };
    // 종전엔 저장 행을 그대로 반환해 조인 필드가 전부 undefined였다 — FE 타입은 있다고 주장했다.
    expect(paid.row).toHaveProperty('courseName');
    expect(paid.row).toHaveProperty('instructorName');
    expect(paid.row).toHaveProperty('missingAttendance');
    expect(paid.row.instructorPayAmount).toBe(55000);
  });

  it('E5 — PATCH /schedule/:id 변경 응답에 회계 영향이 함께 온다', async () => {
    const PAST = addDaysISO(mondayISO(), -49);
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: PAST, startTime: '15:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    await http.patch(`/api/schedule/${created.id}`).set(as('admin'))
      .send({ instructorAttendance: 'present', force: true }).expect(200);

    const blocked = await http.patch(`/api/schedule/${created.id}`).set(as('manager'))
      .send({ durationMinutes: 90, force: true }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    const ok = (await http.patch(`/api/schedule/${created.id}`).set(as('manager')).send({
      durationMinutes: 90,
      force: true,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200)).body as Record<string, unknown>;
    expect(Object.keys(ok)).toEqual(expect.arrayContaining(['row', 'conflicts', 'updated', 'accountingImpact', 'accountingImpactHash']));
    expect(ok.accountingImpactHash).toBe(blocked.body.impactHash);
  });
});
