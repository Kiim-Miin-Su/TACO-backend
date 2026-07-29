import { ConflictException, Injectable } from '@nestjs/common';
import { COURSES_SPEC, INSTRUCTOR_CONTRACTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service';
import type { StoredCourse } from '../courses/course.entity';
import type { InstructorContract } from '../instructor-contracts/instructor-contract.entity';
import type { StaffAccount, StaffRole } from './user.entity';
import {
  InstructorProfilesStore,
  type InstructorProfile,
} from './instructor-profiles.store';

/**
 * 활성 직원 역할과 강사 운영 원부의 자동 전이 단일 경계.
 * 호출자는 user advisory lock과 UoW transaction 안에서 users/profiles를 fresh-read해야 한다.
 */
@Injectable()
export class UserRoleTransitionService {
  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly profiles: InstructorProfilesStore,
    private readonly audit: AuditService,
  ) {}

  async apply(
    account: StaffAccount,
    nextRole: StaffRole,
    actorId: number,
  ): Promise<void> {
    if (account.role === nextRole || account.status !== 'active') return;

    if (account.role === 'instructor' && nextRole !== 'instructor') {
      const [courses, contracts] = await Promise.all([
        this.store.findActive<StoredCourse>(COURSES_SPEC, {
          where: { instructorId: account.id },
          limit: 1,
        }),
        this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
          where: { instructorId: account.id, active: true },
          limit: 1,
        }),
      ]);
      const blockers = [
        courses.length ? '담당 수업' : null,
        contracts.length ? '활성 계약' : null,
      ].filter((value): value is string => value != null);
      if (blockers.length) {
        throw new ConflictException(
          `강사 역할을 변경하기 전에 ${blockers.join('·')}을 정리해 주세요.`,
        );
      }

      const beforeProfile = this.profiles.findActive(account.id);
      if (!beforeProfile) return;
      await this.profiles.deactivate(account.id);
      const afterProfile = this.profiles.find(account.id);
      await this.auditProfileTransition(
        account.id,
        actorId,
        beforeProfile,
        afterProfile,
        '강사 역할 해제에 따른 운영 프로필 비활성화',
      );
      return;
    }

    if (account.role !== 'instructor' && nextRole === 'instructor') {
      const beforeProfile = this.profiles.find(account.id);
      const approvedAt = new Date().toISOString();
      const afterProfile = await this.profiles.upsertActive(account.id, actorId, approvedAt, {
        university: beforeProfile?.university ?? account.university ?? null,
        major: beforeProfile?.major ?? account.major ?? null,
        birthYear: beforeProfile?.birthYear ?? account.birthYear ?? null,
        defaultHourlyRate: beforeProfile?.defaultHourlyRate ?? 0,
        canTeachKinder: beforeProfile?.canTeachKinder ?? false,
      });
      await this.auditProfileTransition(
        account.id,
        actorId,
        beforeProfile,
        afterProfile,
        beforeProfile
          ? '강사 역할 전환에 따른 운영 프로필 재활성화'
          : '강사 역할 전환에 따른 운영 프로필 생성',
      );
    }
  }

  private async auditProfileTransition(
    userId: number,
    actorId: number,
    before: InstructorProfile | undefined,
    after: InstructorProfile | undefined,
    reason: string,
  ): Promise<void> {
    if (!after) throw new Error(`instructor profile ${userId} transition produced no row`);
    const changes = before
      ? this.audit.diffOf(before, after)
      : this.audit.snapshotOf(after);
    await this.audit.log({
      entity: 'instructor_profiles',
      entityId: userId,
      action: before ? 'update' : 'create',
      actorId,
      changes: this.audit.maskContactPii(changes),
      reason,
    });
  }
}
