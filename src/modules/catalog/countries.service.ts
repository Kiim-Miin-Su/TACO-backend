import { Injectable, OnModuleInit } from '@nestjs/common';
import { COUNTRIES_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { COUNTRY_SEED_ROWS } from '../../database/migrations/countries.migration';
import { type Country } from './country.entity';

// [E0.5 ④] 국가·시간대 카탈로그 — 자유 입력 폐지(대표 지시 2026-07-15).
//  · 참조 데이터: test fixture 관문의 비대상(seedReference) — production에서도 항상 존재.
//    PG에는 마이그레이션 20260715_06이 권위(ON CONFLICT DO NOTHING)·부팅 시드는 미적용 환경 방어.
//  · 검증 API: isValidCountryCode / isValidTimeZone — profile 변경(countryCode/timeZone)이 사용.
// [TBO-59 2026-07-24] READ = DB 권위(findActive) 전환 — 대표 지시 "특별한 이유 없으면 모두 DB 관리".
//  쓰기 API가 없는 정적 시드라 stale 위험은 없었으나 메모리 미러 직접 반환 예외를 제거해 통일한다.
@Injectable()
export class CountriesService implements OnModuleInit {
  constructor(private readonly store: PostgresCollectionStore) {}

  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Country>(COUNTRIES_SPEC);
    if (hydrated.length) return;
    await this.store.seedReference<Country>(
      COUNTRIES_SPEC,
      COUNTRY_SEED_ROWS.map((row) => ({
        id: row.id,
        code: row.code,
        nameKo: row.nameKo,
        nameEn: row.nameEn,
        timeZone: row.timeZone,
        flag: row.flag,
        sortOrder: row.sortOrder,
      })),
    );
  }

  async findAll(): Promise<Country[]> {
    const rows = await this.store.findActive<Country>(COUNTRIES_SPEC);
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }

  async findByCode(code?: string | null): Promise<Country | undefined> {
    if (!code) return undefined;
    const upper = code.trim().toUpperCase();
    const rows = await this.store.findActive<Country>(COUNTRIES_SPEC, { where: { code: upper } as Partial<Country>, limit: 1 });
    return rows[0];
  }

  /** countryCode가 활성 카탈로그에 존재하는가 — null(비움)은 호출부에서 허용 처리. */
  async isValidCountryCode(code: string): Promise<boolean> {
    return (await this.findByCode(code)) !== undefined;
  }

  /** timeZone이 카탈로그 tz 집합에 속하는가 — 국가와의 교차 일치는 강제하지 않는다
   *  (FE 토글이 국가 선택 시 자동 세팅; 서버는 '카탈로그 밖 자유 입력'만 차단). */
  async isValidTimeZone(timeZone: string): Promise<boolean> {
    const target = timeZone.trim();
    const rows = await this.store.findActive<Country>(COUNTRIES_SPEC);
    return rows.some((row) => row.timeZone === target);
  }
}
