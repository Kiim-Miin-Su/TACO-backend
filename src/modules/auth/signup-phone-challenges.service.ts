// [TBO-57 2026-07-24] 가입 전 휴대전화 OTP — **공개(비로그인) 흐름 전용** 서비스.
//  signup_email_challenges(TBO-31 D1) 규약의 SMS판: 상수(TTL 10분·쿨다운 60초·시도/재전송 5회)·
//  salted sha256 hash·masked 응답·GENERIC 400(열거 방지)·가입 tx 일회 소비를 그대로 미러한다.
//  발송은 CONTACT_VERIFICATION_PROVIDER(SENS — 코드 소유권=서비스)로 위임. **SENS 전용**:
//  Twilio Verify(legacy·provider 코드 소유)는 마이페이지 재인증 전용이고 가입 폼은 지원하지
//  않는다 — 가용성 판정(sensChallengeAvailable)도 SENS 4종 env 완비만 본다.
//  평문 코드는 저장·로그·응답에 남기지 않는다(예외: 비production+SENS 부재의 devOtpCode —
//  이메일판 devOtpCode 관례. production+SENS 부재는 fail-closed 503).
import { BadRequestException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { isProduction } from '../../common/env';
import type { BaseRow } from '../../common/types/base';
import { logLine } from '../../common/log-line';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { SIGNUP_PHONE_CHALLENGES_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import {
  CONTACT_VERIFICATION_PROVIDER,
  type ContactVerificationProvider,
} from '../profile-verifications/contact-verification.provider';
import { sensChallengeAvailable } from '../profile-verifications/sms-availability';
import {
  CHALLENGE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  maskTarget,
} from '../profile-verifications/profile-verification.entity';

export const SIGNUP_PHONE_CHALLENGES = 'signup_phone_challenges';

export type SignupPhoneChallengeStatus = 'pending' | 'verified' | 'expired' | 'locked' | 'consumed';

export type SignupPhoneChallenge = {
  /** E.164 canonical(libphonenumber KR) — 응답에는 masked만 노출 */
  phoneNormalized: string;
  /** 표는 email판과 대칭으로 recovery도 허용하나 현재 발급 경로는 signup뿐 */
  purpose: 'signup' | 'recovery';
  /** salted sha256(코드 평문 미저장 — signup_email_challenges와 동일 salt 규약) */
  codeHash: string;
  status: SignupPhoneChallengeStatus;
  attemptCount: number;
  resendCount: number;
  expiresAt: string;
  resendAvailableAt: string;
  verifiedAt?: string | null;
  consumedAt?: string | null;
  /** 가입 tx에서 소비될 때 생성된 users.id — 소비 추적 */
  consumedByUserId?: number | null;
} & BaseRow;

export type SignupPhoneChallengeResponse = {
  id: number;
  maskedTarget: string;
  expiresAt: string;
  resendAvailableAt: string;
  /** 비production + SENS 부재에서만 존재(devOtpCode 관례) — production 응답에 절대 없음 */
  devOtpCode?: string;
};

const hashSecret = (): string =>
  process.env.PROFILE_VERIFICATION_SALT || process.env.JWT_SECRET || 'dev-verification-salt';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const codeHashOf = (phone: string, code: string): string =>
  sha256(`signup-phone:${phone}:${code}:${hashSecret()}`);

const GENERIC_INVALID = '유효하지 않거나 만료된 인증입니다.';

@Injectable()
export class SignupPhoneChallengesService implements OnModuleInit {
  private readonly logger = new Logger(SignupPhoneChallengesService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    @Inject(CONTACT_VERIFICATION_PROVIDER) private readonly provider: ContactVerificationProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    // [TBO-57 원천 픽스] hydrate 자체가 표-부재 생존(store 공통 규약) — migration owner-paste 전
    //  배포에도 부팅·health는 살고, 이 표의 READ·쓰기만 SQL 오류로 fail-closed 된다.
    await this.store.hydrate<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC);
  }

  /** 가입 폼 휴대전화 인증 필수 여부 — SENS env 완비 판정(signup-config 공개 노출·signup 소비 게이트 공용). */
  required(): boolean {
    return sensChallengeAvailable();
  }

  // ── 발송 ────────────────────────────────────────────────────────────────
  /**
   * challenge 생성 + OTP 발송. 재발송 규약 = 이메일판과 동일(별도 resend 없이 쿨다운 60초 후
   * 기존 pending supersede). 전화번호는 계정 유니크 제약이 없어 열거 방지 발송 생략 분기가 없다
   * (항상 발송). 발송은 tx 안·insert 전 — SENS 호출 실패(예외) 시 row +0.
   */
  async create(rawPhone: string): Promise<SignupPhoneChallengeResponse> {
    const phone = this.normalizePhone(rawPhone);
    const result = await this.uow.run(async () => {
      await this.refresh();
      const now = Date.now();
      const actives = this.db.findBy<SignupPhoneChallenge>(
        SIGNUP_PHONE_CHALLENGES,
        (c) => c.phoneNormalized === phone && c.purpose === 'signup' && c.status === 'pending',
      );
      const latest = actives[actives.length - 1];
      if (latest && Date.parse(latest.resendAvailableAt) > now) {
        throw new BadRequestException('인증 문자는 60초에 한 번만 요청할 수 있습니다. 잠시 후 다시 시도해 주세요.');
      }
      for (const active of actives) {
        await this.store.update<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC, active.id, { status: 'expired' });
      }
      const code = String(randomInt(100000, 1000000));
      let sent = false;
      if (sensChallengeAvailable()) {
        // SENS(서비스 코드 소유) — 실패는 예외로 전파(tx 롤백, fail-closed).
        await this.provider.send({ channel: 'sms', target: phone, code });
        sent = true;
      } else if (isProduction()) {
        throw new ServiceUnavailableException('휴대전화 인증 발송이 설정되지 않았습니다.');
      }
      const row = await this.store.insert<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC, {
        phoneNormalized: phone,
        purpose: 'signup',
        codeHash: codeHashOf(phone, code),
        status: 'pending',
        attemptCount: 0,
        resendCount: 0,
        resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        verifiedAt: null,
        consumedAt: null,
        consumedByUserId: null,
      });
      return { row, devOtpCode: !sent ? code : undefined, deliveryOutcome: sent ? 'sent' : 'dev_fallback' };
    });
    // 진단 로그 — 전화번호·코드·계정 ID는 넣지 않는다(PII 0 규약).
    this.logger.log(logLine('app', {
      event: 'signup_phone_challenge_delivery',
      outcome: result.deliveryOutcome,
      challengeId: result.row.id,
    }));
    return this.toResponse(result.row, result.devOtpCode);
  }

  // ── 확인 ────────────────────────────────────────────────────────────────
  /** 코드 확인 — sha256 대조·시도 5회 잠금·만료 판정. 실패 카운터는 예외보다 먼저 커밋한다. */
  async confirm(id: number, rawPhone: string, code: string): Promise<{ id: number; status: 'verified' }> {
    const phone = this.normalizePhone(rawPhone);
    const outcome = await this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'signupPhoneChallenge', id }]);
      await this.refresh();
      const challenge = this.db.findById<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES, id);
      // 전화·목적 불일치는 missing과 동일 취급 — challenge 존재 열거 방지(GENERIC).
      if (!challenge || challenge.phoneNormalized !== phone || challenge.purpose !== 'signup') return { kind: 'missing' as const };
      if (challenge.status !== 'pending') return { kind: 'invalid_state' as const };
      if (this.isExpired(challenge)) {
        await this.store.update<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC, id, { status: 'expired' });
        return { kind: 'expired' as const };
      }
      if (challenge.codeHash !== codeHashOf(phone, code)) {
        const attempts = challenge.attemptCount + 1;
        const locked = attempts >= MAX_ATTEMPTS;
        await this.store.update<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC, id, {
          attemptCount: attempts,
          ...(locked ? { status: 'locked' as const } : {}),
        });
        return { kind: locked ? ('locked' as const) : ('wrong_code' as const) };
      }
      const verified = await this.store.updateIf<SignupPhoneChallenge>(
        SIGNUP_PHONE_CHALLENGES_SPEC,
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
   * (중첩 run passthrough). 실패(미인증·전화 불일치·만료·이중 소비) 시 예외 → 계정 insert까지
   * 전체 롤백(부분 상태 0). 성공 시 consumed + consumed_by_user_id 기록.
   */
  async consumeForSignup(id: number, rawPhone: string, createdUserId: number): Promise<SignupPhoneChallenge> {
    const phone = this.normalizePhone(rawPhone);
    await this.uow.lockTargets([{ kind: 'signupPhoneChallenge', id }]);
    await this.store.hydrate<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC);
    const challenge = this.db.findById<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES, id);
    if (!challenge || challenge.phoneNormalized !== phone || challenge.purpose !== 'signup') {
      throw new BadRequestException('가입 휴대전화의 인증이 필요합니다. 휴대전화 인증을 먼저 완료해 주세요.');
    }
    if (challenge.status !== 'verified' || this.isExpired(challenge)) {
      throw new BadRequestException('가입 휴대전화의 인증이 필요합니다. 휴대전화 인증을 먼저 완료해 주세요.');
    }
    const consumed = await this.store.updateIf<SignupPhoneChallenge>(
      SIGNUP_PHONE_CHALLENGES_SPEC,
      id,
      { status: 'verified' },
      { status: 'consumed', consumedAt: new Date().toISOString(), consumedByUserId: createdUserId },
    );
    if (!consumed) throw new BadRequestException(GENERIC_INVALID); // 동시 소비 — 한쪽만 성공
    return consumed;
  }

  // ── 내부 ────────────────────────────────────────────────────────────────
  /** 휴대전화 canonical(E.164) — profile-verifications.normalizeTarget('sms') 규약 동일. */
  normalizePhone(raw: string): string {
    const parsed = parsePhoneNumberFromString(raw.trim(), 'KR');
    if (!parsed?.isValid()) throw new BadRequestException('올바른 휴대전화 번호가 아닙니다.');
    const e164 = parsed.number;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new BadRequestException('올바른 휴대전화 번호가 아닙니다.');
    return e164;
  }

  private isExpired(challenge: SignupPhoneChallenge): boolean {
    return Date.parse(challenge.expiresAt) <= Date.now();
  }

  private async refresh(): Promise<void> {
    // challenge 상태는 권위 DB 기준(교차 인스턴스 정합 — 28F 규약).
    await this.store.hydrate<SignupPhoneChallenge>(SIGNUP_PHONE_CHALLENGES_SPEC);
  }

  private toResponse(row: SignupPhoneChallenge, devOtpCode?: string): SignupPhoneChallengeResponse {
    return {
      id: row.id,
      maskedTarget: maskTarget('sms', row.phoneNormalized),
      expiresAt: row.expiresAt,
      resendAvailableAt: row.resendAvailableAt,
      ...(devOtpCode ? { devOtpCode } : {}),
    };
  }
}
