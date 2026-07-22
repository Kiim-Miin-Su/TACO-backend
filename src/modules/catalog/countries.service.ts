import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COUNTRIES_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { COUNTRY_SEED_ROWS } from '../../database/migrations/countries.migration';
import { COUNTRIES, type Country } from './country.entity';

// [E0.5 ④] 국가·시간대 카탈로그 — 자유 입력 폐지(대표 지시 2026-07-15).
//  · 참조 데이터: test fixture 관문의 비대상(seedReference) — production에서도 항상 존재.
//    PG에는 마이그레이션 20260715_06이 권위(ON CONFLICT DO NOTHING)·부팅 시드는 미적용 환경 방어.
//  · 검증 API: isValidCountryCode / isValidTimeZone — profile 변경(countryCode/timeZone)이 사용.
@Injectable()
export class CountriesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

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

  findAll(): Country[] {
    return this.db
      .findAll<Country>(COUNTRIES)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }

  findByCode(code?: string | null): Country | undefined {
    if (!code) return undefined;
    const upper = code.trim().toUpperCase();
    return this.db.findAll<Country>(COUNTRIES).find((row) => row.code === upper);
  }

  /** countryCode가 활성 카탈로그에 존재하는가 — null(비움)은 호출부에서 허용 처리. */
  isValidCountryCode(code: string): boolean {
    return this.findByCode(code) !== undefined;
  }

  /** timeZone이 카탈로그 tz 집합에 속하는가 — 국가와의 교차 일치는 강제하지 않는다
   *  (FE 토글이 국가 선택 시 자동 세팅; 서버는 '카탈로그 밖 자유 입력'만 차단). */
  isValidTimeZone(timeZone: string): boolean {
    const target = timeZone.trim();
    return this.db.findAll<Country>(COUNTRIES).some((row) => row.timeZone === target);
  }
}
