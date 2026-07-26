// [TBO-65 P2 4-A/B 2026-07-26] 숫자 정규화·보호자 중복 키의 단일 진실원.
//  종전: BE 인라인 \D 제거 3곳·rrn digitsOf(하이픈만 — RRN 전용이라 유지)·FE 인라인 4곳이 산개했고
//  guardianKey는 BE registrations ↔ FE student-form-model에 같은 식이 복제돼 있었다(한쪽 변경 시
//  중복 판정 어긋남). FE는 lib/domain/identity.ts가 같은 식을 미러(계약 테스트로 동형 고정).

/** 모든 비숫자 제거 — 전화번호 비교·중복 판정용(하이픈·공백·괄호 무관). */
export const onlyDigits = (value: string): string => value.replace(/\D/g, '');

/** 보호자 중복 판정 키 — 이름(trim·소문자) + 전화(숫자만). FE lib/domain/identity.guardianKey와 동형. */
export const guardianKey = (name: string, phone: string): string =>
  `${name.trim().toLowerCase()}:${onlyDigits(phone)}`;
