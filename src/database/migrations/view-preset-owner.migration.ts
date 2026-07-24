// [TBO-58 P2 2026-07-24] 캘린더 뷰 프리셋 소유자 컬럼 — IDOR 가드(타 사용자 프리셋 수정/삭제 차단).
//  NULL = 레거시(소유자 기록 이전 생성) — 매니저 이상만 수정/삭제 가능으로 취급한다.
export const VIEW_PRESET_OWNER_MIGRATION_ID = '20260724_01_tbo58_view_preset_owner';

export const VIEW_PRESET_OWNER_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE calendar_view_presets ADD COLUMN IF NOT EXISTS created_by integer`,
];
