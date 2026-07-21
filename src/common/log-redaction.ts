const SENSITIVE_KEY = /(authorization|access_?token|refresh_?token|token|password|secret|email|phone|code|birth_?date|address|kakao_?id|rrn)/i;

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return '[redacted-depth]';
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]');
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
