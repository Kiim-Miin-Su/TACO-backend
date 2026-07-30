import type { Country as CountryContract } from '@kms545487/contracts';
import { BaseRow } from '../../common/types/base';

export const COUNTRIES = 'countries';

// [E0.5 ④] 국가·시간대 카탈로그 행 — 참조 데이터(수기 CRUD 없음, 시드·마이그레이션만).
//  프론트 lib/domain/tz.ts COUNTRIES와 1:1(다중 tz 국가는 US/US-W 권역 분할 + 대표 IANA tz 1개).
// [TBO-79 F1] wire 소유는 contracts — FE가 같은 모양을 손으로 다시 선언하며 이미 드리프트가
//  있었다(flag가 BE 필수 / FE optional). 여기서는 저장 메타(BaseRow)만 얹는다.
export type Country = CountryContract & BaseRow;
