// [참조/처리] 직원 계정(users) — InMemoryDatabase 컬렉션 'users'(dbml Table users와 정렬).
//  [자산화 점검 2026-07-02] 이전엔 UsersService가 계정을 서비스 로컬 배열에 보관해
//  가입 신청·승인 이력이 단일 DB(자산) 밖에 있었다 → 컬렉션으로 이관(전 도메인과 동일 패턴).
//  비밀번호 해시·인증 토큰은 이 레코드에만 있고 외부 응답은 SafeAccount(안전 필드)로 변환.
import type { BaseRow } from '../../common/types/base';
import type { Account, AccountRole } from '@kms545487/contracts';

export const USERS = 'users';

// 사내 담당자 전용 앱 — 로그인 가능한 역할은 직원만(학생/학부모 제외).
export type StaffRole = Extract<AccountRole, 'instructor' | 'manager' | 'admin' | 'super_admin'>;
const STAFF_ROLES: StaffRole[] = ['instructor', 'manager', 'admin', 'super_admin'];
export const isStaffRole = (r: string): r is StaffRole => STAFF_ROLES.includes(r as StaffRole);

export type AccountStatus = 'pending' | 'active' | 'rejected';

// 내부 계정 레코드(비밀번호 해시·상태·이메일 인증 포함). id/createdAt/updatedAt = BaseRow.
export type StaffAccount = {
  webId: string;
  name: string;
  // [TBO-28B] nullable — 대표 직접 등록 강사는 이메일 없이 생성될 수 있다(운영 흐름 2026-07-14).
  //  self-signup 경로는 여전히 필수(SignupDto @IsEmail)·인증 게이트 유지.
  email?: string | null;
  role: StaffRole;
  status: AccountStatus;
  passwordHash: string;
  emailVerified: boolean;
  // [TBO-28B] 인증 토큰은 sha256 hash + 만료로만 저장. 인증 성공 시 두 컬럼 모두 **명시 null**
  //  (undefined는 toDbPayload가 skip → Postgres에 토큰 잔존했던 버그의 원인).
  emailVerifyTokenHash?: string | null;
  emailVerifyExpiresAt?: string | null;
  /** role/status/credential 변경 시 +1 — JWT claim과 대조해 구 토큰 즉시 무효화(AccountStateService). 미설정=1. */
  authVersion?: number;
  /** 프로필 변경 승인 CAS 버전. 승인된 변경마다 정확히 1 증가한다. */
  profileVersion: number;
  /** 임시 비밀번호 계정은 true. 변경 완료 전 업무 API는 RolesGuard가 차단한다. */
  mustChangePassword?: boolean;
  // [TBO-28A drift 해소 2026-07-14] 아래 4필드는 DDL(users)·dbml에 있었으나 entity에 없어
  //  런타임에서 읽기/쓰기가 불가능했다(승인 metadata 미기록의 원인). 28B가 값을 채운다.
  phone?: string | null;
  approvedBy?: number | null; // 승인한 대표(users.id). 승인 tx에서만 기록.
  approvedAt?: string | null; // ISO(timestamptz) — USERS_SPEC.timestampFields로 변환.
  lastLoginAt?: string | null; // 최신 로그인 성공 시각 summary(이력 진실원=auth_events).
  countryCode?: string | null; // 강사/직원 근무 국가. 캘린더 owner timezone resolver 입력.
  timeZone?: string | null; // IANA timezone override. 미지정 시 countryCode 대표 timezone 사용.
  // [강사 식별자 통일 2026-07-07] 강사의 도메인 식별자 = users.id 자체(별도 instructorId 브리지 폐기).
  //  courses/class_sessions 등의 instructorId가 이 users.id를 직접 참조한다.
} & BaseRow;

// 외부 노출용(안전) 계정 뷰 — 해시·토큰(평문/해시/만료) 제외.
export type SafeAccount = Omit<StaffAccount, 'passwordHash' | 'emailVerifyTokenHash' | 'emailVerifyExpiresAt'>;
export const toSafe = (a: StaffAccount): SafeAccount => {
  const { passwordHash: _ph, emailVerifyTokenHash: _th, emailVerifyExpiresAt: _te, ...safe } = a;
  void _ph; void _th; void _te;
  return safe;
};

/** [TBO-28B] 강사 노출/배정 중앙 술어 — role=instructor AND status=active AND 미삭제.
 *  /schedule/resources·세션 입력 검증 등 모든 강사 후보 산출이 이 함수 하나를 쓴다(pending/rejected 노출 차단). */
export const isActiveInstructor = (u: StaffAccount | undefined): u is StaffAccount =>
  !!u && u.role === 'instructor' && u.status === 'active' && u.deletedAt == null;

/** authVersion 규약 — 미설정(구 행)=1. */
export const authVersionOf = (u: Pick<StaffAccount, 'authVersion'>): number => u.authVersion ?? 1;
export const profileVersionOf = (u: Pick<StaffAccount, 'profileVersion'>): number => u.profileVersion ?? 1;

// (참고) contracts Account 형태로 변환이 필요할 때
export const toAccount = (a: SafeAccount): Account => ({ id: a.id, webId: a.webId, name: a.name, role: a.role });
