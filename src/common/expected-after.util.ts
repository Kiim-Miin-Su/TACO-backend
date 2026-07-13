import { isDeepStrictEqual } from 'node:util';

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
  return { ok: isDeepStrictEqual(expected, after), expected, after };
}

export function assertExpectedAfter<T>(label: string, expected: T, after: T): void {
  const result = compareExpectedAfter(expected, after);
  if (result.ok) return;
  throw new Error(
    `${label} integrity mismatch\nexpected=${JSON.stringify(expected)}\nafter=${JSON.stringify(after)}`,
  );
}
