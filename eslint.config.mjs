// [TBO-58 P2 2026-07-24] lint 게이트 복구 — eslint 9 flat config(구 .eslintrc 부재로 0/2였던 게이트).
//  타입체크는 tsc(typecheck 스크립트)가 담당 — 여기서는 비-타입 lint만(속도·노이즈 관리).
//  규칙 완화 사유를 각 줄에 명시한다(조용한 off 금지).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Nest 관례: 데코레이터 주입·계약 구현에서 any가 경계상 필요(계약 타입이 이미 tsc로 강제됨)
      '@typescript-eslint/no-explicit-any': 'off',
      // _접두사는 의도적 미사용(자리 표시) — 그 외 미사용은 오류 유지
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // require 스타일 금지 예외 없음 — 위반 시 수정이 원칙
    },
  },
);
