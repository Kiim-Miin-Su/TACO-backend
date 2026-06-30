import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { Account, AccountRole, WebIdCheckResult } from '@kms545487/contracts';

// 사내 담당자 전용 앱 — 로그인 가능한 역할은 직원만(학생/학부모 제외).
export type StaffRole = Extract<AccountRole, 'instructor' | 'manager' | 'admin' | 'super_admin'>;
const STAFF_ROLES: StaffRole[] = ['instructor', 'manager', 'admin', 'super_admin'];
export const isStaffRole = (r: string): r is StaffRole => STAFF_ROLES.includes(r as StaffRole);

export type AccountStatus = 'pending' | 'active' | 'rejected';

// 내부 계정 레코드(비밀번호 해시·상태·이메일 인증 포함). 외부로는 안전 필드만 노출.
type StaffAccount = {
  id: number;
  webId: string;
  name: string;
  email: string;
  role: StaffRole;
  status: AccountStatus;
  passwordHash: string;
  emailVerified: boolean;
  emailVerifyToken?: string;
  createdAt: string;
};

// 외부 노출용(안전) 계정 뷰 — 해시·토큰 제외.
export type SafeAccount = Omit<StaffAccount, 'passwordHash' | 'emailVerifyToken'>;
const toSafe = (a: StaffAccount): SafeAccount => {
  const { passwordHash: _ph, emailVerifyToken: _t, ...safe } = a;
  void _ph; void _t;
  return safe;
};

// 데모 시드 — 운영 계정(이미 활성·이메일 인증 완료). 비밀번호: 'demo1234'.
const DEMO_PW_HASH = bcrypt.hashSync('demo1234', 10);
const SEED: StaffAccount[] = [
  { id: 7, webId: 'admin', name: '김민수', email: 'admin@tnacademy.test', role: 'super_admin', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 8, webId: 'manager', name: '이지원', email: 'manager@tnacademy.test', role: 'manager', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 6, webId: 'park_inst', name: '박지훈', email: 'park@tnacademy.test', role: 'instructor', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
];

@Injectable()
export class UsersService {
  private accounts: StaffAccount[] = SEED.map((a) => ({ ...a }));
  private seq = 100;

  findAll(): SafeAccount[] {
    return this.accounts.map(toSafe);
  }

  findByWebId(webId: string): StaffAccount | undefined {
    const key = webId.trim().toLowerCase();
    return this.accounts.find((a) => a.webId.toLowerCase() === key);
  }

  findById(id: number): StaffAccount | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  // 가입 신청 — 직원 역할만 요청 가능(super_admin 자가신청 불가). 상태=pending, 이메일 미인증.
  async signup(input: { webId: string; name: string; email: string; password: string; role?: string }): Promise<{ account: SafeAccount; verifyToken: string }> {
    const webId = input.webId.trim();
    const email = input.email.trim().toLowerCase();
    const role: StaffRole = input.role && isStaffRole(input.role) && input.role !== 'super_admin' ? input.role : 'instructor';
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (this.accounts.some((a) => a.email.toLowerCase() === email)) throw new BadRequestException('이미 사용 중인 이메일입니다.');

    const passwordHash = await bcrypt.hash(input.password, 10);
    const verifyToken = randomBytes(24).toString('hex');
    const acc: StaffAccount = {
      id: ++this.seq, webId, name: input.name.trim(), email, role,
      status: 'pending', passwordHash, emailVerified: false, emailVerifyToken: verifyToken,
      createdAt: new Date().toISOString(),
    };
    this.accounts.push(acc);
    return { account: toSafe(acc), verifyToken };
  }

  verifyEmail(token: string): SafeAccount {
    const acc = this.accounts.find((a) => a.emailVerifyToken && a.emailVerifyToken === token);
    if (!acc) throw new BadRequestException('유효하지 않거나 만료된 인증 링크입니다.');
    acc.emailVerified = true;
    acc.emailVerifyToken = undefined;
    return toSafe(acc);
  }

  // 비밀번호 검증(로그인). 타이밍 안전 비교는 bcrypt.compare가 처리.
  async validatePassword(account: StaffAccount, password: string): Promise<boolean> {
    return bcrypt.compare(password, account.passwordHash);
  }

  listPending(): SafeAccount[] {
    return this.accounts.filter((a) => a.status === 'pending').map(toSafe);
  }

  // 대표(super_admin) 승인/반려. 승인 시 활성화(역할은 신청 역할 유지 또는 지정).
  setStatus(id: number, status: AccountStatus, role?: string): SafeAccount {
    const acc = this.findById(id);
    if (!acc) throw new BadRequestException(`계정 ${id} 없음`);
    acc.status = status;
    if (status === 'active' && role && isStaffRole(role)) acc.role = role;
    return toSafe(acc);
  }

  checkWebId(webId: string): WebIdCheckResult {
    const acc = this.findByWebId(webId);
    return acc ? { webId, exists: true, name: acc.name, role: acc.role } : { webId, exists: false };
  }
}

// (참고) contracts Account 형태로 변환이 필요할 때
export const toAccount = (a: SafeAccount): Account => ({ id: a.id, webId: a.webId, name: a.name, role: a.role });
