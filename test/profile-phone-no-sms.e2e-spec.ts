// [2026-07-15 SMS 추후 구현] 휴대전화 변경의 OTP 요구는 SMS provider env 존재 여부에 연동 —
//  미설정(현 시범운영): 형식 정규화+중복 검사+관리자 승인만으로 접수.
//  설정(NCP SENS/Twilio env 완비): 인증 필수가 자동 복원(400). 두 상태를 같은 스위트에서 검증한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('[SMS 추후] phone change without SMS provider (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp(); // setup이 NCP_SENS_*/TWILIO_*를 제거 — provider 미설정 상태
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    for (const webId of ['park_inst', 'manager']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => {
    for (const k of ['NCP_SENS_ACCESS_KEY', 'NCP_SENS_SECRET_KEY', 'NCP_SENS_SERVICE_ID', 'NCP_SENS_FROM']) delete process.env[k];
    await app.close();
  });
  const as = (w: string) => ({ Authorization: `Bearer ${tokens[w]}` });

  it('provider 미설정 — 인증 없이 phone 변경 요청 접수 → 승인 시 E.164 정규화 반영', async () => {
    const created = (await http.post('/api/profile-change-requests').set(as('park_inst'))
      .send({ currentPassword: 'demo1234', phone: '010-2222-9999', reason: 'SMS 도입 전 시범운영 — 번호 갱신' })
      .expect(201)).body;
    expect(created.verificationChallengeId ?? null).toBeNull();
    await http.post(`/api/profile-change-requests/${created.id}/approve`).set(as('manager')).expect(201);
    const user = db.findBy<{ webId: string; phone?: string | null }>('users', (u) => u.webId === 'park_inst')[0];
    expect(user.phone).toBe('+821022229999'); // 서버 정규화(libphonenumber)는 그대로 이중 방어
  });

  it('이메일 변경은 여전히 인증 필수 — challenge 없이 400(정책 비완화 확인)', async () => {
    await http.post('/api/profile-change-requests').set(as('park_inst'))
      .send({ currentPassword: 'demo1234', email: 'no-challenge@tnacademy.test', reason: '인증 없이 이메일 변경 시도' })
      .expect(400);
  });

  it('provider env 설정 시 — phone 인증 필수가 자동 복원(400)', async () => {
    Object.assign(process.env, {
      NCP_SENS_ACCESS_KEY: 'k', NCP_SENS_SECRET_KEY: 's', NCP_SENS_SERVICE_ID: 'id', NCP_SENS_FROM: '0212345678',
    });
    try {
      await http.post('/api/profile-change-requests').set(as('manager'))
        .send({ currentPassword: 'demo1234', phone: '010-3333-9999', reason: 'provider 복원 검증' })
        .expect(400);
    } finally {
      for (const k of ['NCP_SENS_ACCESS_KEY', 'NCP_SENS_SECRET_KEY', 'NCP_SENS_SERVICE_ID', 'NCP_SENS_FROM']) delete process.env[k];
    }
  });
});
