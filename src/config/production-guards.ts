// [TBO-28B §4] production 부팅 fail-fast — 아래 상태로는 기동하지 않는다(불변식 §5-7):
//  · in-memory DB 폴백 · raw verification URL 노출.
//  main.ts와 api/index.ts(서버리스) 양쪽 부트 경로에서 호출한다.
import { runtimeDatabaseUrl } from '../database/database-url';
import { isProduction } from '../common/env'; // [P2 M4]

export function assertProductionBootSafety(): void {
  if (!isProduction()) return; // [P2 M4]
  const missing: string[] = [];
  // (a) DB 없음 → in-memory 폴백은 콜드스타트마다 데이터 유실 — 부팅 차단.
  if (!runtimeDatabaseUrl()) missing.push('DATABASE_URL(또는 POSTGRES_URL)');
  // (b) JWT_SECRET — AuthService 생성 시에도 throw하지만 부트 진입점에서 먼저 명확히 알린다.
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  // (c) 인증 메일 전달 수단 없음 → devLink 노출 경로뿐 — 부팅 차단.
  if (!process.env.SMTP_HOST) missing.push('SMTP_HOST(+SMTP_PORT/USER/PASS)');
  // (c-2) client IP 기반 보안 이벤트/공유 throttle은 proxy 신뢰 경계가 명시돼야 한다.
  if (!process.env.TRUST_PROXY) missing.push('TRUST_PROXY(hop 수 또는 CIDR)');
  // (d) [TBO-31 C1 D2] 주민등록번호 암호화 키 — 미설정이면 개발용 파생 키 폴백뿐이라 부팅 차단
  //  (rrn-crypto.util은 throw하지 않는다 — 부팅 관문이 유일한 차단 지점). base64 32B 형식까지 검사.
  if (!process.env.RRN_ENC_KEY) {
    missing.push('RRN_ENC_KEY(base64 32B)');
  } else if (Buffer.from(process.env.RRN_ENC_KEY, 'base64').length !== 32) {
    missing.push('RRN_ENC_KEY(형식 오류 — base64 인코딩 32바이트 필요)');
  }
  if (missing.length) {
    throw new Error(
      `[boot] production 필수 환경변수 누락 — ${missing.join(', ')}. ` +
      'in-memory 폴백/개발 기본키/인증링크 노출 상태로는 운영 기동을 차단합니다(TBO-28B §4).',
    );
  }
}

// [TBO-29C 계정 청크 2026-07-15] demo 자격증명 방어(심층 방어) — 클라이언트 계정 전환 토글은
//  TBO-29에서 계정 전환 토글과 runtime fixture는 폐지됐다. 과거 데이터/실수로 알려진 테스트 비밀번호
//  계정이 살아 있어도 운영에서는 로그인 자체를 거부한다.
//  비밀번호 원문은 비교에만 쓰고 어디에도 기록하지 않는다.
const DEMO_PASSWORDS = new Set(['demo1234']);

export function isForbiddenDemoCredential(password: string | undefined | null): boolean {
  if (!isProduction()) return false; // [P2 M4]
  return !!password && DEMO_PASSWORDS.has(password);
}
