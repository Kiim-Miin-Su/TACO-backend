import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  CAPABILITY_CATALOG,
  ROLE_CAPABILITIES,
  isRoleCapability,
  roleHasCapability,
  type AuditLog,
  type RoleCapability,
  type SetUserCapabilityInput,
  type StaffRole,
  type UserCapabilityPermission,
  type UserPermissionsProjection,
} from '@kms545487/contracts';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import {
  AUDIT_LOG_SPEC,
  USERS_SPEC,
  USER_CAPABILITY_OVERRIDES_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import type { BaseRow } from '../../common/types/base';
import { authVersionOf, type StaffAccount } from '../users/user.entity';
import type { UserCapabilityOverride } from './user-capability-override.entity';

type AuditRow = AuditLog & BaseRow;

@Injectable()
export class AccessControlService implements OnModuleInit {
  private readonly logger = new Logger(AccessControlService.name);

  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureReady(USER_CAPABILITY_OVERRIDES_SPEC);
  }

  async effectiveCapabilities(userId: number, roles: readonly string[]): Promise<RoleCapability[]> {
    const effective = new Set<RoleCapability>();
    for (const capability of ROLE_CAPABILITIES) {
      if (roles.some((role) => roleHasCapability(role, capability))) effective.add(capability);
    }
    const overrides = await this.store.findActive<UserCapabilityOverride>(USER_CAPABILITY_OVERRIDES_SPEC, {
      where: { userId },
      orderBy: { field: 'id' },
    });
    for (const override of overrides) {
      if (!isRoleCapability(override.capability)) continue;
      if (override.effect === 'allow') effective.add(override.capability);
      else effective.delete(override.capability);
    }
    return ROLE_CAPABILITIES.filter((capability) => effective.has(capability));
  }

  async permissionsFor(
    targetId: number,
    actorId: number,
  ): Promise<UserPermissionsProjection> {
    const actor = await this.activeStaff(actorId);
    const target = await this.activeStaff(targetId);
    return this.projection(target, actor, await this.overridesByCapability(targetId));
  }

  async setPermission(
    targetId: number,
    rawCapability: string,
    input: SetUserCapabilityInput,
    actorId: number,
  ): Promise<UserPermissionsProjection> {
    if (!isRoleCapability(rawCapability)) throw new BadRequestException('지원하지 않는 권한입니다.');
    const capability = rawCapability;
    return this.uow.run(async () => {
      await this.uow.lockTargets([
        { kind: 'user', id: Math.min(actorId, targetId) },
        { kind: 'user', id: Math.max(actorId, targetId) },
        { kind: 'permission', id: targetId },
      ]);
      const actor = await this.activeStaff(actorId);
      const target = await this.activeStaff(targetId);
      this.assertDelegation(actor, target, capability);
      if (authVersionOf(target) !== input.expectedAccessVersion) {
        throw new ConflictException({
          code: 'ACCESS_VERSION_STALE',
          message: '다른 관리자가 권한을 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.',
          expected: input.expectedAccessVersion,
          actual: authVersionOf(target),
        });
      }

      const base = roleHasCapability(target.role, capability);
      if ((capability === 'admin.area' || capability === 'signup.decide')
        && input.mode === 'allow' && !base) {
        throw new BadRequestException('이 권한은 기존 관리 역할에서 제한하거나 기본값으로 복원할 수만 있습니다.');
      }
      const normalizedMode = (input.mode === 'allow' && base) || (input.mode === 'deny' && !base)
        ? 'default'
        : input.mode;
      const existing = (await this.store.findActive<UserCapabilityOverride>(USER_CAPABILITY_OVERRIDES_SPEC, {
        where: { userId: targetId, capability },
        limit: 1,
      }))[0];
      if (normalizedMode === 'default' && !existing) {
        return this.projection(target, actor, await this.overridesByCapability(targetId));
      }

      const updatedTarget = await this.store.updateIf<StaffAccount>(
        USERS_SPEC,
        target.id,
        { authVersion: authVersionOf(target) } as Partial<StaffAccount>,
        { authVersion: authVersionOf(target) + 1 },
      );
      if (!updatedTarget) throw new ConflictException('다른 요청이 대상 계정을 먼저 변경했습니다.');

      if (normalizedMode === 'default') {
        await this.store.remove(USER_CAPABILITY_OVERRIDES_SPEC, existing!.id, actorId);
        await this.audit(existing!.id, 'delete', actorId, input.reason, {
          userId: { before: targetId, after: targetId },
          capability: { before: capability, after: capability },
          effect: { before: existing!.effect, after: null },
          accessVersion: { before: authVersionOf(target), after: authVersionOf(updatedTarget) },
        });
      } else if (existing) {
        const updated = await this.store.update<UserCapabilityOverride>(USER_CAPABILITY_OVERRIDES_SPEC, existing.id, {
          effect: normalizedMode,
          reason: input.reason.trim(),
          updatedBy: actorId,
        });
        if (!updated) throw new NotFoundException('권한 예외를 찾을 수 없습니다.');
        await this.audit(existing.id, 'update', actorId, input.reason, {
          effect: { before: existing.effect, after: normalizedMode },
          accessVersion: { before: authVersionOf(target), after: authVersionOf(updatedTarget) },
        });
      } else {
        const created = await this.store.insert<UserCapabilityOverride>(USER_CAPABILITY_OVERRIDES_SPEC, {
          userId: targetId,
          capability,
          effect: normalizedMode,
          reason: input.reason.trim(),
          createdBy: actorId,
          updatedBy: actorId,
        });
        await this.audit(created.id, 'create', actorId, input.reason, {
          userId: { after: targetId },
          capability: { after: capability },
          effect: { after: normalizedMode },
          accessVersion: { before: authVersionOf(target), after: authVersionOf(updatedTarget) },
        });
      }

      const readback = await this.overridesByCapability(targetId);
      this.logger.log(`action=set_permission actor=${actorId} target=${targetId} capability=${capability} mode=${normalizedMode} result=success`);
      return this.projection(updatedTarget, actor, readback);
    });
  }

  private async activeStaff(id: number): Promise<StaffAccount> {
    const [account] = await this.store.findActive<StaffAccount>(USERS_SPEC, {
      where: { id, status: 'active' } as Partial<StaffAccount>,
      limit: 1,
    });
    if (!account || !['instructor', 'manager', 'admin', 'super_admin'].includes(account.role)) {
      throw new NotFoundException('활성 직원 계정을 찾을 수 없습니다.');
    }
    return account;
  }

  private async overridesByCapability(userId: number): Promise<Map<RoleCapability, UserCapabilityOverride>> {
    const rows = await this.store.findActive<UserCapabilityOverride>(USER_CAPABILITY_OVERRIDES_SPEC, {
      where: { userId },
      orderBy: { field: 'id' },
    });
    return new Map(rows.filter((row) => isRoleCapability(row.capability)).map((row) => [row.capability, row]));
  }

  private projection(
    target: StaffAccount,
    actor: StaffAccount,
    overrides: Map<RoleCapability, UserCapabilityOverride>,
  ): UserPermissionsProjection {
    const targetMutable = target.id !== actor.id
      && target.role !== 'super_admin'
      && (actor.role === 'super_admin' || !['admin', 'super_admin'].includes(target.role));
    const permissions: UserCapabilityPermission[] = CAPABILITY_CATALOG.map((definition) => {
      const roleDefault = roleHasCapability(target.role, definition.capability);
      const override = overrides.get(definition.capability)?.effect ?? null;
      return {
        ...definition,
        roleDefault,
        override,
        effective: override == null ? roleDefault : override === 'allow',
        manageable: targetMutable
          && definition.configurable
          && (!['admin.area', 'signup.decide'].includes(definition.capability) || roleDefault)
          && (!definition.executiveOnly || actor.role === 'super_admin'),
      };
    });
    return {
      userId: target.id,
      role: target.role as StaffRole,
      accessVersion: authVersionOf(target),
      permissions,
    };
  }

  private assertDelegation(actor: StaffAccount, target: StaffAccount, capability: RoleCapability): void {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw new ForbiddenException('권한 설정은 대표 또는 관리자만 가능합니다.');
    }
    if (actor.id === target.id) throw new ForbiddenException('본인 권한은 직접 변경할 수 없습니다.');
    if (target.role === 'super_admin') throw new ForbiddenException('대표 계정 권한은 변경할 수 없습니다.');
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new ForbiddenException('관리자는 다른 관리자 권한을 변경할 수 없습니다.');
    }
    const definition = CAPABILITY_CATALOG.find((entry) => entry.capability === capability)!;
    if (!definition.configurable) throw new BadRequestException('고정 정책 권한은 개별 설정할 수 없습니다.');
    if (definition.executiveOnly && actor.role !== 'super_admin') {
      throw new ForbiddenException('해당 권한은 대표만 위임할 수 있습니다.');
    }
  }

  private async audit(
    entityId: number,
    action: AuditLog['action'],
    actorId: number,
    reason: string,
    changes: NonNullable<AuditLog['changes']>,
  ): Promise<void> {
    await this.store.insert<AuditRow>(AUDIT_LOG_SPEC, {
      entity: 'user_capability_overrides',
      entityId,
      action,
      actorId,
      at: new Date().toISOString(),
      reason: reason.trim(),
      changes,
    });
  }
}
