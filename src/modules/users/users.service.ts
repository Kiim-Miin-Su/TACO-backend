import { TimedModuleInit } from '../../common/performance-timing';
// [참조/처리] 직원 계정 서비스 — InMemoryDatabase 'users' 컬렉션(단일 자산) 기반.
//  가입(pending) → 이메일 인증 → 대표 승인(active) 라이프사이클의 모든 상태 변화가 db에 기록된다.
//  [자산화 점검 2026-07-02] 서비스 로컬 배열(this.accounts) → db.seed/insert/update 이관.
//  [TBO-28B 2026-07-14] 승인 = **단일 트랜잭션**(users CAS + instructor_profiles + audit_log),
//   verification token = sha256 hash + 48h 만료(성공 시 명시 NULL), runtime business fixture 없음.
import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import type { WebIdCheckResult, StaffAccountDetail, StaffAccountSummary } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { maskTarget } from '../profile-verifications/profile-verification.entity'; // [E0.5 ⑥] audit 마스킹
import {
  RRN_FORMAT_MESSAGE, birthYearFromRrn, encryptRrn, normalizeRrn, validateRrnFormat,
} from '../../common/rrn-crypto.util'; // [TBO-31 C1 D2] (마스킹은 user.entity.rrnMaskedOf — TBO-68 C3)
import { SignupEmailChallengesService } from '../auth/signup-email-challenges.service'; // [TBO-31 C1 D1]
import { SignupPhoneChallengesService } from '../auth/signup-phone-challenges.service'; // [TBO-57]
import { SignupContactAvailabilityService } from '../auth/signup-contact-availability.service';
import { INSTRUCTOR_PROFILES, InstructorProfilesStore, activeTeachingProfileUserIds, type InstructorProfile } from './instructor-profiles.store';
import { UserRoleTransitionService } from './user-role-transition.service';
import { claimRolesFor,
  USERS, authVersionOf, isStaffRole, rrnMaskedOf, toSafe,
  type SafeAccount, type StaffAccount, type StaffRole,
} from './user.entity';
import { requireStaffEnglishName } from './staff-english-name.policy';

// 하위 호환 재노출(외부 소비처가 users.service 경유로 import하던 심볼)
export { isStaffRole, toAccount, toSafe } from './user.entity';
export type { AccountStatus, SafeAccount, StaffAccount, StaffRole } from './user.entity';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
// [E0] export — 프로필 변경 요청(webId 승인제)의 잠금이 즉시 변경 경로와 같은 lock id를 쓴다
//  (case-insensitive 동시 선점을 한 직렬화 지점에서 판정 — TBO-29B 규약 유지).
export const identityLockId = (webId: string): number => Number.parseInt(sha256(webId.trim().toLowerCase()).slice(0, 7), 16);


@TimedModuleInit()
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly profiles: InstructorProfilesStore,
    private readonly roleTransitions: UserRoleTransitionService,
    // [TBO-31 C1 D1] 가입 tx에서 이메일 OTP challenge를 일회 소비 — Users↔Auth 기존 forwardRef 순환 위.
    @Inject(forwardRef(() => SignupEmailChallengesService))
    private readonly signupChallenges: SignupEmailChallengesService,
    // [TBO-57] 가입 tx에서 휴대전화 OTP challenge를 일회 소비(SENS 설정 시 필수) — 동일 forwardRef.
    @Inject(forwardRef(() => SignupPhoneChallengesService))
    private readonly signupPhoneChallenges: SignupPhoneChallengesService,
    @Inject(forwardRef(() => SignupContactAvailabilityService))
    private readonly signupContacts: SignupContactAvailabilityService,
  ) {}

  // [TBO-68 C3] 강사 HR aggregate CRUD → instructor-hr.service.ts 분리(본문 이동 — 규약 무변).

  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<StaffAccount>(USERS_SPEC);
    if (isProduction() && !hydrated.length) await this.bootstrapInitialAdmin();
  }

  /** production 최초 관리자 부트스트랩. 첫 로그인에서 아이디와 비밀번호를 모두 교체한다. */
  private async bootstrapInitialAdmin(): Promise<void> {
    const webId = process.env.INITIAL_ADMIN_WEB_ID?.trim();
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (!webId || !password || password.length < 8) {
      throw new Error(
        '[users] production 빈 DB — INITIAL_ADMIN_WEB_ID/INITIAL_ADMIN_PASSWORD(8자+)가 필요합니다. ' +
        '운영 업무 시드는 제공되지 않습니다(로그인 불능 배포 방지 fail-fast).',
      );
    }
    await this.store.insert<StaffAccount>(USERS_SPEC, {
      webId,
      name: process.env.INITIAL_ADMIN_NAME?.trim() || '대표',
      englishName: requireStaffEnglishName(process.env.INITIAL_ADMIN_ENGLISH_NAME?.trim() || 'CEO'),
      email: process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || `${webId}@bootstrap.invalid`,
      role: 'super_admin',
      status: 'active',
      passwordHash: await bcrypt.hash(password, 12),
      emailVerified: true,
      authVersion: 1,
      profileVersion: 1,
      mustChangePassword: true,
    });
    this.logger.log(`production 최초 관리자 부트스트랩 완료(webId=${webId}) — 자격증명은 로그에 남기지 않음`);
  }

  // [TBO-28F 2026-07-14] 교차 인스턴스 정합 — users 메모리 투영을 권위 DB에서 재조회.
  //  두 인스턴스 실증에서 발견: A에서 signup/approve된 계정이 B의 로그인·대기목록·리소스에 안 보였다
  //  (schedule 계열만 per-request 재조회했음). 인증/승인 오퍼레이션 진입 시 이 함수를 먼저 부른다.
  //  in-memory 모드에서는 no-op(hydrate가 빈 배열 반환·메모리가 곧 권위).
  async refreshFromDb(): Promise<void> {
    await this.store.hydrate<StaffAccount>(USERS_SPEC);
    await this.profiles.hydrate();
  }

  findAll(includeTerminated = false): SafeAccount[] {
    return this.db
      .findAll<StaffAccount>(USERS, { withDeleted: includeTerminated })
      .filter((account) => !account.deletedAt || (includeTerminated && account.status === 'active'))
      .map(toSafe);
  }

  findByWebId(webId: string): StaffAccount | undefined {
    const key = webId.trim().toLowerCase();
    return this.db.findBy<StaffAccount>(USERS, (a) => a.webId.toLowerCase() === key)[0];
  }

  findById(id: number): StaffAccount | undefined {
    return this.db.findById<StaffAccount>(USERS, id);
  }

  // 가입 신청 — 직원 역할만 요청 가능(super_admin 자가신청 불가). 상태=pending.
  //  [TBO-31 C1 D1] 가입 전 이메일 OTP(emailChallengeId)를 **같은 uow tx에서 일회 소비**하고
  //  계정을 emailVerified=true로 생성한다(48h 링크 토큰 발급·메일 경로는 신규 가입에서 제거 —
  //  GET /auth/verify-email은 잔존 pending 계정 호환으로만 남는다). 소비 실패 시 계정 insert까지 롤백.
  //  [TBO-31 C1 D2] rrn 필수 — 암호문(rrn_encrypted)만 저장, birthYear는 파생 저장. 평문은
  //  응답·로그·audit 어디에도 기록하지 않는다.
  async signup(input: {
    webId: string; name: string; englishName: string; email: string; password: string; role?: string;
    rrn: string; emailChallengeId: number;
    // [TBO-57] SENS 설정 시 필수(서비스 게이트) — verified 휴대전화 challenge를 같은 tx 소비.
    phoneChallengeId?: number;
    // [E0.5 ④b] 대표 기대 필드 — 승인 판단 근거(승인센터 상세 표시 → 승인 tx에서 프로필 승계).
    phone?: string; university?: string; major?: string;
  }): Promise<{ account: SafeAccount }> {
    await this.refreshFromDb(); // [28F] 교차 인스턴스 중복 검사 정합
    const webId = input.webId.trim();
    const englishName = requireStaffEnglishName(input.englishName);
    const email = this.signupContacts.normalize('email', input.email);
    const phone = input.phone?.trim() ? this.signupContacts.normalize('sms', input.phone) : null;
    const role: StaffRole = input.role && isStaffRole(input.role) && input.role !== 'super_admin' ? input.role : 'instructor';
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    // [D2] 형식(정규식+MMDD)만 검증 — 체크섬 검증은 하지 않는다(2020-10 폐지, rrn-crypto.util 주석).
    if (!validateRrnFormat(input.rrn)) throw new BadRequestException(RRN_FORMAT_MESSAGE);
    const rrnCanonical = normalizeRrn(input.rrn); // 하이픈 포함 형태로 통일 저장
    const rrnEncrypted = encryptRrn(rrnCanonical);
    const birthYear = birthYearFromRrn(rrnCanonical); // 파생 저장 — 기존 승계·표시 소비처 무파괴
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    this.signupContacts.assertAvailableInCurrentProjection('email', email);
    if (phone) this.signupContacts.assertAvailableInCurrentProjection('sms', phone);

    const passwordHash = await bcrypt.hash(input.password, 12) // [보안 2026-07-03] cost 12;
    // [M1] await(hash) 사이에 동일 webId/email 가입이 끼어들 수 있음(TOCTOU) — insert 직전 동기 재검증
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    this.signupContacts.assertAvailableInCurrentProjection('email', email);
    if (phone) this.signupContacts.assertAvailableInCurrentProjection('sms', phone);
    return this.uow.run(async () => {
      await this.signupContacts.assertAvailable('email', email);
      if (phone) await this.signupContacts.assertAvailable('sms', phone);
      const acc = await this.store.insert<StaffAccount>(USERS_SPEC, {
        webId, name: input.name.trim(), englishName, email, role,
        status: 'pending', passwordHash,
        // [D1] 가입 전 OTP로 이메일 소유 실증 완료 — verified 생성, 링크 토큰 컬럼은 처음부터 null.
        emailVerified: true,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        authVersion: 1,
        profileVersion: 1,
        mustChangePassword: false,
        // [E0.5 ④b] 지원자 제공 정보 — 승인센터 상세에 노출, 승인 tx에서 instructor_profiles 승계.
        phone,
        university: input.university?.trim() || null,
        major: input.major?.trim() || null,
        birthYear,
        rrnEncrypted,
      });
      // [D1] challenge 소비 — verified·이메일 일치·미소비 검증. 실패 예외 → 계정 insert까지 롤백.
      await this.signupChallenges.consumeForSignup(input.emailChallengeId, email, acc.id);
      // [TBO-57] 휴대전화 OTP 소비 — SENS 설정(required) 환경에서만 필수. 판정 단일 진실원 =
      //  signupPhoneChallenges.required() (GET /auth/signup-config와 같은 소스 — FE 스테퍼·submit
      //  게이트와 불일치 불가). 실패 예외 → 계정 insert까지 롤백(부분 상태 0).
      {
        const rawPhone = phone;
        if (this.signupPhoneChallenges.required()) {
          if (!rawPhone) throw new BadRequestException('휴대전화 번호를 입력해 주세요.');
          if (input.phoneChallengeId == null) throw new BadRequestException('휴대전화 인증이 필요합니다. 인증을 먼저 완료해 주세요.');
        }
        // 비필수 환경에서도 제출된 challenge는 소비한다(개발·e2e에서 전체 흐름 검증 가능 — 판정만 env 게이트).
        if (input.phoneChallengeId != null) {
          if (!rawPhone) throw new BadRequestException('휴대전화 번호를 입력해 주세요.');
          await this.signupPhoneChallenges.consumeForSignup(input.phoneChallengeId, rawPhone, acc.id);
        }
      }
      // [감사 전수 2026-07-16] 자기 가입 생성 이력 — actor=생성된 본인(추적 기점). PII·RRN은 기록 안 함
      //  (D2: rrn은 마스킹조차 남기지 않는다 — 기록 자체 생략).
      await this.audit.log({
        entity: 'users', entityId: acc.id, action: 'create', actorId: acc.id,
        changes: { webId: { after: acc.webId }, role: { after: acc.role }, status: { after: 'pending' } },
        reason: '자기 가입 신청',
      });
      return { account: toSafe(acc) };
    });
  }

  async verifyEmail(token: string): Promise<SafeAccount> {
    await this.refreshFromDb(); // [28F] 다른 인스턴스에서 가입한 계정의 토큰 조회 정합
    const hash = sha256(token);
    const acc = this.db.findBy<StaffAccount>(
      USERS,
      (a) => !!a.emailVerifyTokenHash && a.emailVerifyTokenHash === hash,
    )[0];
    if (!acc) throw new BadRequestException('유효하지 않거나 만료된 인증 링크입니다.');
    if (acc.emailVerifyExpiresAt && Date.parse(acc.emailVerifyExpiresAt) < Date.now())
      throw new BadRequestException('유효하지 않거나 만료된 인증 링크입니다.');
    // [TBO-28B §4-e] 명시 null — undefined는 toDbPayload가 skip해 Postgres에 토큰이 잔존했다(T12).
    const updated = await this.uow.run(async () => {
      const row = await this.store.update<StaffAccount>(USERS_SPEC, acc.id, {
        emailVerified: true, emailVerifyTokenHash: null, emailVerifyExpiresAt: null,
      }) as StaffAccount;
      // [감사 전수 2026-07-16] 이메일 인증 완료 이력(⚠ 누락 경로였음 — actor=본인).
      await this.audit.log({
        entity: 'users', entityId: acc.id, action: 'update', actorId: acc.id,
        changes: { emailVerified: { before: false, after: true } }, reason: '이메일 인증 완료',
      });
      return row;
    });
    return toSafe(updated);
  }

  // 비밀번호 검증(로그인). 타이밍 안전 비교는 bcrypt.compare가 처리.
  async validatePassword(account: StaffAccount, password: string): Promise<boolean> {
    return bcrypt.compare(password, account.passwordHash);
  }

  /** 로그인 성공 시각 summary(users.last_login_at) — 이력 진실원은 auth_events. */
  async recordLoginSuccess(id: number): Promise<void> {
    await this.store.update<StaffAccount>(USERS_SPEC, id, { lastLoginAt: new Date().toISOString() });
  }

  /**
   * 본인 자격증명 변경. 사용자 advisory lock + 현재 비밀번호 재검증 + CAS update + audit를 한 UoW로 묶는다.
   * password hash는 audit/응답에 절대 포함하지 않으며 authVersion 증가로 기존 JWT를 즉시 폐기한다.
   */
  async changeCredentials(
    id: number,
    input: {
      currentPassword: string; newWebId?: string; newPassword?: string;
      // [E0.5 ⑥] 첫 로그인 강제 변경에서만 허용되는 프로필 동시 설정(가입 폼 재사용 — 대표 지시 2026-07-15).
      // [대표 추가요청 2026-07-16] 수정 가능 컬럼 전부로 확장 — 국가/시간대/출신교/전공/출생연도.
      name?: string; englishName?: string; email?: string; phone?: string;
      countryCode?: string; timeZone?: string; university?: string; major?: string; birthYear?: number;
    },
  ): Promise<SafeAccount> {
    const newWebId = input.newWebId?.trim();
    const newPassword = input.newPassword;
    const newName = input.name?.trim();
    const newEnglishName = input.englishName !== undefined ? requireStaffEnglishName(input.englishName) : undefined;
    const newEmail = input.email?.trim().toLowerCase();
    const newPhone = input.phone?.trim();
    const newCountryCode = input.countryCode?.trim().toUpperCase();
    const newTimeZone = input.timeZone?.trim();
    const newUniversity = input.university?.trim();
    const newMajor = input.major?.trim();
    const newBirthYear = input.birthYear;
    if (!newWebId && !newPassword) throw new BadRequestException('새 아이디 또는 새 비밀번호 중 하나는 필수입니다.');
    if (newWebId && newWebId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    const passwordBytes = newPassword ? Buffer.byteLength(newPassword, 'utf8') : 0;
    if (newPassword && passwordBytes < 8) throw new BadRequestException('새 비밀번호는 8바이트 이상이어야 합니다.');
    if (newPassword && passwordBytes > 72) throw new BadRequestException('새 비밀번호는 72바이트 이하여야 합니다.');
    const nextPasswordHash = newPassword ? await bcrypt.hash(newPassword, 12) : undefined;

    await this.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id },
        ...(newWebId ? [{ kind: 'loginIdentity' as const, id: identityLockId(newWebId) }] : []),
      ]);
      await this.refreshFromDb();
      const before = this.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      if (!(await this.validatePassword(before, input.currentPassword))) {
        throw new ForbiddenException('현재 비밀번호가 올바르지 않습니다.');
      }
      // [E0.5 ⑥] 프로필 동시 설정은 강제 변경(부트스트랩/리셋 직후) 컨텍스트에서만 — 평시 이메일/전화
      //  변경은 29B-4 인증(challenge)·승인 경로를 우회할 수 없다(마이 페이지로 안내).
      const wantsProfile = newName !== undefined || newEnglishName !== undefined || newEmail !== undefined || newPhone !== undefined
        || newCountryCode !== undefined || newTimeZone !== undefined
        || newUniversity !== undefined || newMajor !== undefined || newBirthYear !== undefined;
      if (wantsProfile && !before.mustChangePassword) {
        throw new BadRequestException('이름·이메일·전화 등 프로필 변경은 마이 페이지(프로필 변경)에서 해주세요.');
      }
      // [E0 2026-07-15] 아이디(webId) 즉시 변경 폐지 — 승인제(프로필 변경 요청) 경유.
      //  예외: 첫 로그인 강제 변경(rotation)은 부트스트랩 컨텍스트라 직접 변경 유지.
      if (newWebId && !before.mustChangePassword) {
        throw new BadRequestException('아이디 변경은 마이 페이지의 프로필 변경 요청(대표 승인)으로 진행해 주세요.');
      }
      if (before.mustChangePassword && (!newWebId || !newPassword)) {
        throw new BadRequestException('첫 로그인에서는 새 아이디와 새 비밀번호를 모두 변경해야 합니다.');
      }
      if (before.mustChangePassword && newWebId?.toLowerCase() === before.webId.toLowerCase()) {
        throw new BadRequestException('첫 로그인에서는 기존 아이디와 다른 새 아이디가 필요합니다.');
      }
      if (newPassword && newPassword === input.currentPassword) {
        throw new BadRequestException('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
      }
      if (newWebId) {
        const duplicate = this.findByWebId(newWebId);
        if (duplicate && duplicate.id !== id) throw new ConflictException('이미 사용 중인 아이디입니다.');
      }
      if (newEmail) {
        const emailTaken = this.db.findBy<StaffAccount>(USERS, (a) =>
          a.id !== id && !!a.email && a.email.toLowerCase() === newEmail).length > 0;
        if (emailTaken) throw new ConflictException('이미 사용 중인 이메일입니다.');
      }

      let updated: StaffAccount | undefined;
      try {
        updated = await this.store.updateIf<StaffAccount>(
          USERS_SPEC,
          id,
          { passwordHash: before.passwordHash, authVersion: authVersionOf(before) },
          {
            ...(newWebId ? { webId: newWebId } : {}),
            ...(nextPasswordHash ? { passwordHash: nextPasswordHash } : {}),
            // [E0.5 ⑥] 부트스트랩 프로필 — 이메일은 verified 유지(임시 비밀번호로 본인이 리셋한 신뢰
            //  컨텍스트 + 미검증이면 로그인 게이트(email_unverified)와 복구 흐름이 잠긴다). 오타 리스크는
            //  마이 페이지 재변경(인증 경로)으로 정정 가능.
            ...(newName ? { name: newName } : {}),
            ...(newEnglishName ? { englishName: newEnglishName } : {}),
            // [대표 추가요청 2026-07-16] 이메일은 통합 설정에서 OTP 인증을 통과한 값만 도달
            //  (CredentialsService가 같은 tx에서 challenge 소비) — verified는 실제 인증 결과.
            ...(newEmail ? { email: newEmail, emailVerified: true } : {}),
            ...(newPhone ? { phone: newPhone } : {}),
            ...(newCountryCode ? { countryCode: newCountryCode } : {}),
            ...(newTimeZone ? { timeZone: newTimeZone } : {}),
            ...(newUniversity ? { university: newUniversity } : {}),
            ...(newMajor ? { major: newMajor } : {}),
            ...(newBirthYear ? { birthYear: newBirthYear } : {}),
            authVersion: authVersionOf(before) + 1,
            mustChangePassword: false,
          },
        );
      } catch (error) {
        const code = (error as { code?: string; driverError?: { code?: string } }).code
          ?? (error as { driverError?: { code?: string } }).driverError?.code;
        if (code === '23505') throw new ConflictException('이미 사용 중인 아이디 또는 이메일입니다.');
        throw error;
      }
      if (!updated) throw new ConflictException('계정 정보가 변경되었습니다. 다시 로그인해 주세요.');
      await this.audit.log({
        entity: 'users',
        entityId: id,
        action: 'update',
        actorId: id,
        changes: {
          ...(newWebId && newWebId !== before.webId ? { webId: { before: before.webId, after: newWebId } } : {}),
          ...(newPassword ? { password: { before: '[redacted]', after: '[changed]' } } : {}),
          // [보안] 이메일/전화는 audit에 masked만 (29B-4 §5와 동일 규약)
          ...(newName && newName !== before.name ? { name: { before: before.name, after: newName } } : {}),
          ...(newEnglishName && newEnglishName !== before.englishName ? { englishName: { before: before.englishName, after: newEnglishName } } : {}),
          ...(newEmail && newEmail !== (before.email ?? '') ? { email: { before: before.email ? maskTarget('email', before.email) : null, after: maskTarget('email', newEmail) } } : {}),
          ...(newPhone && newPhone !== (before.phone ?? '') ? { phone: { before: before.phone ? maskTarget('sms', before.phone) : null, after: maskTarget('sms', newPhone) } } : {}),
          ...(newCountryCode && newCountryCode !== (before.countryCode ?? '') ? { countryCode: { before: before.countryCode ?? null, after: newCountryCode } } : {}),
          ...(newTimeZone && newTimeZone !== (before.timeZone ?? '') ? { timeZone: { before: before.timeZone ?? null, after: newTimeZone } } : {}),
          ...(newUniversity && newUniversity !== (before.university ?? '') ? { university: { before: before.university ?? null, after: newUniversity } } : {}),
          ...(newMajor && newMajor !== (before.major ?? '') ? { major: { before: before.major ?? null, after: newMajor } } : {}),
          ...(newBirthYear && newBirthYear !== before.birthYear ? { birthYear: { before: before.birthYear ?? null, after: newBirthYear } } : {}),
          ...(before.mustChangePassword ? { mustChangePassword: { before: true, after: false } } : {}),
          authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 },
        },
        reason: '본인 계정 자격증명 변경',
      });
      return toSafe(updated);
    });
  }

  // ── [TBO-29C C5] 비로그인 복구(아이디 찾기·비밀번호 재설정) ────────────────────
  //  규약: 응답은 계정 존재와 무관하게 동일(열거 방지 — 호출부 책임), 토큰은 sha256+1h 만료만 저장,
  //  재설정 성공 = 토큰 명시 NULL + auth_version+1(기존 세션 전부 무효) + audit.

  /** canonical 이메일로 활성·검증 계정 조회(아이디 찾기용). */
  findActiveByEmail(email: string): StaffAccount | undefined {
    const canonical = email.trim().toLowerCase();
    if (!canonical) return undefined;
    return this.db.findBy<StaffAccount>(USERS, (a) =>
      (a.email ?? '').trim().toLowerCase() === canonical && a.status === 'active' && a.emailVerified === true,
    )[0];
  }

  /** 재설정 시작 — webId+이메일이 모두 일치하는 활성 계정만 토큰 발급(불일치=조용히 무시). */
  async beginPasswordReset(webId: string, email: string): Promise<{ account?: SafeAccount; resetToken?: string }> {
    await this.refreshFromDb();
    const acc = this.findByWebId(webId);
    const canonical = email.trim().toLowerCase();
    if (!acc || acc.status !== 'active' || (acc.email ?? '').trim().toLowerCase() !== canonical) return {};
    const resetToken = randomBytes(24).toString('hex');
    await this.store.update<StaffAccount>(USERS_SPEC, acc.id, {
      passwordResetTokenHash: sha256(resetToken),
      passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1시간
    } as Partial<StaffAccount> as never);
    return { account: toSafe(acc), resetToken };
  }

  /** 토큰으로 비밀번호 재설정 — 무효/만료/재사용은 동일 400 메시지(토큰 상태 열거 방지). */
  async resetPasswordWithToken(token: string, newPassword: string): Promise<SafeAccount> {
    const bytes = Buffer.byteLength(newPassword, 'utf8');
    if (bytes < 8) throw new BadRequestException('새 비밀번호는 8바이트 이상이어야 합니다.');
    if (bytes > 72) throw new BadRequestException('새 비밀번호는 72바이트 이하여야 합니다.');
    const invalid = () => new BadRequestException('재설정 링크가 유효하지 않거나 만료되었습니다. 다시 요청해 주세요.');
    const hash = sha256(token);
    await this.refreshFromDb();
    const found = this.db.findBy<StaffAccount>(USERS, (a) => !!a.passwordResetTokenHash && a.passwordResetTokenHash === hash)[0];
    if (!found) throw invalid();
    const nextPasswordHash = await bcrypt.hash(newPassword, 12);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id: found.id }]);
      await this.refreshFromDb();
      const before = this.findById(found.id);
      if (!before || before.passwordResetTokenHash !== hash) throw invalid();
      // [크로스 모드] PG hydrate는 timestamptz를 Date 객체로 되돌린다 — 문자열 비교는 항상 false가 되어
      //  만료 토큰이 수용되는 결함(PG 모드 e2e 실측). epoch(ms)로 정규화해 판정한다.
      const expiresAtMs = before.passwordResetExpiresAt ? new Date(before.passwordResetExpiresAt as unknown as string | Date).getTime() : Number.NaN;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) throw invalid();
      const updated = await this.store.updateIf<StaffAccount>(
        USERS_SPEC,
        found.id,
        { passwordResetTokenHash: hash } as Partial<StaffAccount> as never,
        {
          passwordHash: nextPasswordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          authVersion: authVersionOf(before) + 1, // 기존 JWT 전부 무효(탈취 세션 차단)
          mustChangePassword: false,
        } as Partial<StaffAccount> as never,
      );
      if (!updated) throw invalid();
      await this.audit.log({
        entity: 'users',
        entityId: found.id,
        action: 'update',
        actorId: found.id,
        changes: {
          password: { before: '[redacted]', after: '[changed]' },
          authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 },
        },
        reason: '비밀번호 재설정(이메일 토큰)',
      });
      return toSafe(updated);
    });
  }

  // ── [TBO-31 C5 D9] 비로그인 복구 — 인라인 OTP판(링크판과 병존·마이페이지 메일 경로는 링크판 유지) ──

  /**
   * 아이디 찾기 완료 — verified recovery challenge를 일회 소비하고 해당 이메일의 active 계정
   * webId 목록을 반환한다(이메일 소유를 OTP로 증명한 본인에게만 노출 — 열거 아님). 계정이
   * 없어도 소비는 성립하고 빈 배열을 반환한다(호출부가 '계정 없음' 안내).
   */
  async completeRecoverIdOtp(challengeId: number, email: string): Promise<{ webIds: string[]; firstUserId: number | null }> {
    const canonical = email.trim().toLowerCase();
    return this.uow.run(async () => {
      await this.refreshFromDb();
      const accounts = this.db.findBy<StaffAccount>(USERS, (a) =>
        (a.email ?? '').trim().toLowerCase() === canonical && a.status === 'active',
      );
      const firstUserId = accounts[0]?.id ?? null;
      await this.signupChallenges.consumeForRecovery(challengeId, canonical, firstUserId);
      return { webIds: accounts.map((a) => a.webId), firstUserId };
    });
  }

  /**
   * 비밀번호 재설정(OTP판) — webId+이메일+verified recovery challenge 3중 일치 시만 변경.
   * 같은 tx에서 challenge 소비(updateIf CAS — 이중 소비 한쪽만 성공)·bcrypt 교체·
   * auth_version+1(기존 세션 전멸)·audit. 불일치는 소비 없이 400(재시도 여지 — 이메일
   * 소유 증명 후이므로 본인 계정 정보 이상의 노출이 없다).
   */
  async resetPasswordWithOtp(challengeId: number, webId: string, email: string, newPassword: string): Promise<SafeAccount> {
    const bytes = Buffer.byteLength(newPassword, 'utf8');
    if (bytes < 8) throw new BadRequestException('새 비밀번호는 8바이트 이상이어야 합니다.');
    if (bytes > 72) throw new BadRequestException('새 비밀번호는 72바이트 이하여야 합니다.');
    const canonical = email.trim().toLowerCase();
    const nextPasswordHash = await bcrypt.hash(newPassword, 12);
    return this.uow.run(async () => {
      await this.refreshFromDb();
      const acc = this.findByWebId(webId);
      if (!acc || acc.status !== 'active' || (acc.email ?? '').trim().toLowerCase() !== canonical) {
        throw new BadRequestException('아이디와 이메일이 일치하는 계정이 없습니다.');
      }
      await this.uow.lockTargets([{ kind: 'user', id: acc.id }]);
      await this.refreshFromDb();
      const before = this.findById(acc.id);
      if (!before || before.status !== 'active') throw new BadRequestException('아이디와 이메일이 일치하는 계정이 없습니다.');
      // challenge 소비를 같은 tx에 — 실패(미인증·만료·이중 소비) 시 비밀번호 변경까지 전체 롤백.
      await this.signupChallenges.consumeForRecovery(challengeId, canonical, acc.id);
      const updated = await this.store.update<StaffAccount>(USERS_SPEC, acc.id, {
        passwordHash: nextPasswordHash,
        passwordResetTokenHash: null, // 발급돼 있던 링크 토큰도 함께 무효(단일 경로 수렴)
        passwordResetExpiresAt: null,
        authVersion: authVersionOf(before) + 1, // 기존 JWT 전부 무효(탈취 세션 차단)
        mustChangePassword: false,
      } as Partial<StaffAccount> as never);
      if (!updated) throw new BadRequestException('아이디와 이메일이 일치하는 계정이 없습니다.');
      await this.audit.log({
        entity: 'users',
        entityId: acc.id,
        action: 'update',
        actorId: acc.id,
        changes: {
          password: { before: '[redacted]', after: '[changed]' },
          authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 },
        },
        reason: '비밀번호 재설정(이메일 OTP)',
      });
      return toSafe(updated);
    });
  }

  // [핫픽스 2026-07-20 대표 보고] 레거시 잔존 pending 계정(구 링크 가입 — SMTP 부재기에 인증 메일
  //  미발송) 구제 — 새 토큰 발급+재발송. 신규 가입은 OTP verified 생성이라 이 경로가 필요 없다.
  // [TBO-68 C3] 승인센터 표면(listPending·approve·reject·resend·delete·직접 등록) →
  //  signup-approval.service.ts 분리(본문 이동 — CAS·같은 tx·audit 규약 무변).

  // ── [유저 관리 2026-07-20 대표 지시] 상세 단건 + 대표 직접 수정 ────────────────

  /** 단건 상세 — super_admin에게만 rrnMasked 동봉(관리자는 기본 정보만). */
  async getUserDetail(id: number, requesterRole: string): Promise<StaffAccountSummary | StaffAccountDetail> {
    await this.refreshFromDb();
    const acc = requesterRole === 'super_admin'
      ? this.db.findById<StaffAccount>(USERS, id, { withDeleted: true })
      : this.findById(id);
    if (!acc) throw new NotFoundException(`계정 ${id} 없음`);
    const safe = toSafe(acc);
    return requesterRole === 'super_admin' ? { ...safe, rrnMasked: rrnMaskedOf(acc) } : safe; // [TBO-68 C3] 공유 함수(user.entity)
  }

  /**
   * 대표 직접 수정 — name/englishName/phone/email/role만(webId=profile-change 경로·학력=강사 프로필 권위).
   * 대상이 super_admin이면 400(단일 불변식 — 대표 본인은 마이페이지). role/email 변경은
   * auth_version+1(기존 세션 전멸 — 권한·수신처 변화). 전 변경 audit(before/after).
   */
  async adminUpdateUser(
    id: number,
    actorId: number,
    patch: { name?: string; englishName?: string; phone?: string; email?: string; role?: 'instructor' | 'manager' | 'admin'; keepTeaching?: boolean },
  ): Promise<SafeAccount> {
    await this.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }]);
      // 원부도 fresh read — role 전이(apply/keepTeaching)의 profiles.findActive가 메모리 판정이라
      //  교차 인스턴스 겸직 부여/해제를 봐야 한다(setTeaching·terminate와 동일 규약).
      await Promise.all([this.refreshFromDb(), this.profiles.hydrate()]);
      const before = this.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      if (before.role === 'super_admin') throw new BadRequestException('대표(super_admin) 계정은 여기서 수정할 수 없습니다(마이페이지 사용).');
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const next: Partial<StaffAccount> = {};
      if (patch.name != null && patch.name.trim() && patch.name.trim() !== before.name) {
        next.name = patch.name.trim();
        changes.name = { before: before.name, after: next.name };
      }
      if (patch.englishName !== undefined) {
        const englishName = requireStaffEnglishName(patch.englishName);
        if (englishName !== before.englishName) {
          next.englishName = englishName;
          changes.englishName = { before: before.englishName, after: englishName };
        }
      }
      if (patch.phone != null && patch.phone.trim() !== (before.phone ?? '')) {
        next.phone = patch.phone.trim() || null as never;
        changes.phone = { before: before.phone ?? null, after: next.phone };
      }
      let bumpAuth = false;
      if (patch.email != null) {
        const email = patch.email.trim().toLowerCase();
        if (email !== (before.email ?? '').trim().toLowerCase()) {
          const taken = this.db.findBy<StaffAccount>(USERS, (a) => a.id !== id && !!a.email && a.email.toLowerCase() === email).length > 0;
          if (taken) throw new BadRequestException('이미 사용 중인 이메일입니다.');
          next.email = email;
          // 대표 직접 변경 = 신원 확인 전제(직접 등록 관례) — verified 유지. 링크/OTP 재인증 불요.
          changes.email = { before: '[redacted]', after: '[changed]' }; // PII — audit에 원문 미기록
          bumpAuth = true;
        }
      }
      if (patch.role != null && patch.role !== before.role) {
        next.role = patch.role;
        changes.role = { before: before.role, after: patch.role };
        bumpAuth = true; // 권한 변화 — 세션 재발급 강제
      }
      if (!Object.keys(next).length) return toSafe(before);
      if (bumpAuth) next.authVersion = authVersionOf(before) + 1;
      if (next.role) {
        await this.roleTransitions.apply(before, next.role, actorId, { keepTeaching: patch.keepTeaching === true });
      }
      const updated = await this.store.update<StaffAccount>(USERS_SPEC, id, next as never);
      if (!updated) throw new NotFoundException(`계정 ${id} 없음`);
      await this.audit.log({
        entity: 'users', entityId: id, action: 'update', actorId,
        changes: { ...changes, ...(bumpAuth ? { authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 } } : {}) },
        reason: '대표 직접 수정(유저 관리)',
      });
      return toSafe(updated);
    });
  }

  /** [TBO-87 겸직] JWT roles 클레임 합성 — manager/admin이 활성 강사원부를 보유하면 'instructor' 동반 발급. */
  claimRolesOf(account: StaffAccount): string[] {
    return claimRolesFor(
      account,
      activeTeachingProfileUserIds(this.db.findAll<InstructorProfile>(INSTRUCTOR_PROFILES)),
    );
  }

  /** [TBO-87 겸직] 강사 활동 부여/해제 — 대표 sudo 전용. user lock + fresh-read + authVersion 증가
   *  (roles 클레임이 바뀌므로 기존 세션 즉시 무효)와 원부 전이·audit를 한 UoW로 처리한다. */
  async setTeaching(id: number, actorId: number, grant: boolean): Promise<SafeAccount> {
    await this.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }]);
      await Promise.all([this.refreshFromDb(), this.profiles.hydrate()]);
      const before = this.db.findById<StaffAccount>(USERS, id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      if (grant) await this.roleTransitions.grantTeaching(before, actorId);
      else await this.roleTransitions.revokeTeaching(before, actorId);
      const updated = await this.store.update<StaffAccount>(
        USERS_SPEC, id, { authVersion: authVersionOf(before) + 1 } as never);
      if (!updated) throw new NotFoundException(`계정 ${id} 없음`);
      await this.audit.log({
        entity: 'users', entityId: id, action: 'update', actorId,
        changes: {
          teaching: { before: grant ? '없음' : '겸직(강사 활동)', after: grant ? '겸직(강사 활동)' : '없음' },
          authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 },
        },
        reason: grant ? '강사 겸직 부여(대표)' : '강사 겸직 해제(대표)',
      });
      return toSafe(updated);
    });
  }

  async terminateUser(id: number, actorId: number, reason: string): Promise<SafeAccount> {
    await this.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }, { kind: 'user', id: actorId }]);
      // [SSOT 감사 2026-08-07] 원부 전이(deactivateForTermination)의 profiles.findActive는 메모리 판정 —
      //  교차 인스턴스 겸직 부여를 보려면 users와 함께 원부도 fresh read(setTeaching과 동일 규약).
      await Promise.all([this.refreshFromDb(), this.profiles.hydrate()]);
      const before = this.db.findById<StaffAccount>(USERS, id, { withDeleted: true });
      if (!before || before.deletedAt) throw new NotFoundException(`활성 계정 ${id} 없음`);
      if (id === actorId) throw new BadRequestException('현재 로그인한 본인 계정은 종료할 수 없습니다.');
      if (before.role === 'super_admin') throw new BadRequestException('대표 계정은 종료할 수 없습니다.');
      if (before.status !== 'active') throw new BadRequestException('활성 계정만 종료할 수 있습니다.');

      await this.roleTransitions.deactivateForTermination(before, actorId);
      const versioned = await this.store.updateIf<StaffAccount>(
        USERS_SPEC,
        id,
        { status: 'active', authVersion: authVersionOf(before) },
        { authVersion: authVersionOf(before) + 1 },
      );
      if (!versioned) throw new ConflictException('계정 상태가 변경되었습니다. 다시 조회해 주세요.');
      if (!(await this.store.remove(USERS_SPEC, id, actorId))) {
        throw new ConflictException('계정 상태가 변경되었습니다. 다시 조회해 주세요.');
      }
      const after = this.db.findById<StaffAccount>(USERS, id, { withDeleted: true });
      if (!after?.deletedAt) throw new Error(`user ${id} termination did not persist`);
      await this.audit.log({
        entity: 'users',
        entityId: id,
        action: 'delete',
        actorId,
        changes: {
          authVersion: { before: authVersionOf(before), after: authVersionOf(before) + 1 },
          deletedAt: { before: null, after: after.deletedAt },
        },
        reason: reason.trim(),
      });
      return toSafe(after);
    });
  }

  async restoreUser(id: number, actorId: number, reason: string): Promise<SafeAccount> {
    await this.refreshFromDb();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }, { kind: 'user', id: actorId }]);
      await Promise.all([this.refreshFromDb(), this.profiles.hydrate()]); // 원부 복구 전이 fresh read

      const before = this.db.findById<StaffAccount>(USERS, id, { withDeleted: true });
      if (!before?.deletedAt) throw new NotFoundException(`종료된 계정 ${id} 없음`);
      if (before.role === 'super_admin') throw new BadRequestException('대표 계정은 이 경로로 복구할 수 없습니다.');
      if (before.status !== 'active') throw new BadRequestException('가입 대기·반려 계정은 복구할 수 없습니다.');

      const nextVersion = authVersionOf(before) + 1;
      const restored = await this.store.restore<StaffAccount>(USERS_SPEC, id, {
        authVersion: nextVersion,
      });
      if (!restored) throw new ConflictException('계정 상태가 변경되었습니다. 다시 조회해 주세요.');
      await this.roleTransitions.activateForRestore(restored, actorId);
      await this.audit.log({
        entity: 'users',
        entityId: id,
        action: 'status_change',
        actorId,
        changes: {
          authVersion: { before: authVersionOf(before), after: nextVersion },
          deletedAt: { before: before.deletedAt, after: null },
        },
        reason: reason.trim(),
      });
      return toSafe(restored);
    });
  }

  checkWebId(webId: string): WebIdCheckResult {
    const acc = this.findByWebId(webId);
    return acc ? { webId, exists: true, name: acc.name, role: acc.role } : { webId, exists: false };
  }
}
