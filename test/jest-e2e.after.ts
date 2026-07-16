// [2026-07-16 release 게이트 안정화] 테스트 1회 재시도 — 병렬 부하에서 간헐 발생하는
//  소켓 계열 플레이크(supertest "Parse Error: Expected HTTP/"·경로 오염성 404 — _logs/e2e-20260716-160309
//  실측) 흡수. 실제 회귀는 재시도에서도 실패해 게이트를 그대로 막고, 재시도 전 오류는
//  logErrorsBeforeRetry로 항상 로그에 남는다(은폐 없음 — 반복되는 플레이크는 로그로 추적).
//  setupFilesAfterEach가 아니라 setupFilesAfterEnv여야 jest-circus에 retryTimes가 등록된다.
jest.retryTimes(1, { logErrorsBeforeRetry: true });
