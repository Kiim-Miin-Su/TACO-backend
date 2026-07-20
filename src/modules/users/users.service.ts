// [참조/처리] 직원 계정 서비스 — InMemoryDatabase 'users' 컬렉션(단일 자산) 기반.
//  가입(pending) → 이메일 인증 → 대표 승인(active) 라이프사이클의 모든 상태 변화가 db에 기록된다.
//  [자산화 점검 2026-07-02] 서비스 로컬 배열(this.accounts) → db.seed/insert/update 이관.
//  [TBO-28B 2026-07-14] 승인 = **단일 트랜잭션**(users CAS + instructor_profiles + audit_log),
//   verification token = sha256 hash + 48h 만료(성공 시 명시 NULL), demo seed = production 전면 금지.
import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import type { WebIdCheckResult } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { maskTarget } from '../profile-verifications/profile-verification.entity'; // [E0.5 ⑥] audit 마스킹
import {
  RRN_FORMAT_MESSAGE, birthYearFromRrn, decryptRrn, encryptRrn, maskRrn, normalizeRrn, validateRrnFormat,
} from '../../common/rrn-crypto.util'; // [TBO-31 C1 D2]
import { SignupEmailChallengesService } from '../auth/signup-email-challenges.service'; // [TBO-31 C1 D1]
import { InstructorProfilesStore } from './instructor-profiles.store';
import {
  USERS, authVersionOf, isStaffRole, toSafe,
  type AccountStatus, type SafeAccount, type StaffAccount, type StaffRole,
} from './user.entity';

// 하위 호환 재노출(외부 소비처가 users.service 경유로 import하던 심볼)
export { isStaffRole, toAccount, toSafe } from './user.entity';
export type { AccountStatus, SafeAccount, StaffAccount, StaffRole } from './user.entity';

// 데모 시드 — 운영 계정(이미 활성·이메일 인증 완료). 비밀번호: 'demo1234'.
//  [TBO-28B] production에서는 어떤 경로로도 시드되지 않는다(§4-d fail-fast 계약).
//  해시는 지연 계산(운영 부팅에서 bcrypt 비용·데모 해시 자체를 만들지 않음).
let demoPwHash: string | undefined;
const DEMO_PW = (): string => (demoPwHash ??= bcrypt.hashSync('demo1234', 12));

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
// [E0] export — 프로필 변경 요청(webId 승인제)의 잠금이 즉시 변경 경로와 같은 lock id를 쓴다
//  (case-insensitive 동시 선점을 한 직렬화 지점에서 판정 — TBO-29B 규약 유지).
export const identityLockId = (webId: string): number => Number.parseInt(sha256(webId.trim().toLowerCase()).slice(0, 7), 16);

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly profiles: InstructorProfilesStore,
    // [TBO-31 C1 D1] 가입 tx에서 이메일 OTP challenge를 일회 소비 — Users↔Auth 기존 forwardRef 순환 위.
    @Inject(forwardRef(() => SignupEmailChallengesService))
    private readonly signupChallenges: SignupEmailChallengesService,
  ) {}

  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<StaffAccount>(USERS_SPEC);

    // [TBO-28B §4-d] production: demo seed 전면 금지. 빈 DB는 INITIAL_ADMIN_* 부트스트랩(없으면 부팅 차단 —
    //  로그인 불능 배포 방지). prof_admin 자동 재삽입(ensureDefaultAdminAccount)도 production 금지.
    if (isProduction()) {
      if (!hydrated.length) await this.bootstrapInitialAdmin();
      return;
    }

    if (hydrated.length) {
      await this.ensureDefaultAdminAccount();
      return;
    }
    await this.store.seed<StaffAccount>(USERS_SPEC, [
      // [강사 식별자 통일 2026-07-07] users.id 자체가 강사 식별자다(별도 instructorId 브리지 폐기).
      //  courses/class_sessions/payouts/reports/availability/counsel의 instructorId·assignedStaffId가 이 id를 참조.
      //  강사 = id 1·2, 대표/매니저 = 3·4. (정유진은 우선 데모 계정 — 실제 강사는 추후 계정 발급)
      { id: 1, webId: 'park_inst', name: '박지훈', email: 'park@tnacademy.test', role: 'instructor', status: 'active', passwordHash: DEMO_PW(), emailVerified: true, authVersion: 1, profileVersion: 1, mustChangePassword: false, countryCode: 'KR', timeZone: 'Asia/Seoul' },
      { id: 2, webId: 'jung_inst', name: '정유진', email: 'jung@tnacademy.test', role: 'instructor', status: 'active', passwordHash: DEMO_PW(), emailVerified: true, authVersion: 1, profileVersion: 1, mustChangePassword: false, countryCode: 'GB', timeZone: 'Europe/London' },
      { id: 3, webId: 'admin', name: '김민수', email: 'admin@tnacademy.test', role: 'super_admin', status: 'active', passwordHash: DEMO_PW(), emailVerified: true, authVersion: 1, profileVersion: 1, mustChangePassword: false },
      { id: 4, webId: 'manager', name: '이지원', email: 'manager@tnacademy.test', role: 'manager', status: 'active', passwordHash: DEMO_PW(), emailVerified: true, authVersion: 1, profileVersion: 1, mustChangePassword: false },
      { id: 5, webId: 'prof_admin', name: '한서윤', email: 'prof.admin@tnacademy.test', role: 'admin', status: 'active', passwordHash: DEMO_PW(), emailVerified: true, authVersion: 1, profileVersion: 1, mustChangePassword: false },
    ]);
    // 데모 시드된 활성 강사는 프로필도 동반(승인 경로와 동일 불변식: active instructor ↔ active profile 1행).
    for (const inst of this.db.findBy<StaffAccount>(USERS, (u) => u.role === 'instructor' && u.status === 'active')) {
      if (!this.profiles.findActive(inst.id)) await this.profiles.upsertActive(inst.id, 3, new Date().toISOString());
    }
  }

  /** production 최초 관리자 부트스트랩. 첫 로그인에서 아이디와 비밀번호를 모두 교체한다. */
  private async bootstrapInitialAdmin(): Promise<void> {
    const webId = process.env.INITIAL_ADMIN_WEB_ID?.trim();
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (!webId || !password || password.length < 8) {
      throw new Error(
        '[users] production 빈 DB — INITIAL_ADMIN_WEB_ID/INITIAL_ADMIN_PASSWORD(8자+)가 필요합니다. ' +
        '데모 시드는 production에서 금지됩니다(로그인 불능 배포 방지 fail-fast).',
      );
    }
    await this.store.insert<StaffAccount>(USERS_SPEC, {
      webId,
      name: process.env.INITIAL_ADMIN_NAME?.trim() || '대표',
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

  private async ensureDefaultAdminAccount(): Promise<void> {
    if (this.findByWebId('prof_admin')) return;
    await this.store.insert<StaffAccount>(USERS_SPEC, {
      webId: 'prof_admin',
      name: '한서윤',
      email: 'prof.admin@tnacademy.test',
      role: 'admin',
      status: 'active',
      passwordHash: DEMO_PW(),
      emailVerified: true,
      authVersion: 1,
      profileVersion: 1,
      mustChangePassword: false,
    });
  }

  // [TBO-28F 2026-07-14] 교차 인스턴스 정합 — users 메모리 투영을 권위 DB에서 재조회.
  //  두 인스턴스 실증에서 발견: A에서 signup/approve된 계정이 B의 로그인·대기목록·리소스에 안 보였다
  //  (schedule 계열만 per-request 재조회했음). 인증/승인 오퍼레이션 진입 시 이 함수를 먼저 부른다.
  //  in-memory 모드에서는 no-op(hydrate가 빈 배열 반환·메모리가 곧 권위).
  async refreshFromDb(): Promise<void> {
    await this.store.hydrate<StaffAccount>(USERS_SPEC);
    await this.profiles.hydrate();
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

  // 가입 신청 — 직원 역할만 요청 가능(super_admin 자가신청 불가). 상태=pending.
  //  [TBO-31 C1 D1] 가입 전 이메일 OTP(emailChallengeId)를 **같은 uow tx에서 일회 소비**하고
  //  계정을 emailVerified=true로 생성한다(48h 링크 토큰 발급·메일 경로는 신규 가입에서 제거 —
  //  GET /auth/verify-email은 잔존 pending 계정 호환으로만 남는다). 소비 실패 시 계정 insert까지 롤백.
  //  [TBO-31 C1 D2] rrn 필수 — 암호문(rrn_encrypted)만 저장, birthYear는 파생 저장. 평문은
  //  응답·로그·audit 어디에도 기록하지 않는다.
  async signup(input: {
    webId: string; name: string; email: string; password: string; role?: string;
    rrn: string; emailChallengeId: number;
    // [E0.5 ④b] 대표 기대 필드 — 승인 판단 근거(승인센터 상세 표시 → 승인 tx에서 프로필 승계).
    phone?: string; university?: string; major?: string;
  }): Promise<{ account: SafeAccount }> {
    await this.refreshFromDb(); // [28F] 교차 인스턴스 중복 검사 정합
    const webId = input.webId.trim();
    const email = input.email.trim().toLowerCase();
    const role: StaffRole = input.role && isStaffRole(input.role) && input.role !== 'super_admin' ? input.role : 'instructor';
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    // [D2] 형식(정규식+MMDD)만 검증 — 체크섬 검증은 하지 않는다(2020-10 폐지, rrn-crypto.util 주석).
    if (!validateRrnFormat(input.rrn)) throw new BadRequestException(RRN_FORMAT_MESSAGE);
    const rrnCanonical = normalizeRrn(input.rrn); // 하이픈 포함 형태로 통일 저장
    const rrnEncrypted = encryptRrn(rrnCanonical);
    const birthYear = birthYearFromRrn(rrnCanonical); // 파생 저장 — 기존 승계·표시 소비처 무파괴
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (this.db.findBy<StaffAccount>(USERS, (a) => !!a.email && a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');

    const passwordHash = await bcrypt.hash(input.password, 12) // [보안 2026-07-03] cost 12;
    // [M1] await(hash) 사이에 동일 webId/email 가입이 끼어들 수 있음(TOCTOU) — insert 직전 동기 재검증
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (this.db.findBy<StaffAccount>(USERS, (a) => !!a.email && a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');
    return this.uow.run(async () => {
    const acc = await this.store.insert<StaffAccount>(USERS_SPEC, {
      webId, name: input.name.trim(), email, role,
      status: 'pending', passwordHash,
      // [D1] 가입 전 OTP로 이메일 소유 실증 완료 — verified 생성, 링크 토큰 컬럼은 처음부터 null.
      emailVerified: true,
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
      authVersion: 1,
      profileVersion: 1,
      mustChangePassword: false,
      // [E0.5 ④b] 지원자 제공 정보 — 승인센터 상세에 노출, 승인 tx에서 instructor_profiles 승계.
      phone: input.phone?.trim() || null,
      university: input.university?.trim() || null,
      major: input.major?.trim() || null,
      birthYear,
      rrnEncrypted,
    });
    // [D1] challenge 소비 — verified·이메일 일치·미소비 검증. 실패 예외 → 계정 insert까지 롤백.
    await this.signupChallenges.consumeForSignup(input.emailChallengeId, email, acc.id);
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
      name?: string; email?: string; phone?: string;
      countryCode?: string; timeZone?: string; university?: string; major?: string; birthYear?: number;
    },
  ): Promise<SafeAccount> {
    const newWebId = input.newWebId?.trim();
    const newPassword = input.newPassword;
    const newName = input.name?.trim();
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
      const wantsProfile = newName !== undefined || newEmail !== undefined || newPhone !== undefined
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

  async listPending(): Promise<Array<SafeAccount & { rrnMasked: string | null }>> {
    await this.refreshFromDb(); // [28F] 다른 인스턴스의 신규 가입이 대표 대기목록에 즉시 반영
    // [TBO-31 C1 D2] 승인 판단 근거로 rrnMasked('950101-1******')만 노출 — 평문·암호문은 응답에 없다.
    //  birthYear(파생값)는 SafeAccount에 그대로 유지(기존 승인센터 표시 소비처).
    return this.db.findBy<StaffAccount>(USERS, (a) => a.status === 'pending').map((a) => ({
      ...toSafe(a),
      rrnMasked: this.rrnMaskedOf(a),
    }));
  }

  /** 마스킹 산출(서버 내부 복호화) — 복호 실패(키 교체·구 데이터)는 노출 대신 null(fail-closed). */
  private rrnMaskedOf(account: StaffAccount): string | null {
    if (!account.rrnEncrypted) return null;
    try {
      return maskRrn(decryptRrn(account.rrnEncrypted));
    } catch {
      return null;
    }
  }

  // ── [TBO-28B] 승인/반려 — 원자적 승인 command ────────────────────────────────
  //  · actor = 검증된 JWT sub만(바디 위조 불가 — 불변식 §5-4). reason은 audit_log에 남는다.
  //  · CAS(조건부 update: status='pending')로 동시 approve/approve·approve/reject 중 **한 command만 성공**(나머지 409).
  //  · users + instructor_profiles + audit_log가 **같은 트랜잭션**(CalendarUnitOfWork: 메모리 스냅샷 ⊃ pg tx).
  //  · auth_version +1 → 상태/역할 변경 즉시 기존 JWT 무효(AccountStateService 대조).

  async approve(id: number, actorId: number, role?: string, reason?: string): Promise<SafeAccount> {
    await this.refreshFromDb(); // [28F] 사전 조회(authVersion 등) 정합 — 최종 판정은 CAS가 권위
    // [대표 지시 2026-07-16] super_admin 단일 계정 불변식 — 승인으로 super_admin을 만들 수 없다
    //  (종전엔 조용히 기존 role로 폴백 — 명시 400으로 교체. 유일한 super_admin 경로는 bootstrap-ceo).
    if (role === 'super_admin') throw new BadRequestException('super_admin은 단일 계정입니다 — 승인으로 부여할 수 없습니다.');
    return this.uow.run(async () => {
      const before = this.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      const finalRole: StaffRole = role && isStaffRole(role) && role !== 'super_admin' ? role : before.role;
      const approvedAt = new Date().toISOString();
      const updated = await this.store.updateIf<StaffAccount>(
        USERS_SPEC, id,
        { status: 'pending', emailVerified: true },
        {
          status: 'active', role: finalRole,
          approvedBy: actorId, approvedAt,
          authVersion: authVersionOf(before) + 1,
        },
      );
      if (!updated) {
        const cur = this.findById(id);
        if (cur && !cur.emailVerified) throw new ForbiddenException('이메일 인증이 완료되지 않은 계정은 승인할 수 없습니다.');
        throw new ConflictException('이미 처리된 계정입니다(대기 상태가 아님).');
      }
      // 불변식: active instructor ↔ active instructor_profiles 정확 1행.
      // [E0.5 ④b] 가입 폼 제공 정보(대학·전공·출생연도)를 같은 tx에서 프로필로 승계(COALESCE upsert).
      if (updated.role === 'instructor') {
        await this.profiles.upsertActive(id, actorId, approvedAt, {
          university: updated.university ?? null,
          major: updated.major ?? null,
          birthYear: updated.birthYear ?? null,
        });
      }
      await this.audit.log({
        entity: 'users', entityId: id, action: 'approve', actorId,
        changes: {
          status: { before: 'pending', after: 'active' },
          ...(finalRole !== before.role ? { role: { before: before.role, after: finalRole } } : {}),
        },
        reason,
      });
      return toSafe(updated);
    });
  }

  // ── [운영 흐름 2026-07-14 대표 공지] 강사 직접 등록 — 대표가 받은 정보(이름·나이·대학교·전공·전화·아이디·비번)로
  //  즉시 active 계정 생성(가입승인 흐름과 동일 기계: users + instructor_profiles + audit 단일 tx).
  //  이메일 인증 생략(직접 신원 확인 전제). 학생·수업 추가는 기존 웹 화면 흐름.
  async provisionInstructor(
    input: {
      webId: string; name: string; password: string;
      email?: string; phone?: string; university?: string; major?: string; birthYear?: number;
      countryCode?: string; timeZone?: string;
    },
    actorId: number,
  ): Promise<SafeAccount> {
    await this.refreshFromDb(); // [28F] 교차 인스턴스 중복 검사 정합
    const webId = input.webId.trim();
    const email = input.email?.trim().toLowerCase() || null;
    if (webId.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    if (input.password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.');
    if (email && this.db.findBy<StaffAccount>(USERS, (a) => !!a.email && a.email.toLowerCase() === email).length)
      throw new BadRequestException('이미 사용 중인 이메일입니다.');
    const passwordHash = await bcrypt.hash(input.password, 12);
    if (this.findByWebId(webId)) throw new BadRequestException('이미 사용 중인 아이디입니다.'); // [M1] TOCTOU 재검증
    return this.uow.run(async () => {
      const approvedAt = new Date().toISOString();
      const acc = await this.store.insert<StaffAccount>(USERS_SPEC, {
        webId, name: input.name.trim(), email, phone: input.phone?.trim() || null,
        role: 'instructor', status: 'active', passwordHash,
        emailVerified: true, // 직접 등록 — 인증 게이트 생략(로그인 게이트 통과용)
        approvedBy: actorId, approvedAt, authVersion: 1,
        profileVersion: 1,
        countryCode: input.countryCode, timeZone: input.timeZone,
      });
      await this.profiles.upsertActive(acc.id, actorId, approvedAt, {
        university: input.university?.trim() || null,
        major: input.major?.trim() || null,
        birthYear: input.birthYear ?? null,
      });
      await this.audit.log({
        entity: 'users', entityId: acc.id, action: 'create', actorId,
        changes: { status: { after: 'active' }, role: { after: 'instructor' } },
        reason: '대표 직접 등록(강사)',
      });
      return toSafe(acc);
    });
  }

  async reject(id: number, actorId: number, reason: string): Promise<SafeAccount> {
    await this.refreshFromDb(); // [28F]
    return this.uow.run(async () => {
      const before = this.findById(id);
      if (!before) throw new NotFoundException(`계정 ${id} 없음`);
      const updated = await this.store.updateIf<StaffAccount>(
        USERS_SPEC, id,
        { status: 'pending' },
        { status: 'rejected', authVersion: authVersionOf(before) + 1 },
      );
      if (!updated) throw new ConflictException('이미 처리된 계정입니다(대기 상태가 아님).');
      await this.audit.log({
        entity: 'users', entityId: id, action: 'reject', actorId,
        changes: { status: { before: 'pending', after: 'rejected' } },
        reason,
      });
      return toSafe(updated);
    });
  }

  /** @deprecated [TBO-28B] approve/reject로 대체 — actor/audit/tx 없는 직접 상태 변경 금지. */
  async setStatus(_id: number, status: AccountStatus, _role?: string): Promise<SafeAccount> {
    throw new BadRequestException(
      status === 'active' ? 'approve()를 사용하세요(actor/audit/tx 필수).' : 'reject()를 사용하세요(actor/reason 필수).',
    );
  }

  checkWebId(webId: string): WebIdCheckResult {
    const acc = this.findByWebId(webId);
    return acc ? { webId, exists: true, name: acc.name, role: acc.role } : { webId, exists: false };
  }
}
