// [참조/처리] 직원 계정 서비스 — InMemoryDatabase 'users' 컬렉션(단일 자산) 기반.
//  가입(pending) → 이메일 인증 → 대표 승인(active) 라이프사이클의 모든 상태 변화가 db에 기록된다.
//  [자산화 점검 2026-07-02] 서비스 로컬 배열(this.accounts) → db.seed/insert/update 이관.
//  시드 계정은 고정 id(6·7·8)로 멱등 시드 — 이후 insert nextId와 충돌 없음.
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { WebIdCheckResult } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  USERS, isStaffRole, toSafe,
  type AccountStatus, type SafeAccount, type StaffAccount, type StaffRole,
} from './user.entity';

// 하위 호환 재노출(외부 소비처가 users.service 경유로 import하던 심볼)
export { isStaffRole, toAccount, toSafe } from './user.entity';
export type { AccountStatus, SafeAccount, StaffAccount, StaffRole } from './user.entity';

// 데모 시드 — 운영 계정(이미 활성·이메일 인증 완료). 비밀번호: 'demo1234'.
const DEMO_PW_HASH = bcrypt.hashSync('demo1234', 10);

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  onModuleInit(): void {
    this.db.seed<StaffAccount>(USERS, [
      { id: 6, webId: 'park_inst', name: '박지훈', email: 'park@tnacademy.test', role: 'instructor', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true },
      { id: 7, webId: 'admin', name: '김민수', email: 'admin@tnacademy.test', role: 'super_admin', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true },
      { id: 8, webId: 'manager', name: '이지원', email: 'manager@tnacademy.test', role: 'manager', status: 'active', passwordHash: DEMO_PW_HASH, emailVerified: true },
    ]);
  }

  findAll(): SafeAccount[] {
    return this.db.findAll<StaffAccount>(USERS).map(toSafe);
  }

  findByWebId(webId: string): StaffAccount | undefined {
    const key = webId.trim().toLowerCase();
    return this.db.findBy<StaffAccount>(USERS, (a) => a.webId.toLowerCase() === key)[0];
  }

  findById(id: number): StaffAccount | undefined {
    return this.db.findById<StaffAccount>(USERS, id);
  }

  // 가입 신청 — 직원 역할만 요청 가능(super_admin 자가신청 불가). 상태=pending, 이메일 미인증.
  async signup(input: { webId: string; name: string; email: string; password: string; role?: string }): Promise<{ account: SafeAccount; verifyToken: string }> {
    const webId = input.webId.trim();
    const email = input.email.trim().toLowerCase();
    const role: StaffRole = input.role && isStaffRole(input.role) && input.role !== 'super_admin' ? input.role : 'instructor';
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (this.db.findBy<StaffAccount>(USERS, (a) => a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');

    const passwordHash = await bcrypt.hash(input.password, 10);
    // [M1] await(hash) 사이에 동일 webId/email 가입이 끼어들 수 있음(TOCTOU) — insert 직전 동기 재검증
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (this.db.findBy<StaffAccount>(USERS, (a) => a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');
    const verifyToken = randomBytes(24).toString('hex');
    const acc = this.db.insert<StaffAccount>(USERS, {
      webId, name: input.name.trim(), email, role,
      status: 'pending', passwordHash, emailVerified: false, emailVerifyToken: verifyToken,
    });
    return { account: toSafe(acc), verifyToken };
  }

  verifyEmail(token: string): SafeAccount {
    const acc = this.db.findBy<StaffAccount>(USERS, (a) => !!a.emailVerifyToken && a.emailVerifyToken === token)[0];
    if (!acc) throw new BadRequestException('유효하지 않거나 만료된 인증 링크입니다.');
    const updated = this.db.update<StaffAccount>(USERS, acc.id, { emailVerified: true, emailVerifyToken: undefined }) as StaffAccount;
    return toSafe(updated);
  }

  // 비밀번호 검증(로그인). 타이밍 안전 비교는 bcrypt.compare가 처리.
  async validatePassword(account: StaffAccount, password: string): Promise<boolean> {
    return bcrypt.compare(password, account.passwordHash);
  }

  listPending(): SafeAccount[] {
    return this.db.findBy<StaffAccount>(USERS, (a) => a.status === 'pending').map(toSafe);
  }

  // 대표(super_admin) 승인/반려. 승인 시 활성화(역할은 신청 역할 유지 또는 지정).
  setStatus(id: number, status: AccountStatus, role?: string): SafeAccount {
    const acc = this.findById(id);
    if (!acc) throw new BadRequestException(`계정 ${id} 없음`);
    const patch: Partial<StaffAccount> = { status };
    if (status === 'active' && role && isStaffRole(role)) patch.role = role;
    return toSafe(this.db.update<StaffAccount>(USERS, id, patch) as StaffAccount);
  }

  checkWebId(webId: string): WebIdCheckResult {
    const acc = this.findByWebId(webId);
    return acc ? { webId, exists: true, name: acc.name, role: acc.role } : { webId, exists: false };
  }
}
