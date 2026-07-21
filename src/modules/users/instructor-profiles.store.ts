// [TBO-28B] 강사 운영 프로필(instructor_profiles) — users.id와 동일한 1:1 PK/FK(user_id).
//  별도 강사 식별자를 만들지 않는다(erd.dbml 노트). 계약 시급/시간은 instructor_contracts 책임.
//  쓰기는 **승인 트랜잭션 안에서만** 일어난다(users.approve — 같은 tx에 users/profile/audit).
//  PK가 user_id라 PostgresCollectionStore(id serial 전제)를 쓰지 않고 최소 전용 스토어로 구현.
//  메모리 투영은 BaseRow 규약을 위해 id=userId로 적재한다(class-sessions.store 커스텀 스토어 선례).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { BaseRow } from '../../common/types/base';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import { normalizeQueryRows, toIsoString } from '../../database/postgres-row.util';
import { TBO36_INSTRUCTOR_PROFILE_SQL } from '../../database/migrations/staff-pay-calendar.migration';

export const INSTRUCTOR_PROFILES = 'instructor_profiles';

export type InstructorProfileDetails = {
  // [운영 흐름 2026-07-14 대표 공지] 강사 직접 등록 시 받는 정보 — 이름/전화는 users, 나머지는 프로필.
  university?: string | null; // 대학교
  major?: string | null; // 전공
  birthYear?: number | null; // 출생연도(나이는 가변이라 연도로 보관)
  defaultHourlyRate?: number;
  canTeachKinder?: boolean;
};

export type InstructorProfile = {
  userId: number; // = users.id (PK/FK)
  active: boolean;
  approvedBy: number; // 승인/등록한 대표(users.id) — NOT NULL
  approvedAt: string; // ISO(timestamptz) — NOT NULL
} & InstructorProfileDetails & BaseRow; // 메모리 투영에서 id === userId

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS instructor_profiles (
    user_id integer PRIMARY KEY,
    active boolean NOT NULL DEFAULT true,
    approved_by integer NOT NULL,
    approved_at timestamptz NOT NULL,
    university varchar(100),
    major varchar(100),
    birth_year integer,
    default_hourly_rate integer NOT NULL DEFAULT 0,
    can_teach_kinder boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )
`;
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_instructor_profiles_active ON instructor_profiles (active, user_id) WHERE deleted_at IS NULL`;

@Injectable()
export class InstructorProfilesStore implements OnModuleInit {
  private readonly logger = new Logger(InstructorProfilesStore.name);
  private tableReady = false;

  constructor(
    private readonly memory: InMemoryDatabase,
    private readonly postgres: PostgresConnectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.hydrate();
  }

  private async ensureReady(): Promise<boolean> {
    await this.postgres.ensureInitialized();
    if (!this.postgres.ready) return false;
    if (this.tableReady) return true;
    await this.postgres.ddl(CREATE_SQL);
    for (const sql of TBO36_INSTRUCTOR_PROFILE_SQL) await this.postgres.ddl(sql);
    await this.postgres.ddl(INDEX_SQL);
    this.tableReady = true;
    this.logger.log('instructor_profiles table ready (Postgres-backed)');
    return true;
  }

  async hydrate(): Promise<InstructorProfile[]> {
    if (!(await this.ensureReady())) return this.memory.findAll<InstructorProfile>(INSTRUCTOR_PROFILES);
    const rows = normalizeQueryRows(await this.postgres.query(`SELECT * FROM instructor_profiles ORDER BY user_id ASC`));
    const parsed = rows.map((r) => this.fromRow(r));
    this.memory.replaceExact<InstructorProfile>(INSTRUCTOR_PROFILES, parsed);
    return parsed;
  }

  /** 승인/직접등록 tx 전용 — active 프로필 upsert(재승인 시 재활성). 호출자는 반드시 트랜잭션 안에서 부른다. */
  async upsertActive(userId: number, approvedBy: number, approvedAtIso: string, details?: InstructorProfileDetails): Promise<InstructorProfile> {
    const university = details?.university ?? null;
    const major = details?.major ?? null;
    const birthYear = details?.birthYear ?? null;
    const defaultHourlyRate = details?.defaultHourlyRate ?? 0;
    const canTeachKinder = details?.canTeachKinder ?? false;
    if (await this.ensureReady()) {
      const rows = normalizeQueryRows(await this.postgres.query(
        `INSERT INTO instructor_profiles (user_id, active, approved_by, approved_at, university, major, birth_year, default_hourly_rate, can_teach_kinder)
           VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id) DO UPDATE
             SET active = true, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
                 university = COALESCE(EXCLUDED.university, instructor_profiles.university),
                 major = COALESCE(EXCLUDED.major, instructor_profiles.major),
                 birth_year = COALESCE(EXCLUDED.birth_year, instructor_profiles.birth_year),
                 default_hourly_rate = CASE WHEN EXCLUDED.default_hourly_rate <> 0 THEN EXCLUDED.default_hourly_rate ELSE instructor_profiles.default_hourly_rate END,
                 can_teach_kinder = EXCLUDED.can_teach_kinder,
                 deleted_at = NULL, deleted_by = NULL, updated_at = now()
           RETURNING *`,
        [userId, approvedBy, approvedAtIso, university, major, birthYear, defaultHourlyRate, canTeachKinder],
      ));
      const saved = this.fromRow(rows[0]);
      this.memory.seedExact<InstructorProfile>(INSTRUCTOR_PROFILES, [saved]);
      return saved;
    }
    const existing = this.memory.findById<InstructorProfile>(INSTRUCTOR_PROFILES, userId);
    if (existing) {
      this.memory.update<InstructorProfile>(INSTRUCTOR_PROFILES, userId, {
        active: true, approvedBy, approvedAt: approvedAtIso,
        university: university ?? existing.university, major: major ?? existing.major, birthYear: birthYear ?? existing.birthYear,
        defaultHourlyRate: defaultHourlyRate || existing.defaultHourlyRate || 0,
        canTeachKinder,
      });
      return this.memory.findById<InstructorProfile>(INSTRUCTOR_PROFILES, userId)!;
    }
    const [saved] = this.memory.seed<InstructorProfile>(INSTRUCTOR_PROFILES, [
      { id: userId, userId, active: true, approvedBy, approvedAt: approvedAtIso, university, major, birthYear, defaultHourlyRate, canTeachKinder },
    ]);
    return saved;
  }

  /** 비활성화(강사 반려/비활성 전환 후속용) — 승인 tx와 동일 규약. */
  async deactivate(userId: number): Promise<void> {
    if (await this.ensureReady()) {
      await this.postgres.query(
        `UPDATE instructor_profiles SET active = false, updated_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
    }
    if (this.memory.findById<InstructorProfile>(INSTRUCTOR_PROFILES, userId)) {
      this.memory.update<InstructorProfile>(INSTRUCTOR_PROFILES, userId, { active: false });
    }
  }

  findActive(userId: number): InstructorProfile | undefined {
    const row = this.memory.findById<InstructorProfile>(INSTRUCTOR_PROFILES, userId);
    return row?.active ? row : undefined;
  }

  listActive(): InstructorProfile[] {
    return this.memory.findBy<InstructorProfile>(INSTRUCTOR_PROFILES, (p) => p.active);
  }

  private fromRow(row: Record<string, unknown>): InstructorProfile {
    const userId = Number(row.user_id);
    return {
      id: userId,
      userId,
      active: !!row.active,
      approvedBy: Number(row.approved_by),
      approvedAt: toIsoString(row.approved_at) as string,
      university: row.university == null ? null : String(row.university),
      major: row.major == null ? null : String(row.major),
      birthYear: row.birth_year == null ? null : Number(row.birth_year),
      defaultHourlyRate: Number(row.default_hourly_rate ?? 0),
      canTeachKinder: !!row.can_teach_kinder,
      createdAt: toIsoString(row.created_at) as string,
      updatedAt: toIsoString(row.updated_at) as string,
      deletedAt: (toIsoString(row.deleted_at) ?? null) as string | null,
      deletedBy: row.deleted_by == null ? null : Number(row.deleted_by),
    };
  }
}
