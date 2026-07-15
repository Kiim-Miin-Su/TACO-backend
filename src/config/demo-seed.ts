// [시범운영 2026-07-15] 데모 시드 단일 관문 — 모든 seed() 호출(3개 스토어)이 이 게이트를 지난다.
//  · production: 기본 차단(어떤 테이블에도 mock 데이터가 들어가지 않는다). 명시 SEED_DEMO=1만 예외
//    (예: 스테이징 데모 환경). 기존에는 users만 가드되고 18개 표가 부팅 시 시드되던 결함의 해소.
//  · dev/test: 기본 허용(로컬 회귀·e2e는 시드에 의존). SEED_DEMO=0으로 끌 수 있다(깨끗한 로컬 DB).
export function demoSeedEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return process.env.SEED_DEMO === '1';
  return process.env.SEED_DEMO !== '0';
}
