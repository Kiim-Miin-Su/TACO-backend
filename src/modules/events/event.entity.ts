import type { AcademyEvent as AcademyEventContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// 학원 이벤트/공지(admin 발행) — 캘린더에 날짜 구간으로 표시. FK 없음(독립 엔티티).
// 캘린더 참조 무결성: endDate ≥ startDate(구간 유효), priority='high'만 학생/학부모 기본 캘린더 노출.
export type { EventType, EventPriority } from '@kms545487/contracts';
export type AcademyEvent = AcademyEventContract & BaseRow;
export const ACADEMY_EVENTS = 'academy_events';
