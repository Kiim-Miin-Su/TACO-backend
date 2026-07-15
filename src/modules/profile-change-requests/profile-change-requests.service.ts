import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PROFILE_CHANGE_REQUESTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service';
import { hasAdminRole } from '../auth/roles.decorator';
import { USERS, profileVersionOf, type StaffAccount } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { ProfileVerificationsService } from '../profile-verifications/profile-verifications.service';
import { maskTarget } from '../profile-verifications/profile-verification.entity';
import { CountriesService } from '../catalog/countries.service';
import { CreateProfileChangeRequestDto } from './dto/create-profile-change-request.dto';
import {
  CONTACT_CHANGE_FIELDS,
  PROFILE_CHANGE_REQUESTS,
  type ProfileChangeRequest,
  type ProfileChanges,
} from './profile-change-request.entity';

@Injectable()
export class ProfileChangeRequestsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly verifications: ProfileVerificationsService,
    private readonly countries: CountriesService, // [E0.5 ④] 국가·시간대 카탈로그 검증
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC);
  }

  async create(requesterId: number, dto: CreateProfileChangeRequestDto): Promise<ProfileChangeRequest> {
    const reason = this.requiredReason(dto.reason, '변경 사유');
    await this.refresh();
    const created = await this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id: requesterId },
        ...(dto.verificationChallengeId != null
          ? [{ kind: 'verificationChallenge' as const, id: dto.verificationChallengeId }]
          : []),
      ]);
      await this.refresh();
      const requester = this.users.findById(requesterId);
      if (!requester) throw new NotFoundException(`계정 ${requesterId} 없음`);
      // [TBO-29B-4 §2] 모든 마이 페이지 변경은 현재 비밀번호 재확인.
      if (!(await this.users.validatePassword(requester, dto.currentPassword))) {
        throw new ForbiddenException('현재 비밀번호가 올바르지 않습니다.');
      }
      if (this.pendingFor(requesterId)) throw new ConflictException('이미 처리 중인 프로필 변경 요청이 있습니다.');

      const requestedChanges = this.normalizeChanges(dto);
      const actualChanges = this.changedOnly(requester, requestedChanges);
      if (!Object.keys(actualChanges).length) throw new BadRequestException('현재 프로필과 다른 변경 항목이 필요합니다.');

      // [TBO-29B-4 §5] 연락처 변경 규칙: 채널당 challenge 1건 — email·phone 동시 변경 금지,
      //  값 설정은 verified challenge 필수 + canonical 값 일치 + 발송 전/승인 시 중복 재검사.
      const contact = this.contactChangeOf(actualChanges);
      if (contact) this.verifications.assertTargetAvailable(contact.channel, contact.target, requesterId);

      const beforeValues = Object.fromEntries(
        Object.keys(actualChanges).map((field) => [field, this.profileValue(requester, field)]),
      ) as ProfileChanges;

      try {
        const row = await this.store.insert<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
          requesterId,
          baseProfileVersion: profileVersionOf(requester),
          beforeValues,
          requestedChanges: actualChanges,
          reason,
          status: 'pending',
          decidedBy: null,
          decidedAt: null,
          rejectionReason: null,
          appliedProfileVersion: null,
          verificationChallengeId: contact ? dto.verificationChallengeId ?? null : null,
        });
        // challenge 소비는 요청 생성과 **같은 tx** — 소비 실패(만료/불일치/이중 소비) 시 요청까지 롤백(§5).
        //  [2026-07-15 SMS 추후 구현] 휴대전화 인증은 SMS provider(NCP SENS/Twilio) 설정이 있을 때만
        //  필수 — 미설정(현 시범운영)이면 형식 검증+관리자 승인으로만 처리하고, provider env가
        //  들어오는 즉시 인증 필수가 자동 복원된다(FE 스테퍼 복원은 lib/domain/profile.ts 참조).
        if (contact) {
          const challengeRequired = contact.channel === 'email' || this.smsChallengeAvailable();
          if (challengeRequired && dto.verificationChallengeId == null) {
            throw new BadRequestException('연락처 변경에는 완료된 인증(verificationChallengeId)이 필요합니다.');
          }
          if (dto.verificationChallengeId != null) {
            await this.verifications.consumeForRequest(dto.verificationChallengeId, requesterId, row.id, contact);
          }
        }
        await this.audit.log({
          entity: PROFILE_CHANGE_REQUESTS,
          entityId: row.id,
          action: 'create',
          actorId: requesterId,
          changes: {
            status: { after: 'pending' },
            requestedChanges: { after: this.maskChanges(actualChanges) }, // [§5] audit에는 masked만
            baseProfileVersion: { after: row.baseProfileVersion },
          },
          reason: reason.slice(0, 200),
        });
        // [E0.5 ① 2026-07-15] 대표(super_admin)는 '자기 결정 금지' 규칙의 명시 예외 — 최상위
        //  결정권자라 자기 프로필을 승인해 줄 상급자가 없다. 요청 행·create/approve audit는
        //  일반 경로와 동일하게 남기고(추적성 보존), **같은 tx**에서 즉시 적용한다
        //  (적용 실패 시 요청 생성까지 롤백 — 부분 상태 없음). admin(교수부장) 이하는 종전대로 승인제.
        if (requester.role === 'super_admin') {
          return this.applyApprovedInTx(row, requesterId, `프로필 변경 요청 #${row.id} 즉시 적용(대표)`);
        }
        return row;
      } catch (error) {
        if (this.errorCode(error) === '23505') {
          throw new ConflictException('이미 처리 중인 프로필 변경 요청이 있습니다.');
        }
        throw error;
      }
    });
    return this.maskRequest(created);
  }

  async mine(requesterId: number): Promise<ProfileChangeRequest[]> {
    const rows = await this.store.findActive<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
      where: { requesterId },
      orderBy: { field: 'id', direction: 'DESC' },
    });
    return rows.map((row) => this.maskRequest(row));
  }

  async list(): Promise<ProfileChangeRequest[]> {
    const rows = await this.store.findActive<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
      orderBy: { field: 'id', direction: 'DESC' },
    });
    return rows.map((row) => this.maskRequest(row));
  }

  async detail(id: number, actorId: number, roles?: string[]): Promise<ProfileChangeRequest> {
    const row = await this.findAuthoritative(id);
    if (row.requesterId !== actorId && !hasAdminRole(roles)) {
      throw new ForbiddenException('본인의 프로필 변경 요청만 조회할 수 있습니다.');
    }
    return this.maskRequest(row);
  }

  approve(id: number, actorId: number): Promise<ProfileChangeRequest> {
    return this.decide(id, actorId, 'approved');
  }

  reject(id: number, actorId: number, reason: string): Promise<ProfileChangeRequest> {
    return this.decide(id, actorId, 'rejected', this.requiredReason(reason, '반려 사유'));
  }

  private async decide(
    id: number,
    actorId: number,
    status: 'approved' | 'rejected',
    decisionReason?: string,
  ): Promise<ProfileChangeRequest> {
    const initial = await this.findAuthoritative(id);
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id: initial.requesterId },
        { kind: 'profileRequest', id },
      ]);
      await this.refresh();
      const request = this.db.findById<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS, id);
      if (!request) throw new NotFoundException(`프로필 변경 요청 ${id} 없음`);
      if (request.requesterId !== initial.requesterId) throw new ConflictException('요청자 정보가 변경되었습니다.');
      if (request.requesterId === actorId) throw new ForbiddenException('본인의 프로필 변경 요청은 본인이 처리할 수 없습니다.');
      if (request.status !== 'pending') throw new ConflictException('이미 처리된 프로필 변경 요청입니다.');

      if (status === 'approved') {
        const applied = await this.applyApprovedInTx(request, actorId, `프로필 변경 요청 #${id} 승인`);
        return this.maskRequest(applied);
      }

      const decided = await this.store.updateIf<ProfileChangeRequest>(
        PROFILE_CHANGE_REQUESTS_SPEC,
        id,
        { status: 'pending', baseProfileVersion: request.baseProfileVersion },
        {
          status: 'rejected',
          decidedBy: actorId,
          decidedAt: new Date().toISOString(),
          rejectionReason: decisionReason ?? null,
          appliedProfileVersion: null,
        },
      );
      if (!decided) throw new ConflictException('이미 처리된 프로필 변경 요청입니다.');

      await this.audit.log({
        entity: PROFILE_CHANGE_REQUESTS,
        entityId: id,
        action: 'reject',
        actorId,
        changes: {
          status: { before: 'pending', after: 'rejected' },
          rejectionReason: { after: decisionReason },
        },
        reason: decisionReason?.slice(0, 200),
      });
      return this.maskRequest(decided);
    });
  }

  /** [E0.5 ①] 승인 적용 공통 경로 — decide(관리자 결정)와 create(super_admin 즉시 적용)가 공유.
   *  전제: 호출자가 같은 uow tx 안에서 user·해당 요청 잠금을 보유하고 request.status === 'pending'.
   *  users CAS(profileVersion)·masked audit 2건(users update + request approve)·요청 행 확정을 원자로 수행. */
  private async applyApprovedInTx(
    request: ProfileChangeRequest,
    actorId: number,
    decisionReason: string,
  ): Promise<ProfileChangeRequest> {
    const beforeLive = this.users.findById(request.requesterId);
    if (!beforeLive) throw new NotFoundException(`계정 ${request.requesterId} 없음`);
    // [29B-4 수정] 메모리 모드에서 updateIf가 행을 in-place 변경 → 라이브 참조로 diff하면 항상 빈 diff.
    //  스냅샷으로 before를 고정한다(users update audit에 실제 변경 내용이 남도록).
    const before = { ...beforeLive };
    if (before.status !== 'active') throw new ConflictException('활성 계정의 프로필만 변경할 수 있습니다.');
    const currentVersion = profileVersionOf(before);
    if (request.baseProfileVersion !== currentVersion) {
      throw new ConflictException('프로필이 요청 이후 변경되어 처리할 수 없습니다.');
    }

    // [TBO-29B-4 §5] 승인 시 연락처 uniqueness 재검사 — 가입/다른 변경이 먼저 점유했으면 409(요청은 pending 유지).
    const contact = this.contactChangeOf(request.requestedChanges);
    if (contact) this.verifications.assertTargetAvailable(contact.channel, contact.target, request.requesterId);

    const changes: Record<string, { before?: unknown; after?: unknown }> = {
      status: { before: 'pending', after: 'approved' },
    };
    const masked = this.maskChanges(request.requestedChanges);
    for (const field of Object.keys(request.requestedChanges)) {
      changes[field] = {
        before: this.maskFieldValue(field, (before as unknown as Record<string, unknown>)[field]),
        after: (masked as Record<string, unknown>)[field],
      };
    }
    changes.profileVersion = { before: currentVersion, after: currentVersion + 1 };
    const updated = await this.store.updateIf<StaffAccount>(
      USERS_SPEC,
      before.id,
      { profileVersion: currentVersion },
      { ...request.requestedChanges, profileVersion: currentVersion + 1 },
    );
    if (!updated) throw new ConflictException('프로필이 요청 이후 변경되어 처리할 수 없습니다.');
    await this.audit.log({
      entity: USERS,
      entityId: before.id,
      action: 'update',
      actorId,
      changes: this.maskDiff(this.audit.diffOf(before, updated)), // [§5] audit masked
      reason: decisionReason,
    });

    const decided = await this.store.updateIf<ProfileChangeRequest>(
      PROFILE_CHANGE_REQUESTS_SPEC,
      request.id,
      { status: 'pending', baseProfileVersion: request.baseProfileVersion },
      {
        status: 'approved',
        decidedBy: actorId,
        decidedAt: new Date().toISOString(),
        rejectionReason: null,
        appliedProfileVersion: currentVersion + 1,
      },
    );
    if (!decided) throw new ConflictException('이미 처리된 프로필 변경 요청입니다.');

    await this.audit.log({
      entity: PROFILE_CHANGE_REQUESTS,
      entityId: request.id,
      action: 'approve',
      actorId,
      changes,
      reason: decisionReason,
    });
    return decided;
  }

  private async findAuthoritative(id: number): Promise<ProfileChangeRequest> {
    const [row] = await this.store.findActive<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, { where: { id } });
    if (!row) throw new NotFoundException(`프로필 변경 요청 ${id} 없음`);
    return row;
  }

  private async refresh(): Promise<void> {
    await this.users.refreshFromDb();
    await this.store.hydrate<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC);
  }

  private pendingFor(requesterId: number): ProfileChangeRequest | undefined {
    return this.db.findBy<ProfileChangeRequest>(
      PROFILE_CHANGE_REQUESTS,
      (request) => request.requesterId === requesterId && request.status === 'pending',
    )[0];
  }

  /** SMS 인증 가능 여부 — provider(NCP SENS 4종 또는 Twilio 3종) env가 완비된 경우만 true.
   *  미설정이면 phone 변경은 challenge 없이 접수(중복 연락처 검사·형식 정규화·승인 경로는 유지). */
  private smsChallengeAvailable(): boolean {
    const sens = process.env.NCP_SENS_ACCESS_KEY && process.env.NCP_SENS_SECRET_KEY
      && process.env.NCP_SENS_SERVICE_ID && process.env.NCP_SENS_FROM;
    const twilio = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID;
    return Boolean(sens || twilio);
  }

  /** [TBO-29B-4] 인증 필요 연락처 변경(값 설정) 추출 — email·phone 동시 변경은 400(채널당 challenge 1건). */
  private contactChangeOf(changes: ProfileChanges): { channel: 'email' | 'sms'; target: string } | null {
    const email = changes.email;
    const phone = changes.phone;
    if (email != null && phone != null) {
      throw new BadRequestException('이메일과 휴대전화는 한 번에 하나씩 변경할 수 있습니다(각각 인증 필요).');
    }
    if (email != null) return { channel: 'email', target: email };
    if (phone != null) return { channel: 'sms', target: phone };
    return null; // phone null(삭제)·비연락처 필드는 인증 불요(비밀번호 재확인만)
  }

  /** [§5] API 목록·audit 노출용 마스킹 — DB 원본(업무 자산)은 그대로 둔다. */
  private maskFieldValue(field: string, value: unknown): unknown {
    if (value == null || typeof value !== 'string') return value;
    if (field === 'email') return maskTarget('email', value);
    if (field === 'phone') return maskTarget('sms', value);
    return value;
  }

  private maskChanges(changes: ProfileChanges): ProfileChanges {
    return Object.fromEntries(
      Object.entries(changes).map(([field, value]) => [field, this.maskFieldValue(field, value)]),
    ) as ProfileChanges;
  }

  private maskDiff(diff: Record<string, { before?: unknown; after?: unknown }>): Record<string, { before?: unknown; after?: unknown }> {
    return Object.fromEntries(
      Object.entries(diff).map(([field, entry]) => [field, {
        ...(entry.before !== undefined ? { before: this.maskFieldValue(field, entry.before) } : {}),
        ...(entry.after !== undefined ? { after: this.maskFieldValue(field, entry.after) } : {}),
      }]),
    );
  }

  private maskRequest(row: ProfileChangeRequest): ProfileChangeRequest {
    return {
      ...row,
      beforeValues: this.maskChanges(row.beforeValues ?? {}),
      requestedChanges: this.maskChanges(row.requestedChanges ?? {}),
    };
  }

  private normalizeChanges(dto: CreateProfileChangeRequestDto): ProfileChanges {
    const changes: ProfileChanges = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    // [TBO-29B-4 §3] 연락처는 canonical로 정규화 — email lowercase·phone E.164(설정 시).
    if (dto.email !== undefined) changes.email = this.verifications.normalizeTarget('email', dto.email);
    if (dto.phone !== undefined) {
      changes.phone = dto.phone == null || dto.phone.trim() === ''
        ? null
        : this.verifications.normalizeTarget('sms', dto.phone);
    }
    // [E0.5 ④] 국가·시간대 자유 입력 폐지 — 카탈로그(countries 표) 값만 허용(비움 null은 허용).
    //  국가↔시간대 교차 일치는 강제하지 않는다(FE 토글이 국가 선택 시 tz 자동 세팅 — 서버는 목록 밖 차단만).
    if (dto.countryCode !== undefined) {
      const countryCode = dto.countryCode == null ? null : dto.countryCode.trim().toUpperCase() || null;
      if (countryCode != null && !this.countries.isValidCountryCode(countryCode)) {
        throw new BadRequestException('국가 코드는 카탈로그에서 선택해 주세요.');
      }
      changes.countryCode = countryCode;
    }
    if (dto.timeZone !== undefined) {
      const timeZone = dto.timeZone?.trim() || null;
      if (timeZone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone }).format();
        } catch {
          throw new BadRequestException('올바른 IANA 타임존이 아닙니다.');
        }
        if (!this.countries.isValidTimeZone(timeZone)) {
          throw new BadRequestException('시간대는 카탈로그에서 선택해 주세요.');
        }
      }
      changes.timeZone = timeZone;
    }
    if (changes.name === '') throw new BadRequestException('이름은 빈 값일 수 없습니다.');
    return changes;
  }

  private changedOnly(account: StaffAccount, requested: ProfileChanges): ProfileChanges {
    return Object.fromEntries(
      Object.entries(requested).filter(([field, value]) => this.profileValue(account, field) !== value),
    ) as ProfileChanges;
  }

  private profileValue(account: StaffAccount, field: string): unknown {
    return (account as unknown as Record<string, unknown>)[field] ?? null;
  }

  private requiredReason(value: string, label: string): string {
    const reason = value?.trim();
    if (!reason || reason.length < 5 || reason.length > 500) {
      throw new BadRequestException(`${label}는 5자 이상 500자 이하여야 합니다.`);
    }
    return reason;
  }

  private errorCode(error: unknown): string | undefined {
    return (error as { code?: string; driverError?: { code?: string } }).code
      ?? (error as { driverError?: { code?: string } }).driverError?.code;
  }
}
