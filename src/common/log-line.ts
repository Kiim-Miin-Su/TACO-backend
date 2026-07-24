// [R3 2026-07-06] 카테고리 로깅 단일 헬퍼 — "모든 로깅을 종류별로 나누어 저장"의 규약 지점.
//  카테고리: http(요청 계측) | error(예외) | audit(변경 이력 — DB는 audit_log, 콘솔 미러용) | app(그 외).
//  개발: 사람이 읽는 한 줄(기존 형식 유지 — grep 접두사 [category]).
//  운영: JSON 라인(수집기 파싱용 — Vercel 등 콘솔 수집 전제, docs/logging.md).
//  PII·토큰·요청 바디는 어떤 카테고리에도 넣지 않는다(기존 원칙 유지).
import { redactLogValue } from './log-redaction';
import { isProduction } from './env'; // [TBO-34 C3] 환경 판정 단일 진실원
import { currentRequestId } from './request-context'; // [TBO-58 P2] rid 상관관계 — 운영 JSON에 필드로

export type LogCategory = 'http' | 'error' | 'audit' | 'app';

export function logLine(category: LogCategory, payload: Record<string, unknown>): string {
  const safePayload = redactLogValue(payload) as Record<string, unknown>;
  if (isProduction()) {
    const rid = currentRequestId(); // 개발 한 줄엔 RidConsoleLogger가 첨부(중복 방지 분업)
    return JSON.stringify({ t: new Date().toISOString(), category, ...(rid ? { rid } : {}), ...safePayload });
  }
  // 개발용 한 줄 — 값만 공백 구분(기존 "[HTTP] POST /api/x 201 8ms" 가독성 유지)
  return Object.values(safePayload).filter((v) => v !== undefined).join(' ');
}
