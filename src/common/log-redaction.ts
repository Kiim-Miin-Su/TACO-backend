// [TBO-58 P2] phone 문자열 패턴 + 보호자/학생/학부모 실명 키 보강(값이 어느 카테고리로 새어도 차단)
const SENSITIVE_KEY = /(authorization|access_?token|refresh_?token|token|password|secret|email|phone|code|birth_?date|address|kakao_?id|counsel_?topic|rrn|(student|parent|guardian)_?name)/i;
const KR_PHONE_RE = /\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g; // 휴대전화 형태 문자열

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return '[redacted-depth]';
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
      .replace(KR_PHONE_RE, '[redacted-phone]'); // [TBO-58 P2]
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : redactLogValue(val, depth + 1),
    ]),
  );
}

export function safeUrlForLog(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl, 'http://taco.local');
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(redactLogValue(rawUrl));
  }
}
