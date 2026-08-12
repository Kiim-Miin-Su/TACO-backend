// [참조/처리] 직원 계정(users) — InMemoryDatabase 컬렉션 'users'(dbml Table users와 정렬).
//  [자산화 점검 2026-07-02] 이전엔 UsersService가 계정을 서비스 로컬 배열에 보관해
//  가입 신청·승인 이력이 단일 DB(자산) 밖에 있었다 → 컬렉션으로 이관(전 도메인과 동일 패턴).
//  비밀번호 해시·인증 토큰은 이 레코드에만 있고 외부 응답은 SafeAccount(안전 필드)로 변환.
import type { BaseRow } from '../../common/types/base';
import type { Account, StaffAccountSummary } from '@kms545487/contracts';
import { isStaffRole, type AppRole } from '../auth/role-policy';
import { decryptRrn, maskRrn } from '../../common/rrn-crypto.util'; // [TBO-68 C3] rrnMaskedOf

export const USERS = 'users';

// 사내 담당자 전용 앱 — 로그인 가능한 역할은 직원만(학생/학부모 제외).
export type StaffRole = AppRole;
export { isStaffRole };

export type AccountStatus = 'pending' | 'active' | 'rejected';

// 내부 계정 레코드(비밀번호 해시·상태·이메일 인증 포함). id/createdAt/updatedAt = BaseRow.
export type StaffAccount = {
  webId: string;
  name: string;
  englishName: string;
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
  passwordResetTokenHash?: string | null; // [TBO-29C C5] 비밀번호 재설정 토큰(sha256만 저장·1h 만료)
  passwordResetExpiresAt?: string | null;
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
  // [E0.5 ④b 2026-07-15] 가입 폼 확장 — 지원자 제공 정보(승인 판단 근거: 승인센터 상세 표시).
  //  승인 tx에서 instructor_profiles로 승계(COALESCE)되고 이후 운영 권위는 프로필이다.
  university?: string | null; // 대학교(출신교)
  major?: string | null; // 전공
  birthYear?: number | null; // 출생연도(나이는 가변이라 연도로 보관 — instructor_profiles와 동일 규약)
  // [TBO-31 C1 D2] 주민등록번호 — AES-256-GCM 암호문만(rrn-crypto.util). 평문은 어떤 컬럼·로그·
  //  audit·응답에도 존재하지 않는다. birthYear는 이 값의 앞자리에서 파생 저장(기존 소비처 무파괴).
  //  외부 노출은 SafeAccount에서 제외 — 승인센터는 listPending의 rrnMasked(마스킹)만 본다.
  rrnEncrypted?: string | null;
  // [강사 식별자 통일 2026-07-07] 강사의 도메인 식별자 = users.id 자체(별도 instructorId 브리지 폐기).
  //  courses/class_sessions 등의 instructorId가 이 users.id를 직접 참조한다.
} & BaseRow;

// 외부 노출용(안전) 계정 뷰 — 해시·토큰(평문/해시/만료)·RRN 암호문 제외.
export type SafeAccount = Omit<StaffAccount, 'passwordHash' | 'emailVerifyTokenHash' | 'emailVerifyExpiresAt' | 'passwordResetTokenHash' | 'passwordResetExpiresAt' | 'rrnEncrypted'>;
/**
 * [TBO-79 E5] SafeAccount ↔ StaffAccountSummary **양방향** 일치 강제.
 *
 * 종전에는 `const contract: StaffAccountSummary = safe;` 한 줄이었다. 이건 SafeAccount가
 * 계약의 **초과집합**임만 증명한다 — 서버가 계약에 없는 필드를 실어 보내도 조용히 통과했고,
 * 실제로 authVersion·mustChangePassword·approvedBy·approvedAt·lastLoginAt·university·major·
 * birthYear 8개가 계약 밖으로 새고 있었다. 아래 단언은 초과와 누락을 **둘 다** 빌드 실패로
 * 만든다. 필드를 늘릴 땐 contracts/src/account.ts를 함께 고쳐야 컴파일된다.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _safeAccountMatchesContract: MutuallyAssignable<Required<SafeAccount>, Required<StaffAccountSummary>> = true;
void _safeAccountMatchesContract;

export const toSafe = (a: StaffAccount): SafeAccount => {
  const { passwordHash: _ph, emailVerifyTokenHash: _th, emailVerifyExpiresAt: _te, passwordResetTokenHash: _rt, passwordResetExpiresAt: _re, rrnEncrypted: _rrn, ...safe } = a;
  void _ph; void _th; void _te;
  return safe;
};

export const isActiveStaffAccount = (u: StaffAccount | undefined): u is StaffAccount =>
  !!u && u.status === 'active' && u.deletedAt == null;

/** [TBO-28B→TBO-87] 강사 role 전용 술어(가입 승인·역할 전환 내부용) — "가르치는 사람" 판정에는
 *  쓰지 않는다(겸직 누락). 노출/배정/정산 후보 산출은 isTeachingAccount를 쓴다. */
export const isActiveInstructor = (u: StaffAccount | undefined): u is StaffAccount =>
  !!u && u.role === 'instructor' && u.status === 'active' && u.deletedAt == null;

/** [TBO-87 겸직] "가르치는 사람" 중앙 술어 = 활성 계정 ∧ (role=instructor ∨ manager/admin 겸직 —
 *  활성 instructor_profiles 보유). activeTeachingProfileUserIds(db.findAll(INSTRUCTOR_PROFILES))로
 *  집합을 만들어 주입한다. 대표(super_admin)는 겸직 대상이 아니다(일정 owner 규칙만 별도). */
export const isTeachingAccount = (
  u: StaffAccount | undefined,
  activeProfileUserIds: ReadonlySet<number>,
): u is StaffAccount =>
  isActiveStaffAccount(u)
  && (u.role === 'instructor'
    || ((u.role === 'manager' || u.role === 'admin') && activeProfileUserIds.has(u.id)));

/** 캘린더 배정 대상: 가르치는 사람(겸직 포함) + 활성 대표. 대표는 일정 owner일 뿐 출결/정산 대상은 아니다. */
export const isActiveScheduleOwner = (
  u: StaffAccount | undefined,
  activeProfileUserIds: ReadonlySet<number>,
): u is StaffAccount =>
  isActiveStaffAccount(u) && (u.role === 'super_admin' || isTeachingAccount(u, activeProfileUserIds));

/** [TBO-87] JWT roles 클레임 합성 — 겸직(manager/admin+활성 원부)이면 'instructor'를 함께 발급해
 *  기존 capability 합성(resolveEffectiveCapabilities의 roles 합집합)·가드가 자동 적용되게 한다. */
export const claimRolesFor = (
  u: StaffAccount,
  activeProfileUserIds: ReadonlySet<number>,
): string[] =>
  u.role !== 'instructor' && isTeachingAccount(u, activeProfileUserIds)
    ? [u.role, 'instructor']
    : [u.role];

/** authVersion 규약 — 미설정(구 행)=1. */
export const authVersionOf = (u: Pick<StaffAccount, 'authVersion'>): number => u.authVersion ?? 1;
export const profileVersionOf = (u: Pick<StaffAccount, 'profileVersion'>): number => u.profileVersion ?? 1;

// (참고) contracts Account 형태로 변환이 필요할 때
export const toAccount = (a: SafeAccount): Account => ({ id: a.id, webId: a.webId, name: a.name, englishName: a.englishName, role: a.role });

/** [TBO-68 C3] RRN 마스킹 산출(서버 내부 복호화) — 승인 대기 목록·계정 상세(super_admin) 공유.
 *  복호 실패(키 교체·구 데이터)는 노출 대신 null(fail-closed). 평문·암호문은 어떤 응답에도 없다. */
export const rrnMaskedOf = (account: Pick<StaffAccount, 'rrnEncrypted'>): string | null => {
  if (!account.rrnEncrypted) return null;
  try {
    return maskRrn(decryptRrn(account.rrnEncrypted));
  } catch {
    return null;
  }
};
