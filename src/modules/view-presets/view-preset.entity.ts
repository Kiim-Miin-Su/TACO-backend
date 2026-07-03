import type { CalendarViewPreset } from '@kms545487/contracts';
import type { BaseRow } from '../../database/in-memory.database';

// [자산화, TBO-12 P1] 캘린더 뷰 프리셋 — 필터·스플릿·국가(시차) 조합을 직원 공용 자산으로 저장.
//  localStorage(브라우저 휘발·개인 한정)가 아닌 DB 컬렉션: 실DB 이관 시 그대로 테이블이 된다.
export const VIEW_PRESETS = 'calendar_view_presets';
export type ViewPreset = CalendarViewPreset & BaseRow;
