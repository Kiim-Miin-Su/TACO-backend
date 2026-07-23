// [TBO-34 C2-C 2026-07-23] PostgreSQL TLS 설정의 **단일 진실원** — runtime DataSource·db:check·
//  migration/smoke/release 스크립트 39곳이 각자 들고 있던 `rejectUnauthorized:false` 사본을 이 모듈
//  하나로 수렴한다. production 규약(fail-closed):
//   - 인증서 체인·hostname 검증 강제(rejectUnauthorized:true — node TLS 기본 servername 검증 포함,
//     libpq sslmode=verify-full 동등). Neon은 공인 CA 체인이라 시스템 CA로 검증된다.
//   - DB_SSL=false(평문) 금지 — 부팅/스크립트 시작 시점 즉시 throw.
//   - URL의 sslmode=disable 금지. (sslmode 파라미터와 무관하게 드라이버 레벨에서 검증을 강제한다.)
//   - 사설 CA가 필요하면 DB_SSL_CA(PEM 원문)로 주입 — 파일 경로·URL 로그 금지.
//  비production은 기존 동작 보존: DB_SSL=false → 평문(로컬 PG), 그 외 → 관용 TLS(자가서명 허용).
import { readFileSync } from 'node:fs';
import { isProduction } from '../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원


export type PgSslOption = false | { rejectUnauthorized: boolean; ca?: string };

function customCa(): string | undefined {
  const pem = process.env.DB_SSL_CA?.trim();
  if (pem) return pem;
  const path = process.env.DB_SSL_CA_FILE?.trim();
  if (path) return readFileSync(path, 'utf8'); // 존재하지 않으면 즉시 throw — fail-closed
  return undefined;
}

/** 접속 URL 정합 검증 — production에서 평문 강제 파라미터를 거부한다(값·호스트는 로그 금지). */
export function assertPgUrlPolicy(url: string | undefined): void {
  if (!url || !isProduction()) return;
  if (/[?&]sslmode=disable\b/i.test(url)) {
    throw new Error('[pg-ssl] production DATABASE_URL에 sslmode=disable은 허용되지 않습니다(TLS 검증 강제 — TBO-34 C2-C).');
  }
}

/** 모든 pg 연결(runtime·스크립트)이 소비하는 단일 SSL 설정. */
export function resolvePgSsl(): PgSslOption {
  const dbSsl = process.env.DB_SSL?.trim().toLowerCase();
  if (isProduction()) {
    if (dbSsl === 'false') {
      throw new Error('[pg-ssl] production에서 DB_SSL=false(평문 연결)는 허용되지 않습니다 — TLS 인증서·hostname 검증이 강제됩니다(TBO-34 C2-C).');
    }
    const ca = customCa();
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  }
  if (dbSsl === 'false') return false; // 로컬 PG(평문)
  return { rejectUnauthorized: false }; // 개발 관용 — 자가서명/프록시 허용(기존 동작 보존)
}
