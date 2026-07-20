// [B8 E4 2026-07-16] 무토큰 401 전수 스윕 — openapi.json에서 연산을 자동 파생해, 공개 allowlist
//  밖의 **모든** 라우트가 토큰 없이 401을 반환하는지 단정한다. 라우트가 추가되면 스펙 재생성만으로
//  이 스위트가 자동 확장된다(가드 누락 신설 라우트를 기계로 검출 — 29E E4 "권한(무토큰)" 차원 전수).
//  주의: 스펙의 security 마커는 불완전(75/128)해 신뢰하지 않는다 — 공개 라우트는 명시 allowlist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 설계상 공개(무토큰 허용) 라우트 — 여기 추가하려면 사유가 필요하다.
const PUBLIC_OPS = new Set([
  'POST /api/auth/signup', // 가입 신청(승인제 — 생성만)
  // [TBO-31 C1] 가입 전 이메일 OTP — 비로그인 가입 흐름 전용(스로틀 5회/분·10회/분, 열거 방지 응답)
  'POST /api/auth/signup-email-challenge',
  'POST /api/auth/signup-email-challenge/{id}/confirm',
  // [TBO-31 C1 D3] 아이디 가용성 공개 체크 — {available} boolean만(이름·역할 미노출, 스로틀 10회/분)
  'GET /api/auth/web-id-available',
  'GET /api/auth/verify-email', // 메일 링크 랜딩(토큰은 쿼리)
  'POST /api/auth/login',
  'POST /api/auth/refresh', // 자격은 httpOnly 쿠키
  'POST /api/auth/logout', // 쿠키 클리어(무해)
  'POST /api/auth/recover-id',
  'POST /api/auth/recover-password',
  'POST /api/auth/reset-password', // 자격은 메일 토큰
  // [TBO-31 C5] 비로그인 복구 OTP판 — 발송 5/분·확인/완료 10/분, 열거 방지 응답·일회 소비
  'POST /api/auth/recovery-email-challenge',
  'POST /api/auth/recovery-email-challenge/{id}/confirm',
  'POST /api/auth/recover-id/complete',
  'POST /api/auth/reset-password-otp',
  'GET /api/health',
  'GET /api/health/db',
]);

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

function specOperations(): Array<{ method: (typeof METHODS)[number]; path: string }> {
  const spec = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops: Array<{ method: (typeof METHODS)[number]; path: string }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (!item[method]) continue;
      if (PUBLIC_OPS.has(`${method.toUpperCase()} ${path}`)) continue;
      ops.push({ method, path });
    }
  }
  return ops;
}

describe('무토큰 401 전수 스윕 (e2e, B8 E4)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  it('스펙의 보호 연산 전부: 토큰 없이 호출하면 401(가드가 본 로직 앞에서 차단)', async () => {
    const ops = specOperations();
    expect(ops.length).toBeGreaterThan(100); // 스펙 로드 자체가 비었으면 즉시 실패(공허 통과 방지)
    const failures: string[] = [];
    for (const { method, path } of ops) {
      const url = path.replace(/\{[^}]+\}/g, '999999'); // 파라미터는 임의 숫자 — 가드가 먼저라 부작용 0
      const res = await http[method](url);
      if (res.status !== 401) failures.push(`${method.toUpperCase()} ${url} → ${res.status}`);
    }
    if (failures.length) {
      // 어떤 라우트가 무엇을 반환했는지 전부 표시(가드 누락 즉시 특정)
      throw new Error(`무토큰 비-401 ${failures.length}건:\n${failures.join('\n')}`);
    }
  });
});
