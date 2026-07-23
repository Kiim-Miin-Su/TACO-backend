// [TBO-34 C2-C 2026-07-23] 보안 승격 검증 — ① 가드 토큰 추출 단일화(SuperAdminGuard cookie 결함 수정)
//  ② sudo 서버측 강제(민감 계정 명령) ③ TLS 단일 진실원 production fail-closed ④ runtime DDL 재활성화
//  금지 ⑤ RRN 키 버전 태그·이전 키 폴백. 순수 함수·정책은 직접 소비(사본 0), 라우트는 e2e로 실증.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { resolvePgSsl, assertPgUrlPolicy } from '../src/database/pg-ssl';
import { assertRuntimeDdlPolicy } from '../src/database/postgres-connection.service';
import { decryptRrn, encryptRrn, isCurrentRrnFormat } from '../src/common/rrn-crypto.util';
import { randomBytes } from 'node:crypto';

const withEnv = async (patch: Record<string, string | undefined>, fn: () => void | Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

describe('정책 단위 — TLS·DDL·RRN (TBO-34 C2-C)', () => {
  it('TLS: production은 검증 강제(rejectUnauthorized=true), DB_SSL=false·sslmode=disable은 fail-closed', async () => {
    await withEnv({ NODE_ENV: 'production', DB_SSL: undefined, DB_SSL_CA: undefined, DB_SSL_CA_FILE: undefined }, () => {
      expect(resolvePgSsl()).toEqual({ rejectUnauthorized: true });
      expect(() => assertPgUrlPolicy('postgres://u:p@host/db?sslmode=disable')).toThrow(/sslmode=disable/);
      expect(() => assertPgUrlPolicy('postgres://u:p@host/db?sslmode=require')).not.toThrow();
    });
    await withEnv({ NODE_ENV: 'production', DB_SSL: 'false' }, () => {
      expect(() => resolvePgSsl()).toThrow(/DB_SSL=false/);
    });
    await withEnv({ NODE_ENV: 'test', DB_SSL: 'false' }, () => {
      expect(resolvePgSsl()).toBe(false); // 로컬 평문 보존
    });
    await withEnv({ NODE_ENV: 'test', DB_SSL: undefined }, () => {
      expect(resolvePgSsl()).toEqual({ rejectUnauthorized: false }); // 개발 관용 보존
    });
  });

  it('DDL: production에서 RUNTIME_SCHEMA_DDL=true 재활성화는 fail-fast', async () => {
    await withEnv({ NODE_ENV: 'production', RUNTIME_SCHEMA_DDL: 'true' }, () => {
      expect(() => assertRuntimeDdlPolicy()).toThrow(/versioned migration/);
    });
    await withEnv({ NODE_ENV: 'production', RUNTIME_SCHEMA_DDL: undefined }, () => {
      expect(() => assertRuntimeDdlPolicy()).not.toThrow(); // 기본(skip)은 정상
    });
    await withEnv({ NODE_ENV: 'test', RUNTIME_SCHEMA_DDL: 'true' }, () => {
      expect(() => assertRuntimeDdlPolicy()).not.toThrow(); // 개발·테스트는 허용
    });
  });

  it('RRN: 신규 암호문 v1 태그·레거시 복호 호환·이전 키 폴백(회전 창)', async () => {
    const keyA = randomBytes(32).toString('base64');
    const keyB = randomBytes(32).toString('base64');
    await withEnv({ RRN_ENC_KEY: keyA, RRN_ENC_KEY_PREVIOUS: undefined }, () => {
      const cipher = encryptRrn('900101-1234567');
      expect(isCurrentRrnFormat(cipher)).toBe(true); // v1: 접두
      expect(decryptRrn(cipher)).toBe('900101-1234567');
      // 레거시(무접두)도 같은 키면 복호
      expect(decryptRrn(cipher.slice('v1:'.length))).toBe('900101-1234567');
    });
    // 회전: keyA로 만든 암호문을 keyB(현행)+keyA(이전) 배치에서 폴백 복호
    let legacyCipher = '';
    await withEnv({ RRN_ENC_KEY: keyA }, () => { legacyCipher = encryptRrn('850505-2345678'); });
    await withEnv({ RRN_ENC_KEY: keyB, RRN_ENC_KEY_PREVIOUS: keyA }, () => {
      expect(decryptRrn(legacyCipher)).toBe('850505-2345678');
    });
    // 이전 키 미배치면 실패(fail-closed)
    await withEnv({ RRN_ENC_KEY: keyB, RRN_ENC_KEY_PREVIOUS: undefined }, () => {
      expect(() => decryptRrn(legacyCipher)).toThrow();
    });
  });
});

describe('가드·sudo (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminCookies: string[] = [];
  const cookieHeader = (extra: string[] = []) => [...adminCookies, ...extra].join('; ');

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    // HttpOnly 쿠키 세션 재현 — Set-Cookie에서 access/refresh 추출(Bearer 미사용)
    adminCookies = (login.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .filter((c) => c.startsWith('access_token=') || c.startsWith('refresh_token='));
    expect(adminCookies.some((c) => c.startsWith('access_token='))).toBe(true);
  });
  afterAll(async () => { await app.close(); });

  it('SuperAdminGuard cookie 결함 수정 — cookie-only 세션으로 대표 전용 라우트 통과(종전 401)', async () => {
    // 강사 직접 등록은 SuperAdminGuard+SudoGuard — sudo 없으면 403 SUDO_REQUIRED(401 아님 = 인증은 통과)
    const denied = await http.post('/api/users/instructors').set('Cookie', cookieHeader())
      .send({ webId: 'c2c_guard_probe', name: '가드검증', password: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.code ?? denied.body.message).toBeDefined();
    expect(JSON.stringify(denied.body)).toContain('SUDO_REQUIRED');
  });

  it('sudo 서버측 강제 — reauth 성공 시 sudo 쿠키 발급 → 민감 명령 통과, 없으면 403', async () => {
    // 1) reauth로 sudo 쿠키 획득
    const reauth = await http.post('/api/auth/reauth').set('Cookie', cookieHeader())
      .send({ currentPassword: 'demo1234' }).expect(201);
    const sudoCookie = (reauth.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('sudo_token='));
    expect(sudoCookie).toBeDefined();

    // 2) sudo 쿠키 포함 → 대표 직접 수정 통과(대상: 강사 계정 1 이름 변경 후 원복)
    const target = 1; // park_inst
    const before = (await http.get(`/api/users/${target}`).set('Cookie', cookieHeader()).expect(200)).body;
    const renamed = await http.patch(`/api/users/${target}`).set('Cookie', cookieHeader([sudoCookie!]))
      .send({ name: 'C2C재인증검증' });
    expect(renamed.status).toBe(200);
    await http.patch(`/api/users/${target}`).set('Cookie', cookieHeader([sudoCookie!]))
      .send({ name: before.name }).expect(200); // 원복

    // 3) sudo 쿠키 없이 같은 명령 → 403 SUDO_REQUIRED
    const noSudo = await http.patch(`/api/users/${target}`).set('Cookie', cookieHeader()).send({ name: 'X' });
    expect(noSudo.status).toBe(403);
    expect(JSON.stringify(noSudo.body)).toContain('SUDO_REQUIRED');

    // 4) 위조 sudo(액세스 토큰을 sudo 자리에) → purpose 불일치 거부
    const access = adminCookies.find((c) => c.startsWith('access_token='))!.split('=')[1];
    const forged = await http.patch(`/api/users/${target}`)
      .set('Cookie', cookieHeader([`sudo_token=${access}`])).send({ name: 'X' });
    expect([401, 403]).toContain(forged.status);
  });

  it('Bearer 경로는 sudo 면제(테스트·이행 호환) — 기존 e2e 계약 보존', async () => {
    const bearer = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' })).body.accessToken;
    const target = 1;
    const before = (await http.get(`/api/users/${target}`).set({ Authorization: `Bearer ${bearer}` })).body;
    await http.patch(`/api/users/${target}`).set({ Authorization: `Bearer ${bearer}` })
      .send({ name: before.name }).expect(200); // no-op 수정 — sudo 없이 통과
  });

  it('로그아웃은 sudo 쿠키도 함께 만료시킨다', async () => {
    const login = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]);
    const logout = await http.post('/api/auth/logout').set('Cookie', cookies.join('; ')).expect(201);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cleared.some((c) => c.startsWith('sudo_token=;') || (c.startsWith('sudo_token=') && /Max-Age=0/i.test(c)))).toBe(true);
  });
});
