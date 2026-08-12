import type { PostgresCollectionSpec } from './postgres-collection.store';
import { CLASS_SESSION_SERIES_TABLE_SQL } from './migrations/class-session-series.migration';
import { SENS_PROVIDER_MIGRATION_SQL } from './migrations/sens-provider.migration';
import {
  PARENTS_TABLE_SQL,
  PARENT_STUDENT_RELATIONS_TABLE_SQL,
  PARENT_RELATION_INDEX_SQL,
  PARENT_FK_SQL,
} from './migrations/parents.migration';
import { ACADEMY_EVENTS_TABLE_SQL, ACADEMY_EVENTS_INDEX_SQL } from './migrations/academy-events.migration';
import { COUNTRIES_TABLE_SQL } from './migrations/countries.migration';
import {
  COUNSEL_ROUNDS_CANONICAL_TABLE_SQL,
  COUNSEL_PERSISTENCE_INDEX_SQL,
} from './migrations/counsel-persistence.migration';
import { COUNSEL_FORM_INPUTS_MIGRATION_SQL } from './migrations/counsel-form-inputs.migration';
import { COUNSEL_ROUND_SNAPSHOTS_RUNTIME_SQL } from './migrations/counsel-round-snapshots.migration';
import { COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL } from './migrations/counsel-next-contact-datetime.migration';
import {
  COUNSEL_FORMS_CANONICAL_TABLE_SQL,
  COUNSEL_STUDENT_SSOT_CONTRACT_SQL,
  STUDENTS_CANONICAL_TABLE_SQL,
} from './migrations/counsel-student-ssot-contract.migration';
import {
  ROADMAPS_TABLE_SQL,
  ROADMAP_COURSES_TABLE_SQL,
  REPORT_TEMPLATES_TABLE_SQL,
} from './migrations/remaining-persistence.migration';
import { STUDENT_INTERESTS_FK_SQL, STUDENT_INTERESTS_TABLE_SQL } from './migrations/student-profile.migration';
import { TBO36_COURSES_SQL } from './migrations/staff-pay-calendar.migration';
import { COURSE_PAY_SSOT_SQL } from './migrations/course-pay-ssot.migration';
import {
  COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL,
  STUDENT_ACADEMIC_HISTORIES_INDEX_SQL,
  STUDENT_ACADEMIC_HISTORIES_TABLE_SQL,
  STUDENT_FAMILY_RELATIONS_INDEX_SQL,
  STUDENT_FAMILY_RELATIONS_TABLE_SQL,
} from './migrations/counsel-family-academic-expand.migration';
import { PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_SQL, TRANSACTIONS_PAYMENT_FK_SQL } from './migrations/payments-money-constraints.migration';
import { AUTH_REFRESH_TOKEN_INTEGRITY_SQL } from './migrations/auth-refresh-token-integrity.migration';
import { INSTRUCTOR_CONTRACT_INTEGRITY_SQL } from './migrations/instructor-contract-integrity.migration';
import { INSTRUCTOR_CONTRACT_BOUNDS_SQL } from './migrations/instructor-contract-bounds.migration';
import { TRANSACTION_SOURCE_INTEGRITY_SQL } from './migrations/transaction-source-integrity.migration';
import { SOFTDELETE_UNIQUE_MIDNIGHT_SQL } from './migrations/softdelete-unique-midnight.migration';
import { STAFF_ENGLISH_NAME_MIGRATION_SQL } from './migrations/staff-english-name.migration';
import { REPORT_TEMPLATE_OWNER_MIGRATION_SQL } from './migrations/report-template-owner.migration';
import {
  REPORT_TEMPLATE_SCOPE_MIGRATION_SQL,
} from './migrations/report-template-scope.migration';
import {
  SESSION_REPORT_REVISIONS_SQL,
  SESSION_REPORT_REVISIONS_TABLE_SQL,
} from './migrations/session-report-revisions.migration';
import {
  STAFF_ATTENDANCE_INDEX_SQL,
  STAFF_ATTENDANCE_TABLE_SQL,
} from './migrations/staff-attendance.migration';
import {
  USER_CAPABILITY_OVERRIDES_INDEX_SQL,
  USER_CAPABILITY_OVERRIDES_TABLE_SQL,
} from './migrations/user-capability-overrides.migration';

const activeIndex = (table: string, name: string, columns: string): string =>
  `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns}) WHERE deleted_at IS NULL`;

export const USERS_SPEC: PostgresCollectionSpec = {
  table: 'users',
  createSql: `
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      web_id varchar(50) NOT NULL UNIQUE,
      name varchar(50) NOT NULL,
      english_name varchar(80) NOT NULL CHECK (
        char_length(english_name) BETWEEN 1 AND 80
        AND english_name=btrim(english_name)
        AND english_name ~ '^[A-Za-z][A-Za-z .''-]*$'
      ),
      email varchar(255) UNIQUE,
      phone varchar(20),
      role varchar(32) NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending',
      password_hash varchar(255) NOT NULL,
      email_verified boolean NOT NULL DEFAULT false,
      email_verify_token_hash varchar(64),
      email_verify_expires_at timestamptz,
      auth_version integer NOT NULL DEFAULT 1,
      profile_version integer NOT NULL DEFAULT 1,
      must_change_password boolean NOT NULL DEFAULT false,
      password_reset_token_hash varchar(64),
      password_reset_expires_at timestamptz,
      approved_by integer,
      approved_at timestamptz,
      last_login_at timestamptz,
      country_code varchar(8),
      time_zone varchar(64),
      university varchar(100),
      major varchar(100),
      birth_year integer,
      rrn_encrypted text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  // [TBO-28B] 기존(Neon) 테이블용 멱등 마이그레이션 — 신규 설치는 createSql이 이미 포함.
  //  email_verify_token(평문)은 v10에서 폐기: 쓰기 중단(hash 컬럼으로 대체), DROP은 후속 마이그레이션.
  migrations: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash varchar(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash varchar(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`,
    `ALTER TABLE users DROP COLUMN IF EXISTS email_verify_token`,
    // [E0.5 ④b 2026-07-15] 가입 폼 확장 — 지원자 제공(전화는 기존 phone 컬럼). 승인 tx에서
    //  instructor_profiles로 승계(COALESCE)되며 이후 운영 권위는 프로필 쪽이다(20260715_07과 SQL 공유).
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS university varchar(100)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS major varchar(100)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year integer`,
    // [TBO-31 C1 D2] 주민등록번호 — AES-256-GCM 암호문만 저장(평문·마스킹 저장 금지).
    //  birth_year는 RRN 앞자리 파생값으로 계속 채운다(승인센터·instructor_profiles 승계 무파괴).
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS rrn_encrypted text`,
    ...STAFF_ENGLISH_NAME_MIGRATION_SQL,
    // [TBO-86J] soft delete partial unique 잔여(email ci)·자정 CHECK — 표 부재 guard 포함(멱등).
    ...SOFTDELETE_UNIQUE_MIDNIGHT_SQL,
  ],
  indexes: [
    activeIndex('users', 'idx_users_role', 'role'),
    activeIndex('users', 'idx_users_status', 'status'),
  ],
  // [TBO-28A drift 해소] timestamptz 컬럼은 pg 드라이버가 Date로 돌려주므로 ISO string으로 통일.
  //  (createdAt/updatedAt/deletedAt은 store 기본 변환 — 그 외 timestamptz는 여기 선언 필수)
  timestampFields: ['approvedAt', 'lastLoginAt', 'emailVerifyExpiresAt'],
};

export const USER_CAPABILITY_OVERRIDES_SPEC: PostgresCollectionSpec = {
  table: 'user_capability_overrides',
  createSql: USER_CAPABILITY_OVERRIDES_TABLE_SQL,
  indexes: [...USER_CAPABILITY_OVERRIDES_INDEX_SQL],
};

export const PROFILE_CHANGE_REQUESTS_SPEC: PostgresCollectionSpec = {
  table: 'profile_change_requests',
  createSql: `
    CREATE TABLE IF NOT EXISTS profile_change_requests (
      id serial PRIMARY KEY,
      requester_id integer NOT NULL REFERENCES users(id),
      base_profile_version integer NOT NULL CHECK (base_profile_version >= 1),
      before_values jsonb NOT NULL,
      requested_changes jsonb NOT NULL,
      reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
      status varchar(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      decided_by integer REFERENCES users(id),
      decided_at timestamptz,
      rejection_reason text,
      applied_profile_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer REFERENCES users(id),
      verification_challenge_id integer,
      CONSTRAINT profile_change_requested_keys_check CHECK (
        jsonb_typeof(requested_changes) = 'object'
        AND requested_changes <> '{}'::jsonb
        AND requested_changes - ARRAY['name','englishName','phone','countryCode','timeZone','email','webId'] = '{}'::jsonb
      ),
      CONSTRAINT profile_change_decision_check CHECK (
        (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL
          AND rejection_reason IS NULL AND applied_profile_version IS NULL)
        OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
          AND rejection_reason IS NULL AND applied_profile_version = base_profile_version + 1)
        OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
          AND char_length(btrim(rejection_reason)) BETWEEN 5 AND 500 AND applied_profile_version IS NULL)
      )
    )
  `,
  // [TBO-29B-4] 기존 테이블용 멱등 마이그레이션 — 신규 설치는 createSql이 이미 포함.
  //  keys CHECK의 email 확장은 versioned migration(20260714_03)이 담당(DROP+ADD는 IF NOT EXISTS 불가).
  // [E0.5 ① 2026-07-15] '자기 결정 금지' DB 방어를 CHECK → 트리거로 교체 — CHECK는 users.role을 볼 수
  //  없어 super_admin 즉시 적용(본인 결정 예외)을 표현 못 한다. 트리거가 비-super_admin 자기 결정만 차단
  //  (서비스 403과 이중 방어 유지). PG-mode e2e가 23514로 검출했던 회귀의 해소(20260715_08과 SQL 공유).
  migrations: [
    `ALTER TABLE profile_change_requests ADD COLUMN IF NOT EXISTS verification_challenge_id integer`,
    `ALTER TABLE profile_change_requests DROP CONSTRAINT IF EXISTS profile_change_no_self_decision_check`,
    `CREATE OR REPLACE FUNCTION profile_change_self_decision_guard() RETURNS trigger AS $$
       BEGIN
         IF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.requester_id
            AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.requester_id AND role = 'super_admin') THEN
           RAISE EXCEPTION '본인의 프로필 변경 요청은 본인이 처리할 수 없습니다'
             USING ERRCODE = '23514', CONSTRAINT = 'profile_change_no_self_decision_check';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_profile_change_self_decision ON profile_change_requests`,
    `CREATE TRIGGER trg_profile_change_self_decision
       BEFORE INSERT OR UPDATE ON profile_change_requests
       FOR EACH ROW EXECUTE FUNCTION profile_change_self_decision_guard()`,
    // [E0 2026-07-15] keys CHECK에 webId 편입(아이디 변경 승인제) — DROP+ADD는 IF NOT EXISTS가
    //  없어 정의 검사 후 교체하는 멱등 DO 블록(20260715_09와 SQL 공유).
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'profile_change_requested_keys_check'
           AND pg_get_constraintdef(oid) NOT LIKE '%webId%'
       ) THEN
         ALTER TABLE profile_change_requests DROP CONSTRAINT profile_change_requested_keys_check;
         ALTER TABLE profile_change_requests ADD CONSTRAINT profile_change_requested_keys_check CHECK (
           jsonb_typeof(requested_changes) = 'object'
           AND requested_changes <> '{}'::jsonb
           AND requested_changes - ARRAY['name','phone','countryCode','timeZone','email','webId'] = '{}'::jsonb
         );
       END IF;
     END $$`,
  ],
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_change_requests_pending_requester
       ON profile_change_requests (requester_id) WHERE status = 'pending' AND deleted_at IS NULL`,
    activeIndex('profile_change_requests', 'idx_profile_change_requests_status', 'status'),
    activeIndex('profile_change_requests', 'idx_profile_change_requests_requester_id_desc', 'requester_id, id DESC'),
    activeIndex('profile_change_requests', 'idx_profile_change_requests_decided_by', 'decided_by'),
  ],
  jsonFields: ['beforeValues', 'requestedChanges'],
  timestampFields: ['decidedAt'],
};

// [TBO-29B-4] 연락처 재인증 challenge — requester/channel/canonical target 결합·일회 소비.
//  만료(10분)·실패 5회 잠금·재전송 cooldown(60초)을 **DB 컬럼으로 영속**(process-local limit 금지).
//  평문 코드·비밀번호·provider secret은 저장·로그 금지(email OTP는 salted sha256 hash만).
export const PROFILE_VERIFICATION_CHALLENGES_SPEC: PostgresCollectionSpec = {
  table: 'profile_verification_challenges',
  createSql: `
    CREATE TABLE IF NOT EXISTS profile_verification_challenges (
      id serial PRIMARY KEY,
      requester_id integer NOT NULL,
      channel varchar(16) NOT NULL CHECK (channel IN ('email','sms')),
      target_normalized varchar(320) NOT NULL,
      target_hash varchar(64) NOT NULL,
      provider varchar(32) NOT NULL CHECK (provider IN ('email_smtp','ncp_sens','twilio_verify','fake_test')),
      provider_reference varchar(128),
      code_hash varchar(128),
      status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','locked')),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
      resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 5),
      resend_available_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      verified_at timestamptz,
      consumed_at timestamptz,
      consumed_by_request_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer,
      CONSTRAINT profile_verification_expiry_check CHECK (expires_at > created_at),
      CONSTRAINT profile_verification_state_check CHECK (
        (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
        OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
        OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
        OR (status IN ('expired','locked'))
      )
    )
  `,
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_verification_active_requester_channel
       ON profile_verification_challenges (requester_id, channel)
       WHERE status IN ('pending','verified') AND deleted_at IS NULL`,
    activeIndex('profile_verification_challenges', 'idx_profile_verification_requester_status', 'requester_id, status'),
    activeIndex('profile_verification_challenges', 'idx_profile_verification_channel_target', 'channel, target_hash, status'),
    activeIndex('profile_verification_challenges', 'idx_profile_verification_expires_at', 'expires_at'),
    activeIndex('profile_verification_challenges', 'idx_profile_verification_consumed_by', 'consumed_by_request_id'),
  ],
  // [2026-07-15 SENS 전환] 기존 DB의 provider CHECK에 ncp_sens 허용(20260715_03과 SQL 공유 — 멱등 DO 블록).
  // [E0 2026-07-15] consumed의 consumed_by_request_id NOT NULL 강제 해제 — 비밀번호 변경(자격증명)
  //  소비는 프로필 요청 행이 없다(NULL = 자격증명 소비, NOT NULL = 프로필 요청 소비 — 20260715_10과 SQL 공유).
  migrations: [
    ...SENS_PROVIDER_MIGRATION_SQL,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'profile_verification_state_check'
           AND pg_get_constraintdef(oid) LIKE '%consumed_by_request_id IS NOT NULL%'
       ) THEN
         ALTER TABLE profile_verification_challenges DROP CONSTRAINT profile_verification_state_check;
         ALTER TABLE profile_verification_challenges ADD CONSTRAINT profile_verification_state_check CHECK (
           (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
           OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
           OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
           OR (status IN ('expired','locked'))
         );
       END IF;
     END $$`,
  ],
  timestampFields: ['resendAvailableAt', 'expiresAt', 'verifiedAt', 'consumedAt'],
};

// [TBO-31 C1 D1] 가입 전 이메일 OTP challenge — **공개(비로그인) 흐름 전용** 신규 테이블.
//  profile_verification_challenges의 requester_id NOT NULL FK를 nullable로 깨지 않기 위해 분리한다
//  (스펙 §2 D1). 상수(TTL 10분·쿨다운 60초·시도/재전송 5회)는 profile-verification.entity와 공유.
//  평문 코드는 저장·로그 금지 — salted sha256 hash만. 소비(consumed)는 가입 tx 안에서만 일어난다.
export const SIGNUP_EMAIL_CHALLENGES_SPEC: PostgresCollectionSpec = {
  table: 'signup_email_challenges',
  createSql: `
    CREATE TABLE IF NOT EXISTS signup_email_challenges (
      id serial PRIMARY KEY,
      email_normalized varchar(320) NOT NULL,
      purpose varchar(16) NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup','recovery')),
      code_hash varchar(64) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','locked','consumed')),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
      resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 5),
      expires_at timestamptz NOT NULL,
      resend_available_at timestamptz NOT NULL,
      verified_at timestamptz,
      consumed_at timestamptz,
      consumed_by_user_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer,
      CONSTRAINT signup_email_challenge_expiry_check CHECK (expires_at > created_at),
      CONSTRAINT signup_email_challenge_state_check CHECK (
        (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
        OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
        OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
        OR (status IN ('expired','locked'))
      )
    )
  `,
  indexes: [
    activeIndex('signup_email_challenges', 'idx_signup_email_challenges_email_status', 'email_normalized, status'),
    activeIndex('signup_email_challenges', 'idx_signup_email_challenges_expires_at', 'expires_at'),
  ],
  migrations: [
    // [TBO-31 C5 2026-07-20 D7] 복구(아이디·비밀번호 찾기) OTP 일반화 — 목적 태그.
    //  기본값 'signup'이라 기존 행 소급 무파괴. 코드 해시에 purpose 프리픽스가 들어가
    //  목적 간 교차 재생은 해시 수준에서도 차단된다(서비스 codeHashOf).
    `ALTER TABLE signup_email_challenges ADD COLUMN IF NOT EXISTS purpose varchar(16) NOT NULL DEFAULT 'signup'`,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'signup_email_challenge_purpose_check'
       ) THEN
         ALTER TABLE signup_email_challenges ADD CONSTRAINT signup_email_challenge_purpose_check
           CHECK (purpose IN ('signup','recovery'));
       END IF;
     END $$`,
    // [TBO-31 C5 D7] state CHECK 완화 — 복구 소비는 매칭 계정이 없어도 성립하므로 consumed에서
    //  consumed_by_user_id NOT NULL 강제를 제거(profile_verification_state_check 완화 전례와 동일 패턴).
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'signup_email_challenge_state_check'
           AND pg_get_constraintdef(oid) LIKE '%consumed_by_user_id IS NOT NULL%'
       ) THEN
         ALTER TABLE signup_email_challenges DROP CONSTRAINT signup_email_challenge_state_check;
         ALTER TABLE signup_email_challenges ADD CONSTRAINT signup_email_challenge_state_check CHECK (
           (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
           OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
           OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
           OR (status IN ('expired','locked'))
         );
       END IF;
     END $$`,
  ],
  timestampFields: ['expiresAt', 'resendAvailableAt', 'verifiedAt', 'consumedAt'],
};

// [TBO-57 2026-07-24] 가입 전 휴대전화 OTP challenge — signup_email_challenges 미러(공개 흐름
//  전용·분리 표). phone_normalized = E.164(libphonenumber KR 정규화 — profile-verifications 규약
//  동일). 평문 코드는 저장·로그·응답 금지(salted sha256 hash만, 예외: 비production+SMS provider
//  부재의 devOtpCode). 소비(consumed)는 가입 tx 안에서만 일어난다. Neon 적용은 migration
//  20260724_01 owner-paste(런북) — createSql은 비운영 런타임 멱등 전용.
export const SIGNUP_PHONE_CHALLENGES_SPEC: PostgresCollectionSpec = {
  table: 'signup_phone_challenges',
  createSql: `
    CREATE TABLE IF NOT EXISTS signup_phone_challenges (
      id serial PRIMARY KEY,
      phone_normalized varchar(20) NOT NULL,
      purpose varchar(16) NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup','recovery')),
      code_hash varchar(64) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','locked','consumed')),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
      resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 5),
      expires_at timestamptz NOT NULL,
      resend_available_at timestamptz NOT NULL,
      verified_at timestamptz,
      consumed_at timestamptz,
      consumed_by_user_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer,
      CONSTRAINT signup_phone_challenge_expiry_check CHECK (expires_at > created_at),
      CONSTRAINT signup_phone_challenge_state_check CHECK (
        (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
        OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
        OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
        OR (status IN ('expired','locked'))
      )
    )
  `,
  indexes: [
    activeIndex('signup_phone_challenges', 'idx_signup_phone_challenges_phone_status', 'phone_normalized, status'),
    activeIndex('signup_phone_challenges', 'idx_signup_phone_challenges_expires_at', 'expires_at'),
  ],
  timestampFields: ['expiresAt', 'resendAvailableAt', 'verifiedAt', 'consumedAt'],
};

// [TBO-28B] 인증 보안 이벤트(append-only) — 업무 audit_log와 분리(erd.dbml auth_events).
//  password/password_hash/JWT/refresh token/raw IP/DB URL 저장 금지(불변식 §5-3).
//  실패 로그인은 user_id 없이 attempted_web_id_hash만. update/remove 경로를 제공하지 않는다.
//  id는 런타임 id 규약(number) 통일을 위해 serial(int) 사용 — dbml bigint 표기는 v10에서 int로 정정.
export const AUTH_EVENTS_SPEC: PostgresCollectionSpec = {
  table: 'auth_events',
  createSql: `
    CREATE TABLE IF NOT EXISTS auth_events (
      id serial PRIMARY KEY,
      event_type varchar(32) NOT NULL,
      user_id integer,
      attempted_web_id_hash varchar(64),
      request_id varchar(64),
      ip_hash varchar(64),
      user_agent varchar(300),
      success boolean NOT NULL,
      failure_code varchar(40),
      at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  // [B10 E6 2026-07-16] Neon 정합 — 초기 owner-paste(20260714_01)의 inline CHECK가 3종
  //  (login_success/failure/logout)만 허용해, 이후 추가된 복구 3종(29C C5)·refresh_reuse_blocked
  //  (2026-07-16)이 Neon에서 CHECK 위반으로 실패할 잠재 결함(로컬 스펙 DDL엔 CHECK가 없어 e2e로
  //  못 잡음 — DATA_DICTIONARY 부록 A ⑦ 실측 발견). 이벤트 유형은 기능 추가마다 늘어나므로
  //  transactions.category와 동일하게 앱 계층 관리로 통일(CHECK 제거, 멱등).
  migrations: [
    `ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS auth_events_event_type_check`,
  ],
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_auth_events_user_at ON auth_events (user_id, at)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_events_type_at ON auth_events (event_type, at)`,
  ],
  timestampFields: ['at'],
  skipMemoryWhenDurable: true, // [EP4] append-only 로그 — durable 모드에서 메모리 상주 금지
};

// [대표 지시 ④ 2026-07-16] refresh token 저장 — **원문은 저장하지 않는다(sha256 hash만)**.
//  회전(rotation) 체인: 사용된 토큰은 revoked_at+replaced_by_id로 폐기 표시, 폐기 토큰 재사용은
//  유출 신호로 보고 사용자 전 토큰 무효화(auth_events 'refresh_reuse_blocked').
//  auth_version을 발급 시점에 동결 저장 — 비밀번호/아이디 변경(버전 증가) 시 기존 refresh도 즉시 무효.
// [B3 2026-07-16 대표 결정 ①] 알림 뱃지 읽음 — 사용자×탭별 마지막 열람 시각(서버 영속).
//  탭 진입 = 열람 마킹, 뱃지는 "마지막 열람 이후 새 활동"이 있을 때만 표시된다.
//  감사 제외: 이 행 자체가 열람 이력(고빈도 UI 상태 — audit_log 원칙의 명시 예외, dbml Note).
export const NAV_SEEN_SPEC: PostgresCollectionSpec = {
  table: 'nav_seen_states',
  createSql: `
    CREATE TABLE IF NOT EXISTS nav_seen_states (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      nav_key varchar(40) NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_seen_user_key ON nav_seen_states (user_id, nav_key) WHERE deleted_at IS NULL`,
  ],
  timestampFields: ['lastSeenAt'],
  skipMemoryWhenDurable: false, // 조회 빈도 높고 행 수 = 사용자×7 — 메모리 read model 유지
};

export const AUTH_REFRESH_TOKENS_SPEC: PostgresCollectionSpec = {
  table: 'auth_refresh_tokens',
  createSql: `
    CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      token_hash varchar(64) NOT NULL,
      auth_version integer NOT NULL DEFAULT 1,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      replaced_by_id integer,
      user_agent varchar(300),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  migrations: [...AUTH_REFRESH_TOKEN_INTEGRITY_SQL],
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_refresh_tokens_hash ON auth_refresh_tokens (token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user ON auth_refresh_tokens (user_id)`,
  ],
  timestampFields: ['expiresAt', 'revokedAt'],
  skipMemoryWhenDurable: true, // 조회는 PG 직행(findActive) — 메모리 사본 불요(EP4와 동일 근거)
};

export const STUDENTS_SPEC: PostgresCollectionSpec = {
  table: 'students',
  createSql: STUDENTS_CANONICAL_TABLE_SQL,
  migrations: [...COUNSEL_STUDENT_SSOT_CONTRACT_SQL.slice(-3)],
  indexes: [
    activeIndex('students', 'idx_students_status', 'status'),
    activeIndex('students', 'idx_students_country', 'country'),
  ],
  dateFields: ['birthDate'],
};

export const STUDENT_INTERESTS_SPEC: PostgresCollectionSpec = {
  table: 'student_interests',
  createSql: STUDENT_INTERESTS_TABLE_SQL,
  migrations: [STUDENT_INTERESTS_FK_SQL],
  indexes: [
    activeIndex('student_interests', 'idx_student_interests_student', 'student_id, priority'),
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_student_priority
       ON student_interests (student_id, priority) WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_course
       ON student_interests (student_id, course_id) WHERE deleted_at IS NULL AND course_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_custom
       ON student_interests (student_id, LOWER(BTRIM(custom_label)))
       WHERE deleted_at IS NULL AND custom_label IS NOT NULL`,
  ],
};

export const STUDENT_FAMILY_RELATIONS_SPEC: PostgresCollectionSpec = {
  table: 'student_family_relations',
  createSql: STUDENT_FAMILY_RELATIONS_TABLE_SQL,
  indexes: [...STUDENT_FAMILY_RELATIONS_INDEX_SQL],
};

export const STUDENT_ACADEMIC_HISTORIES_SPEC: PostgresCollectionSpec = {
  table: 'student_academic_histories',
  createSql: STUDENT_ACADEMIC_HISTORIES_TABLE_SQL,
  indexes: [...STUDENT_ACADEMIC_HISTORIES_INDEX_SQL],
  dateFields: ['startedOn', 'endedOn'],
  timestampFields: ['changedAt'],
};

// [TBO-29D D1] 보호자 + 학생↔보호자 관계 — 메모리 전용에서 Postgres 자산으로 승격(20260715_04와 SQL 공유).
//  활성 (parent,student) unique·학생당 대표 1명 partial unique를 DB가 강제. FK는 존재 확인 후 멱등 추가.
export const PARENTS_SPEC: PostgresCollectionSpec = {
  table: 'parents',
  createSql: PARENTS_TABLE_SQL,
};

export const PARENT_STUDENT_RELATIONS_SPEC: PostgresCollectionSpec = {
  table: 'parent_student_relations',
  createSql: PARENT_STUDENT_RELATIONS_TABLE_SQL,
  migrations: [PARENT_FK_SQL],
  indexes: [...PARENT_RELATION_INDEX_SQL],
};

// [TBO-29D 요구 ⑤⑥] 학원 공통 이벤트 — 전 직원 조회·매니저 이상 CUD. 캘린더 전체 뷰 표시의 권위 저장소.
//  date 컬럼은 dateFields로 'YYYY-MM-DD' 문자열 복원(PG Date 객체 hydrate 함정 — §13.83 학습 재적용).
export const ACADEMY_EVENTS_SPEC: PostgresCollectionSpec = {
  table: 'academy_events',
  createSql: ACADEMY_EVENTS_TABLE_SQL,
  indexes: [...ACADEMY_EVENTS_INDEX_SQL],
  dateFields: ['startDate', 'endDate'],
};

// [E0.5 ④] 국가·시간대 카탈로그 — **참조 데이터**(test fixture 관문 비대상, seedReference 경유).
//  profile countryCode/timeZone 자유 입력 폐지의 권위: FE 토글 옵션·BE 검증이 이 표를 본다(20260715_06과 SQL 공유).
export const COUNTRIES_SPEC: PostgresCollectionSpec = {
  table: 'countries',
  createSql: COUNTRIES_TABLE_SQL,
};

export const SUBJECTS_SPEC: PostgresCollectionSpec = {
  table: 'subjects',
  createSql: `
    CREATE TABLE IF NOT EXISTS subjects (
      id serial PRIMARY KEY,
      code varchar(50) NOT NULL UNIQUE,
      name varchar(50) NOT NULL,
      description text,
      color varchar(9),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  // [TBO-86J] code 전체 UNIQUE → 활성 한정 partial unique(+users email·sessions CHECK 동반, guard 멱등).
  migrations: [...SOFTDELETE_UNIQUE_MIDNIGHT_SQL],
};

export const COURSES_SPEC: PostgresCollectionSpec = {
  table: 'courses',
  createSql: `
    CREATE TABLE IF NOT EXISTS courses (
      id serial PRIMARY KEY,
      code integer UNIQUE,
      instructor_id integer,
      subject_id integer,
      name varchar(100) NOT NULL,
      description text,
      price integer NOT NULL DEFAULT 0,
      hourly_rate_override integer,
      is_kinder boolean NOT NULL DEFAULT false,
      default_session_count integer,
      default_duration_minutes integer,
      status varchar(32) NOT NULL DEFAULT 'active',
      color varchar(32),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  migrations: [...TBO36_COURSES_SQL, ...COURSE_PAY_SSOT_SQL],
  indexes: [
    activeIndex('courses', 'idx_courses_subject', 'subject_id'),
    activeIndex('courses', 'idx_courses_instructor', 'instructor_id'),
  ],
};

export const ROADMAPS_SPEC: PostgresCollectionSpec = {
  table: 'roadmaps',
  createSql: ROADMAPS_TABLE_SQL,
  indexes: [activeIndex('roadmaps', 'idx_roadmaps_active', 'is_active')],
};

export const ROADMAP_COURSES_SPEC: PostgresCollectionSpec = {
  table: 'roadmap_courses',
  createSql: ROADMAP_COURSES_TABLE_SQL,
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_roadmap_courses_active
       ON roadmap_courses (roadmap_id, course_id) WHERE deleted_at IS NULL`,
    activeIndex('roadmap_courses', 'idx_roadmap_courses_roadmap', 'roadmap_id, sort_order'),
  ],
};

export const REPORT_TEMPLATES_SPEC: PostgresCollectionSpec = {
  table: 'report_templates',
  createSql: REPORT_TEMPLATES_TABLE_SQL,
  migrations: [...REPORT_TEMPLATE_OWNER_MIGRATION_SQL, ...REPORT_TEMPLATE_SCOPE_MIGRATION_SQL],
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_report_templates_owner_active
       ON report_templates (owner_user_id, id) WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_scope_name
       ON report_templates (COALESCE(owner_user_id, 0), name) WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_scope_default
       ON report_templates (COALESCE(owner_user_id, 0)) WHERE deleted_at IS NULL AND is_default`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_global_enforced
       ON report_templates (is_enforced)
       WHERE deleted_at IS NULL AND owner_user_id IS NULL AND is_enforced`,
  ],
};

// [TBO-33 C1] 상담은 서비스 MVP에서 재기동 유실이 허용되지 않는 운영 자산이다.
//  기존 contract의 상태값을 보존한 채 forms → rounds 순으로 hydrate/write-through한다.
export const COUNSEL_FORMS_SPEC: PostgresCollectionSpec = {
  table: 'counsel_forms',
  createSql: COUNSEL_FORMS_CANONICAL_TABLE_SQL,
  migrations: [
    ...COUNSEL_FORM_INPUTS_MIGRATION_SQL,
    COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL[0],
    ...COUNSEL_STUDENT_SSOT_CONTRACT_SQL.slice(0, -3),
    ...COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL.slice(0, 1),
  ],
  indexes: COUNSEL_PERSISTENCE_INDEX_SQL.slice(0, 3),
  timestampFields: ['nextContactAt'],
};

export const COUNSEL_ROUNDS_SPEC: PostgresCollectionSpec = {
  table: 'counsel_rounds',
  createSql: COUNSEL_ROUNDS_CANONICAL_TABLE_SQL,
  migrations: [
    ...COUNSEL_ROUND_SNAPSHOTS_RUNTIME_SQL,
    ...COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL.slice(1),
  ],
  indexes: COUNSEL_PERSISTENCE_INDEX_SQL.slice(4),
  jsonFields: ['formSnapshot'],
  dateFields: ['scheduledAt', 'completedAt'],
  timestampFields: ['nextContactAt'],
};

export const ROOMS_SPEC: PostgresCollectionSpec = {
  table: 'rooms',
  createSql: `
    CREATE TABLE IF NOT EXISTS rooms (
      id serial PRIMARY KEY,
      name varchar(100) NOT NULL,
      building_id integer,
      capacity integer,
      color varchar(32),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
};

export const ENROLLMENTS_SPEC: PostgresCollectionSpec = {
  table: 'enrollments',
  createSql: `
    CREATE TABLE IF NOT EXISTS enrollments (
      id serial PRIMARY KEY,
      student_id integer NOT NULL,
      course_id integer NOT NULL,
      counsel_card_id integer,
      instructor_id integer,
      roadmap_id integer,
      status varchar(32) NOT NULL DEFAULT 'active',
      start_date date,
      end_date date,
      total_sessions integer,
      completed_sessions integer NOT NULL DEFAULT 0,
      memo text,
      enrolled_at date NOT NULL DEFAULT CURRENT_DATE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['enrolledAt', 'startDate', 'endDate'],
  indexes: [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollments_student_course_active
       ON enrollments (student_id, course_id) WHERE deleted_at IS NULL`,
    activeIndex('enrollments', 'idx_enrollments_course_status', 'course_id, status'),
    activeIndex('enrollments', 'idx_enrollments_student_status', 'student_id, status'),
  ],
};

// [TBO-29C C2] 반복 시리즈 자산 — DDL/backfill/FK 원문은 migrations/class-session-series.migration.ts가
//  단일 소스(Neon versioned migration과 런타임 spec이 같은 SQL을 공유). FK 승격/backfill은 ClassSessionsStore가
//  class_sessions 생성 직후 실행한다(테이블 생성 순서 결정성).
export const CLASS_SESSION_SERIES_SPEC: PostgresCollectionSpec = {
  table: 'class_session_series',
  createSql: CLASS_SESSION_SERIES_TABLE_SQL,
  jsonFields: ['weekdays'],
  dateFields: ['startsOn', 'endsOn'],
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_session_series_range ON class_session_series (starts_on, ends_on) WHERE deleted_at IS NULL',
  ],
};

export const AVAILABILITY_SPEC: PostgresCollectionSpec = {
  table: 'availability_blocks',
  createSql: `
    CREATE TABLE IF NOT EXISTS availability_blocks (
      id serial PRIMARY KEY,
      owner_type varchar(32) NOT NULL,
      owner_id integer NOT NULL,
      kind varchar(32) NOT NULL DEFAULT 'available',
      weekday integer NOT NULL,
      start_time varchar(5) NOT NULL,
      end_time varchar(5) NOT NULL,
      effective_from date,
      effective_to date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['effectiveFrom', 'effectiveTo'],
  indexes: [
    activeIndex('availability_blocks', 'idx_avail_owner_weekday', 'owner_type, owner_id, weekday'),
  ],
};

export const VIEW_PRESETS_SPEC: PostgresCollectionSpec = {
  table: 'calendar_view_presets',
  createSql: `
    CREATE TABLE IF NOT EXISTS calendar_view_presets (
      id serial PRIMARY KEY,
      name varchar(40) NOT NULL,
      view varchar(16) NOT NULL DEFAULT 'week',
      period_from date,
      period_to date,
      instructor_ids text NOT NULL DEFAULT '[]',
      student_ids text NOT NULL DEFAULT '[]',
      room_ids text NOT NULL DEFAULT '[]',
      subjects text NOT NULL DEFAULT '[]',
      statuses text NOT NULL DEFAULT '[]',
      kinds text NOT NULL DEFAULT '[]',
      group_only boolean NOT NULL DEFAULT false,
      q varchar(100),
      color_by varchar(16),
      country_code varchar(8),
      pane_country_instructor varchar(8),
      pane_country_student varchar(8),
      mode_filters text NOT NULL DEFAULT '[]',
      kst_fixed boolean NOT NULL DEFAULT true,
      compact_cols boolean NOT NULL DEFAULT false,
      manual_panes text NOT NULL DEFAULT '[]',
      created_by integer, -- [TBO-58 P2] 소유자(IDOR 가드) — NULL=레거시 공용(매니저 이상만 수정/삭제)
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['instructorIds', 'studentIds', 'roomIds', 'subjects', 'statuses', 'kinds', 'modeFilters', 'manualPanes'],
  dateFields: ['periodFrom', 'periodTo'],
  migrations: [
    // [TBO-58 P2] 기존 dev 표 자가 치유 — 운영은 versioned migration(owner-paste, RUNBOOK) 경로
    'ALTER TABLE calendar_view_presets ADD COLUMN IF NOT EXISTS created_by integer',
  ],
  indexes: [
    'ALTER TABLE calendar_view_presets DROP CONSTRAINT IF EXISTS calendar_view_presets_name_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_view_presets_active_name ON calendar_view_presets (name) WHERE deleted_at IS NULL',
  ],
};

export const AUDIT_LOG_SPEC: PostgresCollectionSpec = {
  table: 'audit_log',
  createSql: `
    CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY,
      entity varchar(50) NOT NULL,
      entity_id integer NOT NULL,
      action varchar(32) NOT NULL,
      actor_id integer NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      changes text,
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['changes'],
  timestampFields: ['at'],
  indexes: [
    activeIndex('audit_log', 'idx_audit_entity_id', 'entity, entity_id'),
    activeIndex('audit_log', 'idx_audit_actor_id', 'actor_id'),
    activeIndex('audit_log', 'idx_audit_at', 'at'),
    activeIndex('audit_log', 'idx_audit_entity_id_desc', 'entity, entity_id, id DESC'),
    activeIndex('audit_log', 'idx_audit_actor_id_desc', 'actor_id, id DESC'),
  ],
  skipMemoryWhenDurable: true, // [EP4] append-only 이력 — durable 모드에서 메모리 상주 금지(조회는 PG 직행)
};

export const ATTENDANCE_SPEC: PostgresCollectionSpec = {
  table: 'attendance',
  createSql: `
    CREATE TABLE IF NOT EXISTS attendance (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      student_id integer NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'present',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_session_student ON attendance (session_id, student_id) WHERE deleted_at IS NULL',
    activeIndex('attendance', 'idx_attendance_session', 'session_id'),
    activeIndex('attendance', 'idx_attendance_student', 'student_id'),
  ],
};

export const SESSION_REPORTS_SPEC: PostgresCollectionSpec = {
  table: 'session_reports',
  createSql: `
    CREATE TABLE IF NOT EXISTS session_reports (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      student_id integer NOT NULL,
      subject_id integer,
      instructor_id integer NOT NULL,
      content text NOT NULL,
      progress_page text,
      homework text,
      status varchar(32) NOT NULL DEFAULT 'draft',
      approval_status varchar(32) NOT NULL DEFAULT 'draft',
      submitted_at timestamptz,
      approved_by integer,
      approved_at timestamptz,
      rejected_reason text,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  timestampFields: ['submittedAt', 'approvedAt'],
  migrations: [
    'ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS progress_page text',
    ...SESSION_REPORT_REVISIONS_SQL.slice(0, 4),
  ],
  indexes: [
    "ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS approval_status varchar(32) NOT NULL DEFAULT 'draft'",
    `UPDATE session_reports
        SET approval_status = CASE WHEN status IN ('approved', 'rejected') THEN status WHEN status = 'submitted' THEN 'submitted' ELSE approval_status END,
            status = CASE WHEN status = 'approved' THEN 'sent' WHEN status = 'rejected' THEN 'draft' ELSE status END,
            approved_at = CASE WHEN status = 'approved' THEN COALESCE(approved_at, updated_at, now()) ELSE approved_at END,
            rejected_reason = CASE WHEN status = 'rejected' THEN COALESCE(NULLIF(btrim(rejected_reason), ''), '사유 미기재') ELSE rejected_reason END
      WHERE status IN ('approved', 'rejected') OR (status = 'submitted' AND approval_status = 'draft')`,
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_session_reports_session_student ON session_reports (session_id, student_id) WHERE deleted_at IS NULL',
    activeIndex('session_reports', 'idx_reports_session', 'session_id'),
    activeIndex('session_reports', 'idx_reports_instructor_status', 'instructor_id, status'),
    activeIndex('session_reports', 'idx_reports_instructor_approval', 'instructor_id, approval_status'),
  ],
};

export const SESSION_REPORT_REVISIONS_SPEC: PostgresCollectionSpec = {
  table: 'session_report_revisions',
  createSql: SESSION_REPORT_REVISIONS_TABLE_SQL,
  indexes: [...SESSION_REPORT_REVISIONS_SQL.slice(5)],
  timestampFields: ['createdAt'],
  skipMemoryWhenDurable: true,
};

export const STAFF_ATTENDANCE_SPEC: PostgresCollectionSpec = {
  table: 'staff_attendance_records',
  createSql: STAFF_ATTENDANCE_TABLE_SQL,
  dateFields: ['workDate'],
  timestampFields: ['checkInAt', 'checkOutAt'],
  indexes: [...STAFF_ATTENDANCE_INDEX_SQL],
};

export const INSTRUCTOR_CONTRACTS_SPEC: PostgresCollectionSpec = {
  table: 'instructor_contracts',
  createSql: `
    CREATE TABLE IF NOT EXISTS instructor_contracts (
      id serial PRIMARY KEY,
      instructor_id integer NOT NULL,
      monthly_hours integer NOT NULL,
      hourly_rate integer NOT NULL,
      period_start date NOT NULL,
      period_end date,
      active boolean NOT NULL DEFAULT true,
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['periodStart', 'periodEnd'],
  migrations: [...INSTRUCTOR_CONTRACT_INTEGRITY_SQL, ...INSTRUCTOR_CONTRACT_BOUNDS_SQL],
  indexes: [
    activeIndex('instructor_contracts', 'idx_instructor_contracts_instructor_active', 'instructor_id, active'),
    activeIndex('instructor_contracts', 'idx_instructor_contracts_period', 'period_start, period_end'),
  ],
};

export const PAYMENTS_SPEC: PostgresCollectionSpec = {
  table: 'payments',
  createSql: `
    CREATE TABLE IF NOT EXISTS payments (
      id serial PRIMARY KEY,
      enrollment_id integer,
      student_id integer NOT NULL,
      payer_parent_id integer,
      amount integer NOT NULL,
      paid_amount integer NOT NULL DEFAULT 0,
      due_at date,
      paid_at timestamptz,
      status varchar(32) NOT NULL DEFAULT 'pending',
      payment_method varchar(32),
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['dueAt'],
  timestampFields: ['paidAt'],
  // [TBO-53 C1] FK/CHECK — 참조·금액·상태를 DB가 강제(앱 lock+CAS의 최후 방어선).
  //  운영(Neon) 적용 권위는 migration ledger(20260723_01) — 여기서는 비운영 환경 멱등 반영.
  migrations: [...PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_SQL, TRANSACTIONS_PAYMENT_FK_SQL],
  indexes: [
    activeIndex('payments', 'idx_payments_status', 'status'),
    activeIndex('payments', 'idx_payments_student', 'student_id'),
    activeIndex('payments', 'idx_payments_enrollment', 'enrollment_id'),
  ],
};

export const EXPENSES_SPEC: PostgresCollectionSpec = {
  table: 'expenses',
  createSql: `
    CREATE TABLE IF NOT EXISTS expenses (
      id serial PRIMARY KEY,
      category varchar(32) NOT NULL DEFAULT 'supplies',
      title varchar(200) NOT NULL,
      amount integer NOT NULL,
      spent_at date NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'requested',
      paid_by integer,
      payment_method varchar(32),
      vendor varchar(200),
      receipt_url varchar(255),
      memo text,
      rejected_reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['spentAt'],
  indexes: [
    activeIndex('expenses', 'idx_expenses_status', 'status'),
    activeIndex('expenses', 'idx_expenses_spent_at', 'spent_at'),
  ],
};

export const TRANSACTIONS_SPEC: PostgresCollectionSpec = {
  table: 'transactions',
  createSql: `
    CREATE TABLE IF NOT EXISTS transactions (
      id serial PRIMARY KEY,
      direction varchar(16) NOT NULL,
      category varchar(64) NOT NULL,
      label varchar(200) NOT NULL,
      amount integer NOT NULL,
      method varchar(32),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      payment_id integer,
      payout_id integer,
      expense_id integer,
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  timestampFields: ['occurredAt'],
  migrations: [TRANSACTIONS_PAYMENT_FK_SQL, ...TRANSACTION_SOURCE_INTEGRITY_SQL],
  indexes: [
    activeIndex('transactions', 'idx_tx_dir_occurred', 'direction, occurred_at'),
    activeIndex('transactions', 'idx_tx_category', 'category'),
    activeIndex('transactions', 'idx_tx_occurred', 'occurred_at'),
    activeIndex('transactions', 'idx_tx_payment', 'payment_id'),
    activeIndex('transactions', 'idx_tx_payout', 'payout_id'),
    activeIndex('transactions', 'idx_tx_expense', 'expense_id'),
  ],
};

export const INSTRUCTOR_PAYOUTS_SPEC: PostgresCollectionSpec = {
  table: 'instructor_payouts',
  createSql: `
    CREATE TABLE IF NOT EXISTS instructor_payouts (
      id serial PRIMARY KEY,
      instructor_id integer NOT NULL,
      period_start date NOT NULL,
      period_end date NOT NULL,
      session_count integer NOT NULL DEFAULT 0,
      total_minutes integer NOT NULL DEFAULT 0,
      computed_amount integer NOT NULL DEFAULT 0,
      adjusted_amount integer,
      adjust_reason varchar(200),
      amount integer NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending',
      lines text NOT NULL DEFAULT '[]',
      rejected_reason varchar(200),
      confirmed_at timestamptz,
      paid_at timestamptz,
      reversed_at timestamptz,
      reversed_reason varchar(200),
      payment_method varchar(32),
      bank_account varchar(80),
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['lines'],
  dateFields: ['periodStart', 'periodEnd'],
  timestampFields: ['confirmedAt', 'paidAt', 'reversedAt'],
  // [B9 E5] 기존 DB 승격 — 지급 회수 시각(additive, 멱등)
  migrations: [
    'ALTER TABLE instructor_payouts ADD COLUMN IF NOT EXISTS reversed_at timestamptz',
    // [TBO-32 C2 2026-07-22 D2] 회수 사유 전용 컬럼 — 반려 사유(rejected_reason)와 분리 영속
    //  (상세 화면 노출·이력 구분). reverse는 호환 위해 둘 다 기록한다.
    'ALTER TABLE instructor_payouts ADD COLUMN IF NOT EXISTS reversed_reason varchar(200)',
  ],
  indexes: [
    activeIndex('instructor_payouts', 'idx_payouts_instructor_period', 'instructor_id, period_start, period_end'),
    activeIndex('instructor_payouts', 'idx_payouts_status', 'status'),
  ],
};
