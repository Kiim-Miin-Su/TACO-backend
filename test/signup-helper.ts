// [TBO-31 C1] 가입 e2e 공용 헬퍼 — 가입 전 이메일 OTP(challenge 생성 → devOtpCode confirm) 후
//  rrn·emailChallengeId를 채워 /auth/signup을 호출한다. 기존 스위트 전부가 이 헬퍼를 재사용한다.
//  e2e는 SMTP 미설정(jest-e2e.setup) + NODE_ENV=test — devOtpCode 관례(devVerifyLink 후속)가 항상 동작.
import type request from 'supertest';

type Http = ReturnType<typeof request>;

/** 형식 유효(MM/DD 타당) 표준 픽스처 — 체크섬 미검증 규약이라 뒷자리는 임의(1995년생·성별 1). */
export const TEST_RRN = '950101-1234567';
export const TEST_RRN_BIRTH_YEAR = 1995;

export type SignupResult = {
  ok: boolean;
  message: string;
  account: { id: number; webId: string; name: string; englishName: string; role: string; status: string };
};

/**
 * challenge 생성 → devOtpCode로 confirm → verified challenge id 반환.
 *
 * ⚠ [TBO-79 J2] email이 webId에서 결정론적으로 파생되므로, **jest 재시도는 이 경로를 복구하지
 *  못한다** — 1차 시도가 만든 pending challenge가 60초 쿨다운을 걸어 2차 시도가 400으로
 *  결정론적 실패한다(2026-07-30 release 실측: T5c 5초 초과 → 재시도 400).
 *  그래서 스톨 자체를 막는 것이 유일한 방어다(testTimeout=20000). 재시도에 기대지 말 것.
 *  쿨다운까지 복구하려면 시도별 nonce email이 필요한데, email 값을 단언하는 스위트가 있어
 *  픽스처 계약을 깨므로 하지 않았다.
 */
export async function verifiedSignupChallenge(http: Http, email: string): Promise<number> {
  const created = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
  expect(String(created.devOtpCode)).toMatch(/^\d{6}$/); // SMTP 미설정 e2e — devOtpCode 필수 존재
  await http.post(`/api/auth/signup-email-challenge/${created.id}/confirm`)
    .send({ email, code: created.devOtpCode }).expect(201);
  return created.id as number;
}

/** OTP 인증 → 가입(201)까지 한 번에 — 계정은 emailVerified=true·status=pending으로 생성된다. */
export async function signupWithOtp(
  http: Http,
  input: {
    webId: string; name?: string; englishName?: string; email?: string; password?: string; role?: string; rrn?: string;
    phone?: string; university?: string; major?: string;
  },
): Promise<SignupResult> {
  const email = input.email ?? `${input.webId}@t.test`;
  const emailChallengeId = await verifiedSignupChallenge(http, email);
  const res = await http.post('/api/auth/signup').send({
    webId: input.webId,
    name: input.name ?? `계정${input.webId}`,
    englishName: input.englishName ?? 'Test Staff',
    email,
    password: input.password ?? 'password123',
    rrn: input.rrn ?? TEST_RRN,
    emailChallengeId,
    ...(input.role ? { role: input.role } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.university ? { university: input.university } : {}),
    ...(input.major ? { major: input.major } : {}),
  }).expect(201);
  return res.body as SignupResult;
}
