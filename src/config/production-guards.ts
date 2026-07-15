// [TBO-28B §4] production 부팅 fail-fast — 아래 상태로는 기동하지 않는다(불변식 §5-7):
//  · demo seed(UsersService가 별도 차단) · in-memory DB 폴백 · raw verification URL 노출.
//  main.ts와 api/index.ts(서버리스) 양쪽 부트 경로에서 호출한다.
import { runtimeDatabaseUrl } from '../database/database-url';

export function assertProductionBootSafety(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  // (a) DB 없음 → in-memory 폴백은 콜드스타트마다 데이터 유실 — 부팅 차단.
  if (!runtimeDatabaseUrl()) missing.push('DATABASE_URL(또는 POSTGRES_URL)');
  // (b) JWT_SECRET — AuthService 생성 시에도 throw하지만 부트 진입점에서 먼저 명확히 알린다.
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  // (c) 인증 메일 전달 수단 없음 → devLink 노출 경로뿐 — 부팅 차단.
  if (!process.env.SMTP_HOST) missing.push('SMTP_HOST(+SMTP_PORT/USER/PASS)');
  if (missing.length) {
    throw new Error(
      `[boot] production 필수 환경변수 누락 — ${missing.join(', ')}. ` +
      'in-memory 폴백/개발 기본키/인증링크 노출 상태로는 운영 기동을 차단합니다(TBO-28B §4).',
    );
  }
}

// [TBO-29C 계정 청크 2026-07-15] demo 자격증명 방어(심층 방어) — 클라이언트 계정 전환 토글은
//  TBO-29에서 폐지됐고(다른 계정=로그아웃 후 실제 로그인), demo seed는 production에서 부팅 차단되지만,
//  과거 데이터/실수로 demo 비밀번호 계정이 살아 있어도 운영에서는 로그인 자체를 거부한다.
//  비밀번호 원문은 비교에만 쓰고 어디에도 기록하지 않는다.
const DEMO_PASSWORDS = new Set(['demo1234']);

export function isForbiddenDemoCredential(password: string | undefined | null): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  return !!password && DEMO_PASSWORDS.has(password);
}
