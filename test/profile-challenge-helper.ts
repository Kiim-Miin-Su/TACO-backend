// [TBO-31 C1 D4] 프로필 변경 상시 OTP 규칙용 e2e 헬퍼 — verified 이메일 challenge를 store.insert로
//  위조한다(양 모드 권위 소스 기록 — credential-change 스위트의 기존 패턴을 공용화).
//  실제 발송/코드 확인 흐름 회귀는 profile-verification.e2e-spec(fake provider DI) — 다른 스위트는
//  "요청 tx에서 일회 소비"만 필요하므로 위조로 충분하다.
//  ⚠ 활성(pending|verified) challenge는 (requester, channel)당 1건(partial unique) — 소비되지 않고
//  남는 시나리오 뒤에는 expireChallenge로 정리할 것.
import type { INestApplication } from '@nestjs/common';

export async function forgeVerifiedEmailChallenge(
  app: INestApplication,
  requesterId: number,
  target: string,
): Promise<number> {
  const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
  const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
  const store = app.get(PostgresCollectionStore);
  const now = Date.now();
  const row = await store.insert<Record<string, unknown> & { id: number }>(PROFILE_VERIFICATION_CHALLENGES_SPEC, {
    requesterId,
    channel: 'email',
    purpose: 'profile_change',
    targetNormalized: target,
    targetHash: `test-forged-${requesterId}-${now}`,
    provider: 'fake_test',
    providerReference: null,
    codeHash: 'test-forged',
    status: 'verified',
    attemptCount: 0,
    resendCount: 0,
    resendAvailableAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    verifiedAt: new Date(now).toISOString(),
    consumedAt: null,
    consumedByRequestId: null,
  });
  return row.id;
}

/** 소비되지 못한 위조 challenge 정리 — 활성 1건 partial unique 충돌 방지. */
export async function expireChallenge(app: INestApplication, id: number): Promise<void> {
  const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
  const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
  await app.get(PostgresCollectionStore).update(PROFILE_VERIFICATION_CHALLENGES_SPEC, id, { status: 'expired' });
}
