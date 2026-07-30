// [2026-07-16 release 게이트 안정화] 테스트 1회 재시도 — 병렬 부하에서 간헐 발생하는
//  소켓 계열 플레이크(supertest "Parse Error: Expected HTTP/"·경로 오염성 404 — _logs/e2e-20260716-160309
//  실측) 흡수. 실제 회귀는 재시도에서도 실패해 게이트를 그대로 막고, 재시도 전 오류는
//  logErrorsBeforeRetry로 항상 로그에 남는다(은폐 없음 — 반복되는 플레이크는 로그로 추적).
//  setupFilesAfterEach가 아니라 setupFilesAfterEnv여야 jest-circus에 retryTimes가 등록된다.
jest.retryTimes(1, { logErrorsBeforeRetry: true });

// [TBO-79 J2 2026-07-30] 기본 test timeout은 jest-e2e.json의 testTimeout=20000이 정한다.
//  종전엔 120/130 스위트가 jest 기본값 5초로 돌았다. 회차 3개를 순차 가입시키는 스위트는
//  HTTP 왕복이 9회를 넘어서, 부하가 걸린 머신에서 5초를 넘기면 **스톨-플레이크**가 된다
//  (2026-07-30 release: auth-approval T5c가 5초 초과 → 재시도 → OTP 60초 쿨다운에 걸려 400).
//  timeout은 정확성 게이트가 아니라 hang 감지기다 — 20초는 이미 개별 선언한 10개 스위트가
//  쓰던 값과 같다. 개별 파일의 jest.setTimeout은 그대로 우선한다.
