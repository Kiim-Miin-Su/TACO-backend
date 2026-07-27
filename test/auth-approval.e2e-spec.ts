// [TBO-28B] 승인 원자 tx + 인증 운영 경계 e2e — TBO-28A-BASELINE §2 테스트 표(T1~T12) 구현.
//  in-memory 모드에서 상시 실행(CI). Postgres 모드 증명은 28F(로컬 PG/Neon)에서 동일 스펙 재실행.
//  [TBO-31 C1] 가입은 이메일 OTP 소비 → emailVerified=true 생성으로 전환(signup-helper 재사용).
//  잔존 미인증 계정(구 링크 흐름) 시나리오는 DB 강제 세팅으로 재현한다(T6·T12).
import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { InstructorProfilesStore } from '../src/modules/users/instructor-profiles.store';
import { signupWithOtp } from './signup-helper';

type Row = Record<string, unknown>;

describe('Auth approval command + auth events (e2e, TBO-28B)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  async function login(webId: string, password = 'demo1234'): Promise<string> {
    const res = await http.post('/api/auth/login').send({ webId, password }).expect(201);
    return res.body.accessToken;
  }

  /** [TBO-31 C1] OTP 인증까지 마친 pending 계정 생성(emailVerified=true) → id 반환 */
  async function signupVerified(webId: string, role = 'instructor'): Promise<number> {
    const signup = await signupWithOtp(http, { webId, role });
    return signup.account.id;
  }

  /** 잔존(구 링크 흐름) 미인증 계정 상태 재현 — 양 모드 권위 소스에 기록(§13.83 이중 모드 규약). */
  async function forceLegacyUnverified(id: number, rawToken?: string, expiresAtIso?: string): Promise<void> {
    const hash = rawToken ? createHash('sha256').update(rawToken).digest('hex') : null;
    const expires = rawToken ? expiresAtIso ?? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) {
      await pg.query(
        'UPDATE users SET email_verified = false, email_verify_token_hash = $1, email_verify_expires_at = $2 WHERE id = $3',
        [hash, expires, id],
      );
    }
    db.update('users', id, { emailVerified: false, emailVerifyTokenHash: hash, emailVerifyExpiresAt: expires } as never);
  }

  // [감사 전수 2026-07-16] signup(create)·verifyEmail(update) 이력이 추가됨 — 이 스위트의 단정은
  //  '승인/반려 결정' 이력에 대한 것이므로 결정 액션만 카운트한다.
  const auditOf = (id: number): Row[] =>
    db.findAll<Row & { id: number; action?: string }>('audit_log')
      .filter((r) => r.entity === 'users' && r.entityId === id && (r.action === 'approve' || r.action === 'reject'));
  const profileOf = (id: number): Row | undefined =>
    db.findAll<Row & { id: number }>('instructor_profiles').find((r) => r.userId === id);
  const userOf = (id: number): Row => db.findAll<Row & { id: number }>('users').find((r) => r.id === id)!;

  it('T1: 승인 성공 — 같은 tx에서 status/approved_by/approved_at + 강사 프로필 + audit(사유·actor)', async () => {
    const id = await signupVerified('t1_inst');
    const admin = await login('admin');
    const res = await http.post(`/api/auth/approve/${id}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: '서류 확인 완료' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'active', role: 'instructor', approvedBy: 3 });
    expect(res.body.approvedAt).toBeTruthy();
    expect(res.body.passwordHash).toBeUndefined();
    // instructor_profiles 정확 1행(active)
    const profile = profileOf(id);
    expect(profile).toMatchObject({ active: true, approvedBy: 3 });
    // audit approve 1행 — actor=JWT sub, reason 보존
    const audits = auditOf(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'approve', actorId: 3, reason: '서류 확인 완료' });
  });

  it('T2: 동시 approve×2 — 성공 1 · 409 1, 프로필/审계 각 1행', async () => {
    const id = await signupVerified('t2_inst');
    const admin = await login('admin');
    const [a, b] = await Promise.all([
      http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}),
      http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(db.findAll<Row & { id: number }>('instructor_profiles').filter((r) => r.userId === id)).toHaveLength(1);
    expect(auditOf(id)).toHaveLength(1);
  });

  it('T3: approve vs reject 경쟁 — 한 command만 성공', async () => {
    const id = await signupVerified('t3_inst');
    const admin = await login('admin');
    const [a, b] = await Promise.all([
      http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}),
      http.post(`/api/auth/reject/${id}`).set('Authorization', `Bearer ${admin}`).send({ reason: '중복 신청' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(auditOf(id)).toHaveLength(1);
  });

  it('T4: audit 실패 주입 — 승인 rollback(pending 유지·프로필 0·이력 0)', async () => {
    const id = await signupVerified('t4_inst');
    const admin = await login('admin');
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(500);
    spy.mockRestore();
    expect(userOf(id).status).toBe('pending'); // 메모리 스냅샷 rollback
    expect(profileOf(id)).toBeUndefined();
    expect(auditOf(id)).toHaveLength(0);
    // 재시도는 성공(주입 1회 한정)
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(201);
  });

  it('T5: 프로필 생성 실패 주입 — users/audit까지 전부 rollback', async () => {
    const id = await signupVerified('t5_inst');
    const admin = await login('admin');
    const profiles = app.get(InstructorProfilesStore);
    const spy = jest.spyOn(profiles, 'upsertActive').mockRejectedValueOnce(new Error('injected profile failure'));
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(500);
    spy.mockRestore();
    expect(userOf(id).status).toBe('pending');
    expect(auditOf(id)).toHaveLength(0);
  });

  // 요청 역할은 가입 시 확정된다. 승인 payload에서 role을 바꾸려는 시도는 whitelist 경계에서 거부한다.
  it('T5b: 승인 payload role 주입 → 400 (요청 역할 변경·승격 불가)', async () => {
    const id = await signupVerified('t5b_inst');
    const admin = await login('admin');
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`)
      .send({ role: 'super_admin' }).expect(400);
    expect(userOf(id).status).toBe('pending'); // 변경 없음
  });

  it('T5c: 매니저·관리자·대표 승인 범위와 pending 목록이 동일한 역할 매트릭스를 사용한다', async () => {
    const instructorId = await signupVerified('t5c_inst', 'instructor');
    const managerId = await signupVerified('t5c_manager', 'manager');
    const adminId = await signupVerified('t5c_admin', 'admin');
    const managerToken = await login('manager');
    const adminToken = await login('prof_admin');
    const ceoToken = await login('admin');

    const managerPending = (await http.get('/api/auth/pending')
      .set('Authorization', `Bearer ${managerToken}`).expect(200)).body as Array<{ id: number }>;
    expect(managerPending.some((row) => row.id === instructorId)).toBe(true);
    expect(managerPending.some((row) => row.id === managerId || row.id === adminId)).toBe(false);
    await http.post(`/api/auth/approve/${managerId}`)
      .set('Authorization', `Bearer ${managerToken}`).send({}).expect(403);
    const approvedInstructor = (await http.post(`/api/auth/approve/${instructorId}`)
      .set('Authorization', `Bearer ${managerToken}`).send({ reason: '강사 검토 완료' }).expect(201)).body;
    expect(approvedInstructor).toMatchObject({ role: 'instructor', approvedBy: 4 });

    const adminPending = (await http.get('/api/auth/pending')
      .set('Authorization', `Bearer ${adminToken}`).expect(200)).body as Array<{ id: number }>;
    expect(adminPending.some((row) => row.id === managerId)).toBe(true);
    expect(adminPending.some((row) => row.id === adminId)).toBe(false);
    await http.post(`/api/auth/approve/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`).send({}).expect(403);
    const approvedManager = (await http.post(`/api/auth/approve/${managerId}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ reason: '매니저 검토 완료' }).expect(201)).body;
    expect(approvedManager).toMatchObject({ role: 'manager', approvedBy: 5 });

    const ceoPending = (await http.get('/api/auth/pending')
      .set('Authorization', `Bearer ${ceoToken}`).expect(200)).body as Array<{ id: number }>;
    expect(ceoPending.some((row) => row.id === adminId)).toBe(true);
    const approvedAdmin = (await http.post(`/api/auth/approve/${adminId}`)
      .set('Authorization', `Bearer ${ceoToken}`).send({ reason: '관리자 검토 완료' }).expect(201)).body;
    expect(approvedAdmin).toMatchObject({ role: 'admin', approvedBy: 3 });
  });

  it('T5d: 반려도 승인과 같은 역할 범위를 강제하고 actor·사유를 감사 이력에 남긴다', async () => {
    const instructorId = await signupVerified('t5d_inst', 'instructor');
    const managerId = await signupVerified('t5d_manager', 'manager');
    const managerToken = await login('manager');
    const adminToken = await login('prof_admin');

    await http.post(`/api/auth/reject/${managerId}`).set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: '권한 범위 밖' }).expect(403);
    await http.post(`/api/auth/reject/${instructorId}`).set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: '강사 요건 미달' }).expect(201);
    await http.post(`/api/auth/reject/${managerId}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '매니저 요건 미달' }).expect(201);
    expect(auditOf(instructorId)[0]).toMatchObject({ action: 'reject', actorId: 4, reason: '강사 요건 미달' });
    expect(auditOf(managerId)[0]).toMatchObject({ action: 'reject', actorId: 5, reason: '매니저 요건 미달' });
  });

  it('T6: 이메일 미인증(잔존 구 흐름) 계정 승인 → 403 (CAS 안에서 판정)', async () => {
    // [TBO-31 C1] 신규 가입은 항상 emailVerified=true — 잔존 미인증 계정은 DB 강제 세팅으로 재현.
    const id = await signupVerified('t6_inst');
    await forceLegacyUnverified(id);
    const admin = await login('admin');
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(403);
    expect(userOf(id).status).toBe('pending');
  });

  it('T7: 반려 — 사유 필수(400) · 사유 포함 시 audit 기록 · 반려 계정 로그인 403', async () => {
    const id = await signupVerified('t7_inst');
    const admin = await login('admin');
    await http.post(`/api/auth/reject/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(400);
    await http.post(`/api/auth/reject/${id}`).set('Authorization', `Bearer ${admin}`).send({ reason: '경력 요건 미달' }).expect(201);
    const audits = auditOf(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'reject', actorId: 3, reason: '경력 요건 미달' });
    await http.post('/api/auth/login').send({ webId: 't7_inst', password: 'password123' }).expect(403);
  });

  it('T8: 리소스 노출 — pending 강사 제외, 승인 후 정확 1회 노출', async () => {
    const id = await signupVerified('t8_inst');
    const admin = await login('admin');
    const namesBefore = (await http.get('/api/schedule/resources').set('Authorization', `Bearer ${admin}`).expect(200))
      .body.instructors.filter((i: { id: number }) => i.id === id);
    expect(namesBefore).toHaveLength(0);
    await http.post(`/api/auth/approve/${id}`).set('Authorization', `Bearer ${admin}`).send({}).expect(201);
    const after = (await http.get('/api/schedule/resources').set('Authorization', `Bearer ${admin}`).expect(200))
      .body.instructors.filter((i: { id: number }) => i.id === id);
    expect(after).toHaveLength(1);
  });

  it('T10: auth_version 대조 — 버전 증가 시 기존 토큰 즉시 401, 재로그인은 정상', async () => {
    // 권위 소스 기준으로 버전을 조작한다(in-memory=메모리 · Postgres=DB 직접 UPDATE — 다중 인스턴스 시나리오 등가).
    const { PostgresConnectionService } = await import('../src/database/postgres-connection.service');
    const pg = app.get(PostgresConnectionService);
    const bump = async (v: number | null): Promise<void> => {
      if (pg.ready) await pg.query(`UPDATE users SET auth_version = ${v ?? 1} WHERE id = 1`);
      db.update('users', 1, { authVersion: (v ?? undefined) as unknown as number });
    };
    const inst = await login('park_inst');
    await http.get('/api/auth/me').set('Authorization', `Bearer ${inst}`).expect(200);
    // 외부 경로로 role/status/credential 변경이 일어났다고 가정 — auth_version +1
    await bump(2);
    await http.get('/api/auth/me').set('Authorization', `Bearer ${inst}`).expect(401); // 만료 전인데도 즉시 거부
    const fresh = await login('park_inst');
    await http.get('/api/auth/me').set('Authorization', `Bearer ${fresh}`).expect(200);
    await bump(null); // 원복(다른 스펙 간섭 방지)
  });

  it('T11: auth_events — login 성공/실패·logout 기록, 원문 credential 미저장, last_login_at 갱신', async () => {
    await http.post('/api/auth/login').send({ webId: 'manager', password: 'wrongpass' }).expect(401);
    const token = await login('manager');
    await http.post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(201);
    const events = db.findAll<Row & { id: number }>('auth_events');
    const failure = events.filter((e) => e.eventType === 'login_failure' && e.failureCode === 'bad_credentials');
    const success = events.filter((e) => e.eventType === 'login_success' && e.userId === 4);
    const logout = events.filter((e) => e.eventType === 'logout' && e.userId === 4);
    expect(failure.length).toBeGreaterThanOrEqual(1);
    expect(success.length).toBeGreaterThanOrEqual(1);
    expect(logout.length).toBeGreaterThanOrEqual(1);
    // 실패 이벤트는 원문 webId 대신 sha256(64 hex)
    const f = failure[failure.length - 1];
    expect(String(f.attemptedWebIdHash)).toMatch(/^[0-9a-f]{64}$/);
    // 어떤 이벤트에도 비밀번호/토큰 원문이 없다
    expect(JSON.stringify(events)).not.toContain('wrongpass');
    expect(JSON.stringify(events)).not.toContain('demo1234');
    // last_login_at summary
    expect(userOf(4).lastLoginAt).toBeTruthy();
  });

  it('T12: [잔존 계정 호환] 링크 인증 성공 시 토큰 컬럼 명시 클리어(hash·expires·legacy 전부 null)', async () => {
    // [TBO-31 C1] GET /auth/verify-email은 구 링크 흐름의 잔존 pending 계정 호환으로만 유지 —
    //  그 경로가 여전히 hash 대조·성공 시 명시 NULL 클리어를 지키는지 재현 검증한다.
    const id = await signupVerified('t12_inst');
    const rawToken = 'legacy-verify-token-t12-fixture';
    await forceLegacyUnverified(id, rawToken);
    await http.get(`/api/auth/verify-email?token=${rawToken}`).expect(200);
    const row = userOf(id);
    expect(row.emailVerified).toBe(true);
    expect(row.emailVerifyTokenHash ?? null).toBeNull();
    expect(row.emailVerifyExpiresAt ?? null).toBeNull();
    expect(row.emailVerifyToken ?? null).toBeNull();
  });

  it('가입 직후 인증 링크 토큰이 아예 없다 — OTP 인증 가입은 emailVerified=true·토큰 컬럼 null', async () => {
    const signup = await signupWithOtp(http, { webId: 'hash_only', email: 'hash@t.test' });
    const row = userOf(signup.account.id);
    expect(row.emailVerified).toBe(true); // [TBO-31 C1 D1] 48h 링크 단계 소멸
    expect(row.emailVerifyToken ?? null).toBeNull();
    expect(row.emailVerifyTokenHash ?? null).toBeNull();
    expect(row.emailVerifyExpiresAt ?? null).toBeNull();
  });

  // [E0.5 ④b + TBO-31 C1 D2] 가입 폼 확장 — 전화·대학·전공 + RRN 파생 birthYear가 pending 목록에
  //  노출(rrnMasked 포함)되고 승인 tx에서 프로필로 승계.
  it('가입 폼 확장 필드 — 형식 검증·pending 노출(rrnMasked)·승인 시 instructor_profiles 승계', async () => {
    // 전화 형식 위반 → 400 (SignupDto @Matches — SMS 유예 규약과 동일 정규식)
    await http.post('/api/auth/signup')
      .send({
        webId: 'e05_badphone', name: '형식오류', email: 'e05bad@t.test', password: 'password123',
        phone: '01012345678', rrn: '950101-1234567', emailChallengeId: 1,
      })
      .expect(400);
    // 정상 가입(확장 필드 포함 — birthYear는 RRN '970315-2...'에서 1997 파생) → pending 상세 노출
    const signup = await signupWithOtp(http, {
      webId: 'e05_inst', name: '확장필드', email: 'e05@t.test',
      phone: '010-9876-5432', university: '연세대학교', major: '영어영문학', rrn: '970315-2345678',
    });
    const admin = await login('admin');
    const pending = (await http.get('/api/auth/pending').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    const mine = pending.find((row: { webId: string }) => row.webId === 'e05_inst');
    expect(mine).toMatchObject({
      phone: '010-9876-5432', university: '연세대학교', major: '영어영문학', birthYear: 1997,
      rrnMasked: '970315-2******', // [D2] 승인 판단 근거 — 마스킹만
    });
    expect(mine.passwordHash).toBeUndefined();
    expect(mine.rrnEncrypted).toBeUndefined(); // 암호문도 응답 미노출(SafeAccount 제외)
    expect(JSON.stringify(mine)).not.toContain('970315-2345678'); // 평문 미노출
    // 승인 — 같은 tx에서 프로필로 승계(COALESCE upsert — birthYear는 RRN 파생값)
    await http.post(`/api/auth/approve/${signup.account.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ reason: '지원 정보 확인 완료' }).expect(201);
    expect(profileOf(signup.account.id)).toMatchObject({
      active: true, university: '연세대학교', major: '영어영문학', birthYear: 1997,
    });
  });

  it('강사 직접 등록(운영 흐름 2026-07-14) — 대표 전용, 즉시 active+프로필+audit, 곧바로 로그인 가능', async () => {
    const admin = await login('admin');
    const inst = await login('park_inst');
    const body = {
      webId: 'direct_inst', name: '김직접', password: 'securepw1', phone: '010-1234-5678',
      university: '한국대학교', major: '수학교육', birthYear: 1998,
    };
    // 비대표 → 403
    await http.post('/api/users/instructors').set('Authorization', `Bearer ${inst}`).send(body).expect(403);
    // 대표 → 201
    const created = (await http.post('/api/users/instructors').set(sudoAuthHeaders(app, admin)).send(body).expect(201)).body;
    expect(created).toMatchObject({ status: 'active', role: 'instructor', name: '김직접', approvedBy: 3 });
    const profile = profileOf(created.id);
    expect(profile).toMatchObject({ active: true, university: '한국대학교', major: '수학교육', birthYear: 1998 });
    // 직접 등록은 결정(approve/reject)이 아니라 create 이력 — auditOf(결정 전용 필터) 대신 직접 조회.
    expect(db.findAll<Row & { id: number; action?: string }>('audit_log')
      .filter((r) => r.entity === 'users' && r.entityId === created.id && r.action === 'create')).toHaveLength(1);
    // 리소스 노출 + 즉시 로그인
    const found = (await http.get('/api/schedule/resources').set('Authorization', `Bearer ${admin}`).expect(200))
      .body.instructors.filter((i: { id: number }) => i.id === created.id);
    expect(found).toHaveLength(1);
    await http.post('/api/auth/login').send({ webId: 'direct_inst', password: 'securepw1' }).expect(201);
    // 중복 webId → 400
    await http.post('/api/users/instructors').set(sudoAuthHeaders(app, admin)).send(body).expect(400);
  });
});
