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
  email: string;
  role: StaffRole;
  status: AccountStatus;
  passwordHash: string;
  emailVerified: boolean;
  emailVerifyToken?: string;
  // [버그수정 2026-07-07] 강사 계정 ↔ 도메인 강사 id 링크.
  //  계정 id(users)와 도메인 강사 id(courses.instructorId·class_sessions.instructorId·payouts·availability owner)는
  //  별개 식별자다. 로그인 강사가 "본인 수업/시수"를 조회하려면 이 링크로 도메인 강사 id를 해석한다.
  //  role='instructor'일 때만 의미. (미링크 강사 계정은 도메인 강사와 미연결 — 데이터 정합 대상)
  instructorId?: number;
} & BaseRow;

// 외부 노출용(안전) 계정 뷰 — 해시·토큰 제외.
export type SafeAccount = Omit<StaffAccount, 'passwordHash' | 'emailVerifyToken'>;
export const toSafe = (a: StaffAccount): SafeAccount => {
  const { passwordHash: _ph, emailVerifyToken: _t, ...safe } = a;
  void _ph; void _t;
  return safe;
};

// (참고) contracts Account 형태로 변환이 필요할 때
export const toAccount = (a: SafeAccount): Account => ({ id: a.id, webId: a.webId, name: a.name, role: a.role });
