import { TimedModuleInit } from '../../common/performance-timing';
// [TBO-31 C1 D1] 가입 전 이메일 OTP — **공개(비로그인) 흐름 전용** 서비스.
//  profile-verifications 자산은 requester_id NOT NULL FK·JWT·currentPassword 3중으로 비로그인
//  재사용이 구조적으로 불가(§0 실측) → 상수(TTL 10분·쿨다운 60초·시도/재전송 5회)·sha256 salted
//  hash·masked 응답 규약만 재사용하고 저장소는 signup_email_challenges로 분리한다.
//  평문 코드는 저장·로그·응답에 남기지 않는다(예외: 비production+SMTP 부재의 devOtpCode —
//  devVerifyLink 관례와 동일한 개발 편의. production은 부팅 가드가 SMTP를 강제해 분기 자체가 없다).
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원
import { createHash, randomInt } from 'crypto';
import type { BaseRow } from '../../common/types/base';
import { logLine } from '../../common/log-line';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { SIGNUP_EMAIL_CHALLENGES_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import type { StaffAccount } from '../users/user.entity';
import { MailService } from '../mail/mail.service';
import { SignupContactAvailabilityService } from './signup-contact-availability.service';
import {
  CHALLENGE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  maskTarget,
} from '../profile-verifications/profile-verification.entity';

export const SIGNUP_EMAIL_CHALLENGES = 'signup_email_challenges';

export type SignupEmailChallengeStatus = 'pending' | 'verified' | 'expired' | 'locked' | 'consumed';

// [TBO-31 C5 D7] 목적 태그 — signup(가입 전 인증) | recovery(비로그인 아이디·비밀번호 찾기).
//  발송/확인/소비 전 단계가 purpose를 대조하므로 목적 간 challenge 교차 사용이 불가하고,
//  코드 해시에도 purpose가 들어가 코드 자체의 교차 재생도 차단된다(D7).
export type EmailChallengePurpose = 'signup' | 'recovery';

export type SignupEmailChallenge = {
  /** email lowercase canonical — 응답에는 masked만 노출 */
  emailNormalized: string;
  /** [TBO-31 C5] 발급 목적 — 확인·소비 시 반드시 일치해야 한다 */
  purpose: EmailChallengePurpose;
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
const codeHashOf = (purpose: EmailChallengePurpose, email: string, code: string): string =>
  sha256(`${purpose}:${email}:${code}:${hashSecret()}`);


// 실패 메시지 일반화 — challenge 존재/상태 열거 방지(profile-verifications GENERIC 규약과 동일).
const GENERIC_INVALID = '유효하지 않거나 만료된 인증입니다.';

@TimedModuleInit()
@Injectable()
export class SignupEmailChallengesService implements OnModuleInit {
  private readonly logger = new Logger(SignupEmailChallengesService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly mail: MailService,
    private readonly contacts: SignupContactAvailabilityService,
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
   * · signup 목적은 발송 전에 users 권위 DB를 조회하고 이미 가입된 이메일이면 409로 중단한다.
   *   recovery 목적은 계정 열거 방지를 위해 기존과 같이 가입 여부와 무관하게 동일하게 처리한다.
   */
  async create(rawEmail: string, purpose: EmailChallengePurpose = 'signup'): Promise<SignupEmailChallengeResponse> {
    const email = this.contacts.normalize('email', rawEmail);
    const result = await this.uow.run(async () => {
      await this.refresh();
      if (purpose === 'signup') this.contacts.assertAvailableInCurrentProjection('email', email);
      const now = Date.now();
      const actives = this.db.findBy<SignupEmailChallenge>(
        SIGNUP_EMAIL_CHALLENGES,
        (c) => c.emailNormalized === email && (c.purpose ?? 'signup') === purpose && c.status === 'pending',
      );
      const latest = actives[actives.length - 1];
      if (latest && Date.parse(latest.resendAvailableAt) > now) {
        throw new BadRequestException('인증 메일은 60초에 한 번만 요청할 수 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      // supersede — 같은 이메일 활성 pending은 대체 만료(새 코드만 유효).
      for (const active of actives) {
        await this.store.update<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, active.id, { status: 'expired' });
      }
      const code = String(randomInt(100000, 1000000));
      // 발송은 tx 안·insert 전 — 발송 실패(예외) 시 row +0. 발송 규약(D8):
      //  · signup: 위 중복 판정을 통과한 이메일에 발송.
      //  · recovery: 미가입 이메일도 코드는 가되 인증 후 '계정 없음'만 보게 된다
      //    (이메일 소유를 증명한 본인에게만 노출되므로 열거 아님).
      //  MailService.sendOtpEmail은 SMTP 미설정 시 false(fail-closed) — 비production만 devOtpCode로
      //  대체(개발·e2e 편의), production은 부팅 가드(SMTP 필수)로 이 분기 자체가 없다.
      const sent = await this.mail.sendOtpEmail(email, code);
      const row = await this.store.insert<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, {
        emailNormalized: email,
        purpose,
        codeHash: codeHashOf(purpose, email, code),
        status: 'pending',
        attemptCount: 0,
        resendCount: 0,
        resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        verifiedAt: null,
        consumedAt: null,
        consumedByUserId: null,
      });
      const deliveryOutcome = sent ? 'sent' : isProduction() ? 'failed_closed' : 'dev_fallback';
      return { row, devOtpCode: !sent && !isProduction() ? code : undefined, deliveryOutcome };
    });
    // 운영자가 "201인데 메일이 없음"을 구분할 수 있는 서버 진단 로그. 이메일·코드·계정 ID는 넣지 않는다.
    this.logger.log(logLine('app', {
      event: 'signup_email_challenge_delivery',
      purpose,
      outcome: result.deliveryOutcome,
      challengeId: result.row.id,
    }));
    return this.toResponse(result.row, result.devOtpCode);
  }

  // ── 확인 ────────────────────────────────────────────────────────────────
  /** 코드 확인 — sha256 대조·시도 5회 잠금·만료 판정. 실패 카운터는 예외보다 먼저 커밋한다. */
  async confirm(id: number, rawEmail: string, code: string, purpose: EmailChallengePurpose = 'signup'): Promise<{ id: number; status: 'verified' }> {
    const email = this.contacts.normalize('email', rawEmail);
    const outcome = await this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'signupChallenge', id }]);
      await this.refresh();
      const challenge = this.db.findById<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES, id);
      // 이메일·목적 불일치는 missing과 동일 취급 — challenge 존재 열거 방지(GENERIC).
      if (!challenge || challenge.emailNormalized !== email || (challenge.purpose ?? 'signup') !== purpose) return { kind: 'missing' as const };
      if (challenge.status !== 'pending') return { kind: 'invalid_state' as const };
      if (this.isExpired(challenge)) {
        await this.store.update<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC, id, { status: 'expired' });
        return { kind: 'expired' as const };
      }
      if (challenge.codeHash !== codeHashOf(purpose, email, code)) {
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
        throw new BadRequestException({ statusCode: 400, message: '인증 시도 횟수를 초과했습니다. 처음부터 다시 요청해 주세요.', code: 'OTP_LOCKED' }); // [TBO-65 5-B] FE는 code로 잠금 감지(문구 결합 해소)
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
    if (!challenge || challenge.emailNormalized !== email || (challenge.purpose ?? 'signup') !== 'signup') {
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

  // ── 소비(복구 tx 안에서만 호출) ─────────────────────────────────────────
  /**
   * [TBO-31 C5 D9] recovery verified challenge 일회 소비 — 아이디 찾기 complete·비밀번호
   * OTP 재설정 tx 안에서 호출된다(중첩 run passthrough). matchedUserId는 대조된 계정이
   * 있으면 그 id, 없으면 null(아이디 찾기 '계정 없음'도 소비는 성립 — state CHECK 완화 근거).
   * 실패(미인증·목적/이메일 불일치·만료·이중 소비)는 전부 GENERIC 400(열거 방지).
   */
  async consumeForRecovery(id: number, rawEmail: string, matchedUserId: number | null): Promise<SignupEmailChallenge> {
    const email = this.contacts.normalize('email', rawEmail);
    await this.uow.lockTargets([{ kind: 'signupChallenge', id }]);
    await this.store.hydrate<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES_SPEC);
    const challenge = this.db.findById<SignupEmailChallenge>(SIGNUP_EMAIL_CHALLENGES, id);
    if (!challenge || challenge.emailNormalized !== email || (challenge.purpose ?? 'signup') !== 'recovery') {
      throw new BadRequestException(GENERIC_INVALID);
    }
    if (challenge.status !== 'verified' || this.isExpired(challenge)) {
      throw new BadRequestException(GENERIC_INVALID);
    }
    const consumed = await this.store.updateIf<SignupEmailChallenge>(
      SIGNUP_EMAIL_CHALLENGES_SPEC,
      id,
      { status: 'verified' },
      { status: 'consumed', consumedAt: new Date().toISOString(), consumedByUserId: matchedUserId },
    );
    if (!consumed) throw new BadRequestException(GENERIC_INVALID); // 동시 소비 — 한쪽만 성공
    return consumed;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────
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
