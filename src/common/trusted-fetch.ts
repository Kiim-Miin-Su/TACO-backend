const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchTrustedOrigin(
  url: string,
  trustedOrigin: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const parsed = new URL(url);
  const expected = new URL(trustedOrigin).origin;
  if (parsed.origin !== expected) throw new Error(`허용되지 않은 외부 요청 origin: ${parsed.origin}`);
  if (parsed.protocol !== 'https:') throw new Error('외부 요청은 https만 허용합니다.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('외부 요청 timeout은 1..30000ms 정수여야 합니다.');
  }
  return fetch(parsed, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}
