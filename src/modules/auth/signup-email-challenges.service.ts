// [TBO-31 C1 D1] 가입 전 이메일 OTP — **공개(비로그인) 흐름 전용** 서비스.
//  profile-verifications 자산은 requester_id NOT NULL FK·JWT·currentPassword 3중으로 비로그인
//  재사용이 구조적으로 불가(§0 실측) → 상수(TTL 10분·쿨다운 60초·시도/재전송 5회)·sha256 salted
//  hash·masked 응답 규약만 재사용하고 저장소는 signup_email_challenges로 분리한다.
//  평문 코드는 저장·로그·응답에 남기지 않는다(예외: 비production+SMTP 부재의 devOtpCode —
//  devVerifyLink 관례와 동일한 개발 편의. production은 부팅 가드가 SMTP를 강제해 분기 자체가 없다).
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import type { BaseRow } from '../../common/types/base';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { SIGNUP_EMAIL_CHALLENGES_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { USERS, type StaffAccount } from '../users/user.entity';
import { MailService } from '../mail/mail.service';
import {
  CHALLENGE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  maskTarget,
} from '../profile-verifications/profile-verification.entity';

export const SIGNUP_EMAIL_CHALLENGES = 'signup_email_challenges';

export type SignupEmailChallengeStatus = 'pending' | 'verified' | 'expired' | 'locked' | 'consumed';

export type SignupEmailChallenge = {
  /** email lowercase canonical — 응답에는 masked만 노출 */
  emailNormalized: string;
  /** salted sha256(코드 평문 미저장 — profile-verifications와 동일 salt 규약) */
  codeHash: string;
  status: SignupEmailChallengeStatus;
  attemptCount: number;
  resendCount: number;
  expiresAt: string;
  resendAvailableAt: string;
  verifiedAt?: string | null;
  consumedAt?: string | null;
  /** 가입 tx에서 소비될 때 생성된 users.id — 소비 추적 */
  consumedByUserId?: number | null;
} & BaseRow;

export type SignupEmailChallengeResponse = {
  id: number;
  maskedTarget: string;
  expiresAt: string;
  resendAvailableAt: string;
  /** 비production + SMTP 부재에서만 존재(devVerifyLink 관례) — production 응답에 절대 없음 */
  devOtpCode?: string;
};

// 코드 해시 salt는 profile-verifications와 동일 패턴(PROFILE_VERIFICATION_SALT || JWT_SECRET).
const hashSecret = (): string =>
  process.env.PROFILE_VERIFICATION_SALT || process.env.JWT_SECRET || 'dev-verification-salt';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const codeHashOf = (email: string, code: string): string => sha256(`signup:${email}:${code}:${hashSecret()}`);

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

// 실패 메시지 일반화 — challenge 존재/상태 열거 방지(profile-verifications GENERIC 규약과 동일).
const GENERIC_INVALID = '유효하지 않거나 만료된 인증입니다.';

@Injectable()
export class SignupEmailChallengesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly mail: MailService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC);
  }

  // ── 발송 ────────────────────────────────────────────────────────────────
  /**
   * challenge 생성 + OTP 발송.
   * · 재발송 규약(단순화 — 스펙 §2 D1 허용): 별도 resend 엔드포인트 없이, 같은 이메일의 기존
   *   pending은 **쿨다운(60초)만 지나면** 만료(supersede) 처리하고 새 코드를 발급한다.
   *   쿨다운 이전 재요청은 400(카운터는 DB 컬럼 영속 — process-local limit 아님).
   * · **이미 가입된 이메일도 응답은 동일하다(실제 메일 발송만 생략)** — 계정 열거 방지(H2 재발
   *   방지 규약). 이후 confirm→signup까지 가도 가입 시 이메일 중복 400으로 끝난다.
   */
  async create(rawEmail: string): Promise<SignupEmailChallengeResponse> {
    const email = this.normalizeEmail(rawEmail);
    const result = await this.uow.run(async () => {
      await this.refresh();
      const now = Date.now();
      const actives = this.db.findBy<SignupEmailChallenge>(
        SIGNUP_EMAIL_CHALLENGES,
        (c) => c.emailNormalized === email && c.status === 'pending',
      );
      const latest = actives[actives.length - 1];
      if (latest && Date.parse(latest.resendAvailableAt) > now) {
        throw new BadRequestException('인증 메일은 60초에 한 번만 요청할 수 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      // supersede — 같은 이메일 활성 pending은 대체 만료(새 코드만 유효).
      for (const active of actives) {
        await this.store.update<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, active.id, { status: 'expired' });
      }
      const registered = this.db.findBy<StaffAccount>(
        USERS,
        (a) => !!a.email && a.email.trim().toLowerCase() === email,
      ).length > 0;
      const code = String(randomInt(100000, 1000000));
      // 발송은 tx 안·insert 전 — 발송 실패(예외) 시 row +0. 가입된 이메일은 발송만 생략(열거 방지).
      //  MailService.sendOtpEmail은 SMTP 미설정 시 false(fail-closed) — 비production만 devOtpCode로
      //  대체(개발·e2e 편의), production은 부팅 가드(SMTP 필수)로 이 분기 자체가 없다.
      const sent = registered ? false : await this.mail.sendOtpEmail(email, code);
      const row = await this.store.insert<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, {
        emailNormalized: email,
        codeHash: codeHashOf(email, code),
        status: 'pending',
        attemptCount: 0,
        resendCount: 0,
        resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        verifiedAt: null,
        consumedAt: null,
        consumedByUserId: null,
      });
      return { row, devOtpCode: !sent && !isProduction() ? code : undefined };
    });
    return this.toResponse(result.row, result.devOtpCode);
  }

  // ── 확인 ────────────────────────────────────────────────────────────────
  /** 코드 확인 — sha256 대조·시도 5회 잠금·만료 판정. 실패 카운터는 예외보다 먼저 커밋한다. */
  async confirm(id: number, rawEmail: string, code: string): Promise<{ id: number; status: 'verified' }> {
    const email = this.normalizeEmail(rawEmail);
    const outcome = await this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'signupChallenge', id }]);
      await this.refresh();
      const challenge = this.db.findById<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES, id);
      // 이메일 불일치는 missing과 동일 취급 — challenge 존재 열거 방지(GENERIC).
      if (!challenge || challenge.emailNormalized !== email) return { kind: 'missing' as const };
      if (challenge.status !== 'pending') return { kind: 'invalid_state' as const };
      if (this.isExpired(challenge)) {
        await this.store.update<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, id, { status: 'expired' });
        return { kind: 'expired' as const };
      }
      if (challenge.codeHash !== codeHashOf(email, code)) {
        const attempts = challenge.attemptCount + 1;
        const locked = attempts >= MAX_ATTEMPTS;
        await this.store.update<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, id, {
          attemptCount: attempts,
          ...(locked ? { status: 'locked' as const } : {}),
        });
        return { kind: locked ? ('locked' as const) : ('wrong_code' as const) };
      }
      const verified = await this.store.updateIf<SignupEmailChallenge>(
        SIGNUP_EMAIL_CHALLENGES_SPEC,
        id,
        { status: 'pending' },
        { status: 'verified', verifiedAt: new Date().toISOString() },
      );
      if (!verified) return { kind: 'invalid_state' as const };
      return { kind: 'verified' as const };
    });

    switch (outcome.kind) {
      case 'verified':
        return { id, status: 'verified' };
      case 'locked':
        throw new BadRequestException('인증 시도 횟수를 초과했습니다. 처음부터 다시 요청해 주세요.');
      default:
        throw new BadRequestException(GENERIC_INVALID);
    }
  }

  // ── 소비(가입 tx 안에서만 호출) ─────────────────────────────────────────
  /**
   * verified challenge 일회 소비 — **반드시 UsersService.signup의 uow tx 안에서 호출된다**
   * (중첩 run은 같은 tx passthrough). 실패(미인증·이메일 불일치·만료·이중 소비) 시 예외 →
   * 계정 insert까지 전체 롤백(부분 상태 0). 성공 시 consumed + consumed_by_user_id 기록.
   */
  async consumeForSignup(id: number, email: string, createdUserId: number): Promise<SignupEmailChallenge> {
    await this.uow.lockTargets([{ kind: 'signupChallenge', id }]);
    await this.store.hydrate<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC);
    const challenge = this.db.findById<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES, id);
    if (!challenge || challenge.emailNormalized !== email) {
      throw new BadRequestException('가입 이메일의 인증이 필요합니다. 이메일 인증을 먼저 완료해 주세요.');
    }
    if (challenge.status !== 'verified' || this.isExpired(challenge)) {
      throw new BadRequestException('가입 이메일의 인증이 필요합니다. 이메일 인증을 먼저 완료해 주세요.');
    }
    const consumed = await this.store.updateIf<SignupEmailChallenge>(
      SIGNUP_EMAIL_CHALLENGES_SPEC,
      id,
      { status: 'verified' },
      { status: 'consumed', consumedAt: new Date().toISOString(), consumedByUserId: createdUserId },
    );
    if (!consumed) throw new BadRequestException(GENERIC_INVALID); // 동시 소비 — 한쪽만 성공
    return consumed;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────
  private normalizeEmail(raw: string): string {
    const email = raw.trim().toLowerCase();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException('올바른 이메일 주소가 아닙니다.');
    }
    return email;
  }

  private isExpired(challenge: SignupEmailChallenge): boolean {
    return Date.parse(challenge.expiresAt) <= Date.now();
  }

  private async refresh(): Promise<void> {
    // 가입 여부 판단(발송 생략)과 challenge 상태 모두 권위 DB 기준(교차 인스턴스 정합 — 28F 규약).
    await this.store.hydrate<StaffAccount>(USERS_SPEC);
    await this.store.hydrate<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC);
  }

  private toResponse(row: SignupEmailChallenge, devOtpCode?: string): SignupEmailChallengeResponse {
    return {
      id: row.id,
      maskedTarget: maskTarget('email', row.emailNormalized),
      expiresAt: row.expiresAt,
      resendAvailableAt: row.resendAvailableAt,
      ...(devOtpCode ? { devOtpCode } : {}),
    };
  }
}
