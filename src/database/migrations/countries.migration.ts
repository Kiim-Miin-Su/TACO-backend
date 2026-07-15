export const COUNTRIES_MIGRATION_ID = '20260715_06_countries';

// [E0.5 ④ 2026-07-15] 국가·시간대 카탈로그 — 자유 입력 폐지의 권위 저장소.
//  대표 지시: "국가코드·시간대는 맘대로 하면 헷갈리니 DB에 유명 국가들을 저장해 두고 toggle로 선택".
//  · 행 구성은 프론트 lib/domain/tz.ts COUNTRIES(캘린더 시차 엔진·학생 국가 자동완성의 기존 단일
//    소스)와 1:1 동일 — 다중 시간대 국가는 US/US-W처럼 권역 분할 코드에 대표 IANA tz 1개(기존 규약).
//  · **참조 데이터**라 데모 시드 관문(demoSeedEnabled)의 대상이 아니다 — production에도 반드시
//    존재해야 하는 제품 카탈로그(멱등 INSERT ... ON CONFLICT DO NOTHING).
//  · 검증 규칙: profile 변경의 countryCode는 활성 카탈로그 code, timeZone은 카탈로그 tz 집합만 허용.
export const COUNTRIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS countries (
    id serial PRIMARY KEY,
    code varchar(8) NOT NULL UNIQUE,
    name_ko varchar(50) NOT NULL,
    name_en varchar(80) NOT NULL,
    time_zone varchar(64) NOT NULL,
    flag varchar(8),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

/** 시드 행 — id 고정(참조 안정), 순서 = 유학·해외 수강 빈도(프론트 자동완성과 동일). */
export const COUNTRY_SEED_ROWS: ReadonlyArray<{
  id: number; code: string; nameKo: string; nameEn: string; timeZone: string; flag: string; sortOrder: number;
}> = [
  { id: 1, code: 'KR', nameKo: '한국', nameEn: 'Korea', timeZone: 'Asia/Seoul', flag: '🇰🇷', sortOrder: 1 },
  { id: 2, code: 'US', nameKo: '미국(동부)', nameEn: 'United States', timeZone: 'America/New_York', flag: '🇺🇸', sortOrder: 2 },
  { id: 3, code: 'US-W', nameKo: '미국(서부)', nameEn: 'United States West', timeZone: 'America/Los_Angeles', flag: '🇺🇸', sortOrder: 3 },
  { id: 4, code: 'CA', nameKo: '캐나다', nameEn: 'Canada', timeZone: 'America/Toronto', flag: '🇨🇦', sortOrder: 4 },
  { id: 5, code: 'GB', nameKo: '영국', nameEn: 'United Kingdom', timeZone: 'Europe/London', flag: '🇬🇧', sortOrder: 5 },
  { id: 6, code: 'DE', nameKo: '독일', nameEn: 'Germany', timeZone: 'Europe/Berlin', flag: '🇩🇪', sortOrder: 6 },
  { id: 7, code: 'FR', nameKo: '프랑스', nameEn: 'France', timeZone: 'Europe/Paris', flag: '🇫🇷', sortOrder: 7 },
  { id: 8, code: 'AU', nameKo: '호주', nameEn: 'Australia', timeZone: 'Australia/Sydney', flag: '🇦🇺', sortOrder: 8 },
  { id: 9, code: 'NZ', nameKo: '뉴질랜드', nameEn: 'New Zealand', timeZone: 'Pacific/Auckland', flag: '🇳🇿', sortOrder: 9 },
  { id: 10, code: 'JP', nameKo: '일본', nameEn: 'Japan', timeZone: 'Asia/Tokyo', flag: '🇯🇵', sortOrder: 10 },
  { id: 11, code: 'CN', nameKo: '중국', nameEn: 'China', timeZone: 'Asia/Shanghai', flag: '🇨🇳', sortOrder: 11 },
  { id: 12, code: 'HK', nameKo: '홍콩', nameEn: 'Hong Kong', timeZone: 'Asia/Hong_Kong', flag: '🇭🇰', sortOrder: 12 },
  { id: 13, code: 'SG', nameKo: '싱가포르', nameEn: 'Singapore', timeZone: 'Asia/Singapore', flag: '🇸🇬', sortOrder: 13 },
  { id: 14, code: 'VN', nameKo: '베트남', nameEn: 'Vietnam', timeZone: 'Asia/Ho_Chi_Minh', flag: '🇻🇳', sortOrder: 14 },
  { id: 15, code: 'TH', nameKo: '태국', nameEn: 'Thailand', timeZone: 'Asia/Bangkok', flag: '🇹🇭', sortOrder: 15 },
  { id: 16, code: 'MY', nameKo: '말레이시아', nameEn: 'Malaysia', timeZone: 'Asia/Kuala_Lumpur', flag: '🇲🇾', sortOrder: 16 },
  { id: 17, code: 'PH', nameKo: '필리핀', nameEn: 'Philippines', timeZone: 'Asia/Manila', flag: '🇵🇭', sortOrder: 17 },
  { id: 18, code: 'ID', nameKo: '인도네시아', nameEn: 'Indonesia', timeZone: 'Asia/Jakarta', flag: '🇮🇩', sortOrder: 18 },
  { id: 19, code: 'IN', nameKo: '인도', nameEn: 'India', timeZone: 'Asia/Kolkata', flag: '🇮🇳', sortOrder: 19 },
  { id: 20, code: 'AE', nameKo: 'UAE(두바이)', nameEn: 'United Arab Emirates', timeZone: 'Asia/Dubai', flag: '🇦🇪', sortOrder: 20 },
];

const seedValues = COUNTRY_SEED_ROWS
  .map((c) => `(${c.id}, '${c.code}', '${c.nameKo}', '${c.nameEn}', '${c.timeZone}', '${c.flag}', ${c.sortOrder})`)
  .join(',\n    ');

// 멱등 시드: id·code 어느 쪽 충돌이든 건너뜀(부팅 seedReference와 교차 실행돼도 중복 0).
export const COUNTRIES_SEED_SQL = `
  INSERT INTO countries (id, code, name_ko, name_en, time_zone, flag, sort_order) VALUES
    ${seedValues}
  ON CONFLICT DO NOTHING`;

export const COUNTRIES_SEQUENCE_SQL = `
  SELECT setval(pg_get_serial_sequence('countries','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM countries), 1))`;

export const COUNTRIES_MIGRATION_SQL: readonly string[] = [
  COUNTRIES_TABLE_SQL,
  COUNTRIES_SEED_SQL,
  COUNTRIES_SEQUENCE_SQL,
];
