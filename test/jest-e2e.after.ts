// [TBO-83] 최초 결과가 권위다. setup-app이 스위트당 localhost ephemeral listener를 한 번만
// 열어 Supertest의 요청별 listen/close 포트 churn을 제거했으므로, 404/401을 retry로 숨기지 않는다.
jest.retryTimes(0);

// [TBO-79 J2 2026-07-30] 기본 test timeout은 jest-e2e.json의 testTimeout=20000이 정한다.
//  종전엔 120/130 스위트가 jest 기본값 5초로 돌았다. 회차 3개를 순차 가입시키는 스위트는
//  HTTP 왕복이 9회를 넘어서, 부하가 걸린 머신에서 5초를 넘기면 **스톨-플레이크**가 된다
//  (2026-07-30 release: auth-approval T5c가 5초 초과 → 재시도 → OTP 60초 쿨다운에 걸려 400).
//  timeout은 정확성 게이트가 아니라 hang 감지기다 — 20초는 이미 개별 선언한 10개 스위트가
//  쓰던 값과 같다. 개별 파일의 jest.setTimeout은 그대로 우선한다.
