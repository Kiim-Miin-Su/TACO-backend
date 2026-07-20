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
  account: { id: number; webId: string; name: string; role: string; status: string };
};

/** challenge 생성 → devOtpCode로 confirm → verified challenge id 반환. */
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
    webId: string; name?: string; email?: string; password?: string; role?: string; rrn?: string;
    phone?: string; university?: string; major?: string;
  },
): Promise<SignupResult> {
  const email = input.email ?? `${input.webId}@t.test`;
  const emailChallengeId = await verifiedSignupChallenge(http, email);
  const res = await http.post('/api/auth/signup').send({
    webId: input.webId,
    name: input.name ?? `계정${input.webId}`,
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
