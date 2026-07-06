// [R3 2026-07-06] 카테고리 로깅 단일 헬퍼 — "모든 로깅을 종류별로 나누어 저장"의 규약 지점.
//  카테고리: http(요청 계측) | error(예외) | audit(변경 이력 — DB는 audit_log, 콘솔 미러용) | app(그 외).
//  개발: 사람이 읽는 한 줄(기존 형식 유지 — grep 접두사 [category]).
//  운영: JSON 라인(수집기 파싱용 — Vercel 등 콘솔 수집 전제, docs/logging.md).
//  PII·토큰·요청 바디는 어떤 카테고리에도 넣지 않는다(기존 원칙 유지).
export type LogCategory = 'http' | 'error' | 'audit' | 'app';

export function logLine(category: LogCategory, payload: Record<string, unknown>): string {
  if (process.env.NODE_ENV === 'production') {
    return JSON.stringify({ t: new Date().toISOString(), category, ...payload });
  }
  // 개발용 한 줄 — 값만 공백 구분(기존 "[HTTP] POST /api/x 201 8ms" 가독성 유지)
  return Object.values(payload).filter((v) => v !== undefined).join(' ');
}
