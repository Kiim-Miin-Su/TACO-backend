import { BaseRow } from '../../common/types/base';

export const COUNTRIES = 'countries';

// [E0.5 ④] 국가·시간대 카탈로그 행 — 참조 데이터(수기 CRUD 없음, 시드·마이그레이션만).
//  프론트 lib/domain/tz.ts COUNTRIES와 1:1(다중 tz 국가는 US/US-W 권역 분할 + 대표 IANA tz 1개).
export type Country = BaseRow & {
  code: string; // ISO 3166-1 alpha-2 또는 권역 분할 코드(US-W)
  nameKo: string;
  nameEn: string;
  timeZone: string; // 대표 IANA tz
  flag: string | null;
  sortOrder: number;
};
