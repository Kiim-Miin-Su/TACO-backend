import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { forgeVerifiedEmailChallenge } from './profile-challenge-helper'; // [TBO-31 C1 D4] 상시 OTP

// [E0.5 ④] 국가·시간대 카탈로그 — 참조 데이터 조회 + profile 변경의 카탈로그 검증(자유 입력 폐지).
describe('Catalog countries (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    tokens.instructor = await login('park_inst');
    tokens.foreign = await login('jung_inst'); // GB/Europe/London 시드 — 비움(null) 시나리오용
  });

  afterAll(async () => { await app.close(); });

  it('serves the country catalog to authenticated staff only', async () => {
    await http.get('/api/catalog/countries').expect(401);
    const res = await http.get('/api/catalog/countries').set(bearer(tokens.instructor)).expect(200);
    expect(res.body).toHaveLength(20);
    // sort_order 순 + 프론트 lib/domain/tz.ts COUNTRIES와 동일한 행 구성(단일 소스 정렬).
    expect(res.body[0]).toMatchObject({ code: 'KR', nameKo: '한국', timeZone: 'Asia/Seoul' });
    expect(res.body.map((row: { code: string }) => row.code)).toEqual(
      expect.arrayContaining(['KR', 'US', 'US-W', 'GB', 'VN', 'JP', 'CN', 'AU', 'CA']),
    );
    for (const row of res.body) {
      expect(typeof row.timeZone).toBe('string'); // 속성 오타 공백 통과 방지(§13.83 학습)
      expect(row.timeZone.length).toBeGreaterThan(0);
    }
  });

  it('rejects profile changes outside the catalog and accepts catalog values', async () => {
    // 카탈로그 밖 국가 코드 — 형식은 맞아도 400 (자유 입력 폐지).
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', countryCode: 'XX', reason: '카탈로그에 없는 국가 요청입니다.' })
      .expect(400);
    // 유효한 IANA지만 카탈로그 밖 시간대 — 400.
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', timeZone: 'Pacific/Chatham', reason: '카탈로그에 없는 시간대 요청입니다.' })
      .expect(400);
    // 카탈로그 값(VN + 대표 tz)은 정상 접수(강사는 승인제 pending 유지 — E0.5 ①의 즉시 적용은 super_admin만).
    //  [TBO-31 C1 D4] 비연락처 변경도 본인 이메일 OTP 상시 — verified challenge를 같은 tx에서 소비.
    const challengeId = await forgeVerifiedEmailChallenge(app, 1, 'park@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', countryCode: 'vn', timeZone: 'Asia/Ho_Chi_Minh', verificationChallengeId: challengeId, reason: '베트남 원격 근무지로 변경합니다.' })
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'pending',
      requestedChanges: { countryCode: 'VN', timeZone: 'Asia/Ho_Chi_Minh' },
    });
    // 비움(null)은 카탈로그 검증 대상 아님 — 접수 규칙 유지(GB 시드 계정이 값을 비우는 시나리오).
    const foreignChallengeId = await forgeVerifiedEmailChallenge(app, 2, 'jung@tnacademy.test');
    await http.post('/api/profile-change-requests').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', countryCode: null, timeZone: null, verificationChallengeId: foreignChallengeId, reason: '국가·시간대 정보를 비웁니다.' })
      .expect(201);
  });
});
