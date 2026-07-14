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
import { CreateProfileChangeRequestDto } from './dto/create-profile-change-request.dto';
import {
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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC);
  }

  async create(requesterId: number, dto: CreateProfileChangeRequestDto): Promise<ProfileChangeRequest> {
    const reason = this.requiredReason(dto.reason, '변경 사유');
    await this.refresh();
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id: requesterId }]);
      await this.refresh();
      const requester = this.users.findById(requesterId);
      if (!requester) throw new NotFoundException(`계정 ${requesterId} 없음`);
      if (this.pendingFor(requesterId)) throw new ConflictException('이미 처리 중인 프로필 변경 요청이 있습니다.');

      const requestedChanges = this.normalizeChanges(dto);
      const actualChanges = this.changedOnly(requester, requestedChanges);
      if (!Object.keys(actualChanges).length) throw new BadRequestException('현재 프로필과 다른 변경 항목이 필요합니다.');
      const beforeValues = Object.fromEntries(
        Object.keys(actualChanges).map((field) => [field, this.profileValue(requester, field)]),
      ) as ProfileChanges;

      try {
        const created = await this.store.insert<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
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
        });
        await this.audit.log({
          entity: PROFILE_CHANGE_REQUESTS,
          entityId: created.id,
          action: 'create',
          actorId: requesterId,
          changes: {
            status: { after: 'pending' },
            requestedChanges: { after: actualChanges },
            baseProfileVersion: { after: created.baseProfileVersion },
          },
          reason: reason.slice(0, 200),
        });
        return created;
      } catch (error) {
        if (this.errorCode(error) === '23505') {
          throw new ConflictException('이미 처리 중인 프로필 변경 요청이 있습니다.');
        }
        throw error;
      }
    });
  }

  async mine(requesterId: number): Promise<ProfileChangeRequest[]> {
    return this.store.findActive<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
      where: { requesterId },
      orderBy: { field: 'id', direction: 'DESC' },
    });
  }

  async list(): Promise<ProfileChangeRequest[]> {
    return this.store.findActive<ProfileChangeRequest>(PROFILE_CHANGE_REQUESTS_SPEC, {
      orderBy: { field: 'id', direction: 'DESC' },
    });
  }

  async detail(id: number, actorId: number, roles?: string[]): Promise<ProfileChangeRequest> {
    const row = await this.findAuthoritative(id);
    if (row.requesterId !== actorId && !hasAdminRole(roles)) {
      throw new ForbiddenException('본인의 프로필 변경 요청만 조회할 수 있습니다.');
    }
    return row;
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

      const before = this.users.findById(request.requesterId);
      if (!before) throw new NotFoundException(`계정 ${request.requesterId} 없음`);
      if (before.status !== 'active') throw new ConflictException('활성 계정의 프로필만 변경할 수 있습니다.');
      const currentVersion = profileVersionOf(before);
      if (request.baseProfileVersion !== currentVersion) {
        throw new ConflictException('프로필이 요청 이후 변경되어 처리할 수 없습니다.');
      }

      const decidedAt = new Date().toISOString();
      const changes: Record<string, { before?: unknown; after?: unknown }> = {
        status: { before: 'pending', after: status },
      };
      if (status === 'approved') {
        for (const [field, after] of Object.entries(request.requestedChanges)) {
          changes[field] = { before: (before as unknown as Record<string, unknown>)[field], after };
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
          changes: this.audit.diffOf(before, updated),
          reason: `프로필 변경 요청 #${id} 승인`,
        });
      } else {
        changes.rejectionReason = { after: decisionReason };
      }

      const decided = await this.store.updateIf<ProfileChangeRequest>(
        PROFILE_CHANGE_REQUESTS_SPEC,
        id,
        { status: 'pending', baseProfileVersion: request.baseProfileVersion },
        {
          status,
          decidedBy: actorId,
          decidedAt,
          rejectionReason: decisionReason ?? null,
          appliedProfileVersion: status === 'approved' ? currentVersion + 1 : null,
        },
      );
      if (!decided) throw new ConflictException('이미 처리된 프로필 변경 요청입니다.');

      await this.audit.log({
        entity: PROFILE_CHANGE_REQUESTS,
        entityId: id,
        action: status === 'approved' ? 'approve' : 'reject',
        actorId,
        changes,
        reason: status === 'approved' ? `프로필 변경 요청 #${id} 승인` : decisionReason?.slice(0, 200),
      });
      return decided;
    });
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

  private normalizeChanges(dto: CreateProfileChangeRequestDto): ProfileChanges {
    const changes: ProfileChanges = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.phone !== undefined) changes.phone = dto.phone == null ? null : dto.phone.trim();
    if (dto.countryCode !== undefined) changes.countryCode = dto.countryCode == null ? null : dto.countryCode.trim().toUpperCase() || null;
    if (dto.timeZone !== undefined) {
      const timeZone = dto.timeZone?.trim() || null;
      if (timeZone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone }).format();
        } catch {
          throw new BadRequestException('올바른 IANA 타임존이 아닙니다.');
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
