import { isDeepStrictEqual } from 'node:util';

// [TBO-29C C4] realm-중립 평면 복제 — 메모리 tx 롤백(structuredClone)이 jest VM realm 밖 prototype을
//  가진 배열/객체를 남길 수 있어, 값이 완전히 같아도 isDeepStrictEqual이 prototype 정체성에서 실패했다
//  (PG 모드 C0 기준선 발견 ③의 잔여 원인). 값·타입 엄격성(null vs undefined, string vs number)은 유지.
function plainClone<T>(value: T): T {
  // Array.from — cross-realm 배열의 .map()은 species가 원 realm을 따라가므로 현재 realm 배열로 강제 생성.
  if (Array.isArray(value)) return Array.from(value as unknown[], (item) => plainClone(item)) as never;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plainClone(v);
    return out as never;
  }
  return value;
}

export type ExpectedAfterResult<T> = {
  ok: boolean;
  expected: T;
  after: T;
};

/**
 * 연쇄 쓰기 이후 재조회한 상태가 사전에 계산한 상태와 같은지 검증한다.
 * 오류 메시지에 expected/after를 함께 남겨 DB 스모크에서도 차이를 바로 추적할 수 있다.
 */
export function compareExpectedAfter<T>(expected: T, after: T): ExpectedAfterResult<T> {
  return { ok: isDeepStrictEqual(plainClone(expected), plainClone(after)), expected, after };
}

export function assertExpectedAfter<T>(label: string, expected: T, after: T): void {
  const result = compareExpectedAfter(expected, after);
  if (result.ok) return;
  throw new Error(
    `${label} integrity mismatch\nexpected=${JSON.stringify(expected)}\nafter=${JSON.stringify(after)}`,
  );
}
