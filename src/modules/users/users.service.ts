import { Injectable } from '@nestjs/common';
import type { Account, WebIdCheckResult } from '@kms545487/contracts';

// 사전 가입된 로그인 계정(데모 seed). 실제로는 users 테이블 조회.
const SEED: Account[] = [
  { id: 1, webId: 'sophia_kim', name: '김서연', role: 'student' },
  { id: 2, webId: 'daniel_lee', name: '이준호', role: 'student' },
  { id: 3, webId: 'emma_park', name: '박지민', role: 'student' },
  { id: 4, webId: 'mom_kim', name: '김미경', role: 'parent' },
  { id: 5, webId: 'dad_lee', name: '이상철', role: 'parent' },
  { id: 6, webId: 'park_inst', name: '박지훈', role: 'instructor' },
];

@Injectable()
export class UsersService {
  private accounts: Account[] = [...SEED];

  findAll(): Account[] {
    return this.accounts;
  }

  checkWebId(webId: string): WebIdCheckResult {
    const key = webId.trim().toLowerCase();
    const acc = this.accounts.find((a) => a.webId.toLowerCase() === key);
    return acc
      ? { webId, exists: true, name: acc.name, role: acc.role }
      : { webId, exists: false };
  }
}
