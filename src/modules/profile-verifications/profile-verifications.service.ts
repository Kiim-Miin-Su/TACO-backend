// [TBO-29B-4] 연락처 재인증 서비스 — 발송/확인/재전송/소비.
//  권위 규칙(§2·§5·§7): 현재 비밀번호 재확인 → 정규화(email lowercase·phone E.164) → 중복 검사 →
//  provider 발송 → challenge 영속(만료 10분·재전송 60초·실패 5회 잠금 — 전부 DB 컬럼) →
//  확인(verified) → profile request 생성 tx 안에서 **일회 소비(consumed)**.
//  평문 코드/비밀번호/provider secret은 저장·로그·응답 어디에도 남기지 않는다.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PROFILE_VERIFICATION_CHALLENGES_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { USERS, type StaffAccount } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import {
  CONTACT_VERIFICATION_PROVIDER,
  type ContactVerificationProvider,
} from './contact-verification.provider';
import {
  CHALLENGE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_RESENDS,
  PROFILE_VERIFICATION_CHALLENGES,
  RESEND_COOLDOWN_MS,
  isActiveStatus,
  maskTarget,
  type ProfileVerificationChallenge,
  type VerificationChannel,
} from './profile-verification.entity';
import { CreateProfileVerificationDto } from './dto/create-profile-verification.dto';
import { ProfileVerificationResponseDto } from './dto/profile-verification-response.dto';

const hashSecret = (): string =>
  process.env.PROFILE_VERIFICATION_SALT || process.env.JWT_SECRET || 'dev-verification-salt';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const codeHashOf = (challengeSeed: string, code: string): string => sha256(`${challengeSeed}:${code}:${hashSecret()}`);
const targetHashOf = (target: string): string => sha256(`${target}:${hashSecret()}`);

// 실패 메시지 일반화(§6) — 존재/원인 열거 방지용 공통 문구.
const GENERIC_INVALID = '유효하지 않거나 만료된 인증입니다.';

@Injectable()
export class ProfileVerificationsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly users: UsersService,
    @Inject(CONTACT_VERIFICATION_PROVIDER) private readonly provider: ContactVerificationProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC);
  }

  // ── 발송 ────────────────────────────────────────────────────────────────
  async create(requesterId: number, dto: CreateProfileVerificationDto): Promise<ProfileVerificationResponseDto> {
    await this.users.refreshFromDb();
    const requester = this.users.findById(requesterId);
    if (!requester) throw new NotFoundException(`계정 ${requesterId} 없음`);
    if (!(await this.users.validatePassword(requester, dto.currentPassword))) {
      throw new ForbiddenException('현재 비밀번호가 올바르지 않습니다.');
    }
    const target = this.normalizeTarget(dto.channel, dto.target);
    this.assertTargetAvailable(dto.channel, target, requesterId);

    const created = await this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id: requesterId }]);
      await this.refresh();
      this.assertTargetAvailable(dto.channel, target, requesterId);
      const now = Date.now();
      // 같은 채널의 기존 활성 challenge는 대체(만료 처리) — 활성 1건 불변식 유지(대상 정정 UX).
      for (const active of this.activeFor(requesterId, dto.channel)) {
        await this.store.update<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, active.id, {
          status: 'expired',
        });
      }
      // provider 발송을 tx 안·insert 전에 수행 — 발송 실패 시 row +0(§8 V4 rollback 규약).
      //  [SENS 전환] 코드 생성 여부는 채널 하드코딩이 아니라 provider 코드 소유권으로 판정 —
      //  email·SENS는 서비스 생성(hash 저장), Twilio Verify는 provider 생성(codeHash null).
      const code = this.provider.ownsCode(dto.channel) ? undefined : String(randomInt(100000, 1000000));
      const sent = await this.provider.send({ channel: dto.channel, target, code });
      const seed = `${requesterId}:${dto.channel}:${target}`;
      return this.store.insert<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, {
        requesterId,
        channel: dto.channel,
        targetNormalized: target,
        targetHash: targetHashOf(target),
        provider: sent.provider,
        providerReference: sent.providerReference ?? null,
        codeHash: code ? codeHashOf(seed, code) : null,
        status: 'pending',
        attemptCount: 0,
        resendCount: 0,
        resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        verifiedAt: null,
        consumedAt: null,
        consumedByRequestId: null,
      });
    });
    return this.toResponse(created);
  }

  // ── 확인 ────────────────────────────────────────────────────────────────
  async confirm(requesterId: number, id: number, code: string): Promise<ProfileVerificationResponseDto> {
    // 실패 카운터는 던지기 전에 **커밋**되어야 한다 → tx는 outcome을 반환하고 예외는 tx 밖에서 던진다.
    const outcome = await this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id: requesterId },
        { kind: 'verificationChallenge', id },
      ]);
      await this.refresh();
      const challenge = this.ownChallenge(requesterId, id);
      if (!challenge) return { kind: 'missing' as const };
      if (challenge.status !== 'pending') return { kind: 'invalid_state' as const, challenge };
      if (this.isExpired(challenge)) {
        await this.store.update<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, id, { status: 'expired' });
        return { kind: 'expired' as const };
      }
      const ok = await this.verifyCode(challenge, code);
      if (!ok) {
        const attempts = challenge.attemptCount + 1;
        const locked = attempts >= MAX_ATTEMPTS;
        await this.store.update<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, id, {
          attemptCount: attempts,
          ...(locked ? { status: 'locked' as const } : {}),
        });
        return { kind: locked ? ('locked' as const) : ('wrong_code' as const) };
      }
      const verified = await this.store.updateIf<ProfileVerificationChallenge>(
        PROFILE_VERIFICATION_CHALLENGES_SPEC,
        id,
        { status: 'pending' },
        { status: 'verified', verifiedAt: new Date().toISOString() },
      );
      if (!verified) return { kind: 'invalid_state' as const };
      return { kind: 'verified' as const, challenge: verified };
    });

    switch (outcome.kind) {
      case 'verified':
        return this.toResponse(outcome.challenge!);
      case 'locked':
        throw new BadRequestException({ statusCode: 400, message: '인증 시도 횟수를 초과했습니다. 처음부터 다시 요청해 주세요.', code: 'OTP_LOCKED' }); // [TBO-65 5-B] FE는 code로 잠금 감지(문구 결합 해소)
      default:
        throw new BadRequestException(GENERIC_INVALID);
    }
  }

  // ── 재전송 ──────────────────────────────────────────────────────────────
  async resend(requesterId: number, id: number): Promise<ProfileVerificationResponseDto> {
    const outcome = await this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id: requesterId },
        { kind: 'verificationChallenge', id },
      ]);
      await this.refresh();
      const challenge = this.ownChallenge(requesterId, id);
      if (!challenge || challenge.status !== 'pending') return { kind: 'invalid' as const };
      if (this.isExpired(challenge)) {
        await this.store.update<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, id, { status: 'expired' });
        return { kind: 'invalid' as const };
      }
      const now = Date.now();
      if (Date.parse(challenge.resendAvailableAt) > now) return { kind: 'cooldown' as const, challenge };
      if (challenge.resendCount >= MAX_RESENDS) return { kind: 'resend_limit' as const };

      const code = this.provider.ownsCode(challenge.channel) ? undefined : String(randomInt(100000, 1000000));
      await this.provider.send({ channel: challenge.channel, target: challenge.targetNormalized, code });
      const seed = `${requesterId}:${challenge.channel}:${challenge.targetNormalized}`;
      const updated = await this.store.update<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC, id, {
        ...(code ? { codeHash: codeHashOf(seed, code) } : {}),
        resendCount: challenge.resendCount + 1,
        resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        attemptCount: 0,
      });
      return { kind: 'sent' as const, challenge: updated! };
    });

    switch (outcome.kind) {
      case 'sent':
        return this.toResponse(outcome.challenge);
      case 'cooldown':
        throw new BadRequestException(`재전송은 ${outcome.challenge!.resendAvailableAt} 이후에 가능합니다.`);
      case 'resend_limit':
        throw new BadRequestException({ statusCode: 400, message: '재전송 횟수를 초과했습니다. 처음부터 다시 요청해 주세요.', code: 'OTP_LOCKED' }); // [TBO-65 5-B] FE는 code로 잠금 감지(문구 결합 해소)
      default:
        throw new BadRequestException(GENERIC_INVALID);
    }
  }

  // ── 소비(profile request 생성 tx 안에서만 호출) ─────────────────────────
  /** 호출자는 반드시 자신의 uow.run(user lock 포함) 안에서 부른다 — 실패 시 요청 생성까지 전체 롤백. */
  async consumeForRequest(
    challengeId: number,
    requesterId: number,
    requestId: number,
    expected: { channel: VerificationChannel; target: string },
  ): Promise<ProfileVerificationChallenge> {
    await this.refresh();
    const challenge = this.ownChallenge(requesterId, challengeId);
    if (!challenge) throw new BadRequestException(GENERIC_INVALID);
    if (challenge.status !== 'verified' || this.isExpired(challenge)) throw new BadRequestException(GENERIC_INVALID);
    if (challenge.channel !== expected.channel || challenge.targetNormalized !== expected.target) {
      throw new BadRequestException('인증한 연락처와 변경 요청 값이 일치하지 않습니다.');
    }
    const consumed = await this.store.updateIf<ProfileVerificationChallenge>(
      PROFILE_VERIFICATION_CHALLENGES_SPEC,
      challengeId,
      { status: 'verified' },
      { status: 'consumed', consumedAt: new Date().toISOString(), consumedByRequestId: requestId },
    );
    if (!consumed) throw new ConflictException('이미 사용된 인증입니다.'); // 동시 소비 — 한쪽만 성공
    return consumed;
  }

  // ── 소비(자격증명 변경 tx 안에서만 호출) ─────────────────────────────────
  /** [E0 2026-07-15] 비밀번호 변경 본인 인증 — **본인 현재 이메일**로 verified된 challenge를 소비한다.
   *  호출자는 반드시 자신의 uow.run 안에서 부른다(실패 시 비밀번호 변경까지 전체 롤백).
   *  consumedByRequestId는 null 유지(프로필 요청이 아닌 자격증명 변경 소비 — consumedAt만 기록). */
  async consumeForCredentialChange(
    challengeId: number,
    requesterId: number,
    expectedEmail: string,
  ): Promise<ProfileVerificationChallenge> {
    await this.refresh();
    const challenge = this.ownChallenge(requesterId, challengeId);
    if (!challenge) throw new BadRequestException(GENERIC_INVALID);
    if (challenge.status !== 'verified' || this.isExpired(challenge)) throw new BadRequestException(GENERIC_INVALID);
    if (challenge.channel !== 'email' || challenge.targetNormalized !== expectedEmail) {
      throw new BadRequestException('본인 이메일로 완료한 인증이 필요합니다.');
    }
    const consumed = await this.store.updateIf<ProfileVerificationChallenge>(
      PROFILE_VERIFICATION_CHALLENGES_SPEC,
      challengeId,
      { status: 'verified' },
      { status: 'consumed', consumedAt: new Date().toISOString() },
    );
    if (!consumed) throw new ConflictException('이미 사용된 인증입니다.'); // 동시 소비 — 한쪽만 성공
    return consumed;
  }

  // ── 정규화·중복 검사(생성·승인 공용) ────────────────────────────────────
  normalizeTarget(channel: VerificationChannel, raw: string): string {
    if (channel === 'email') {
      const email = raw.trim().toLowerCase();
      if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw new BadRequestException('올바른 이메일 주소가 아닙니다.');
      }
      return email;
    }
    const parsed = parsePhoneNumberFromString(raw.trim(), 'KR');
    if (!parsed?.isValid()) throw new BadRequestException('올바른 휴대전화 번호가 아닙니다.');
    const e164 = parsed.number;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new BadRequestException('올바른 휴대전화 번호가 아닙니다.');
    return e164;
  }

  /** 발송 전·승인 tx 안 양쪽에서 재검사(§3) — canonical 값 기준, 본인 제외. */
  assertTargetAvailable(channel: VerificationChannel, target: string, requesterId: number): void {
    const users = this.db.findAll<StaffAccount>(USERS);
    const clash = users.some((u) => {
      if (u.id === requesterId) return false;
      if (channel === 'email') return !!u.email && u.email.trim().toLowerCase() === target;
      if (!u.phone) return false;
      const normalized = parsePhoneNumberFromString(u.phone.trim(), 'KR');
      return normalized?.isValid() ? normalized.number === target : false;
    });
    if (clash) throw new ConflictException('이미 사용 중인 연락처입니다.');
  }

  // ── 내부 ────────────────────────────────────────────────────────────────
  private async verifyCode(challenge: ProfileVerificationChallenge, code: string): Promise<boolean> {
    // 확인 경로는 challenge 행이 결정한다 — codeHash가 있으면 발송 당시 서비스 소유(email·SENS)였다는
    // 뜻이므로 hash 대조. provider 설정이 발송 후 바뀌어도 진행 중 challenge 규약이 유지된다.
    if (challenge.codeHash) {
      const seed = `${challenge.requesterId}:${challenge.channel}:${challenge.targetNormalized}`;
      return challenge.codeHash === codeHashOf(seed, code);
    }
    if (challenge.channel === 'email') return false; // email인데 hash 없음 = 비정상 행 — fail-closed
    const result = await this.provider.check({
      channel: challenge.channel,
      target: challenge.targetNormalized,
      code,
      providerReference: challenge.providerReference,
    });
    return result.ok;
  }

  private ownChallenge(requesterId: number, id: number): ProfileVerificationChallenge | undefined {
    const row = this.db.findById<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES, id);
    // wrong-owner는 존재 열거 방지를 위해 missing과 동일 취급(§6).
    return row && row.requesterId === requesterId ? row : undefined;
  }

  private activeFor(requesterId: number, channel: VerificationChannel): ProfileVerificationChallenge[] {
    return this.db.findBy<ProfileVerificationChallenge>(
      PROFILE_VERIFICATION_CHALLENGES,
      (c) => c.requesterId === requesterId && c.channel === channel && isActiveStatus(c.status),
    );
  }

  private isExpired(challenge: ProfileVerificationChallenge): boolean {
    return Date.parse(challenge.expiresAt) <= Date.now();
  }

  private async refresh(): Promise<void> {
    await this.users.refreshFromDb();
    await this.store.hydrate<ProfileVerificationChallenge>(PROFILE_VERIFICATION_CHALLENGES_SPEC);
  }

  private toResponse(challenge: ProfileVerificationChallenge): ProfileVerificationResponseDto {
    return {
      id: challenge.id,
      channel: challenge.channel,
      maskedTarget: maskTarget(challenge.channel, challenge.targetNormalized),
      status: challenge.status,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: challenge.resendAvailableAt,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - challenge.attemptCount),
    };
  }
}
