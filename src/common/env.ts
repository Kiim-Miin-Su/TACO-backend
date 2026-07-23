// [TBO-34 C3 2026-07-23] 환경 판정의 **단일 진실원** — `NODE_ENV === 'production'` 인라인 판정이
//  13개 파일에 사본으로 흩어져 있었다(보안 경계 판정이 흩어지면 C2-C의 SuperAdminGuard류
//  "한 곳만 고침" 결함이 재발한다). 전 모듈이 이 함수 하나만 소비한다.
export const isProduction = (): boolean => process.env.NODE_ENV === 'production';
