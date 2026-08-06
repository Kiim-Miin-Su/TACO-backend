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
    options: { keepTeaching?: boolean } = {},
  ): Promise<void> {
    if (account.role === nextRole || account.status !== 'active') return;

    if (account.role === 'instructor' && nextRole !== 'instructor') {
      // [TBO-87 겸직] 강사→manager/admin 승격 시 keepTeaching이면 원부를 유지해 겸직으로 전환.
      //  (종전엔 담당 수업이 있으면 승격 자체가 409로 막혔다 — 겸직 승격이 자연 경로.)
      if (options.keepTeaching && (nextRole === 'manager' || nextRole === 'admin')) {
        await this.audit.log({
          entity: 'instructor_profiles', entityId: account.id, action: 'update', actorId,
          changes: { teaching: { before: 'instructor(전임)', after: `${nextRole}(겸직 유지)` } },
          reason: '역할 승격 — 강사 활동(겸직) 유지',
        });
        return;
      }
      await this.deactivateInstructor(
        account,
        actorId,
        '강사 역할 해제에 따른 운영 프로필 비활성화',
      );
      return;
    }

    if (account.role !== 'instructor' && nextRole === 'instructor') {
      await this.activateInstructor(account, actorId, '강사 역할 전환');
    }
  }

  async deactivateForTermination(account: StaffAccount, actorId: number): Promise<void> {
    // [TBO-87] 겸직 manager/admin 종료도 활성 원부를 방치하지 않는다(역할 무관 — 원부 보유 기준).
    if (!this.profiles.findActive(account.id)) return;
    await this.deactivateInstructor(account, actorId, '직원 계정 종료에 따른 강사 운영 프로필 비활성화');
  }

  /** [TBO-87 겸직] 강사 활동 부여 — manager/admin 활성 계정에 강사원부를 생성/재활성한다.
   *  호출자는 user advisory lock + UoW 안에서 fresh-read 후 호출한다(대표 sudo 전용 command). */
  async grantTeaching(account: StaffAccount, actorId: number): Promise<void> {
    if (account.status !== 'active') throw new ConflictException('활성 직원 계정에만 강사 활동을 부여할 수 있습니다.');
    if (account.role === 'instructor') throw new ConflictException('이미 강사 역할 계정입니다.');
    if (account.role !== 'manager' && account.role !== 'admin') {
      throw new ConflictException('강사 겸직은 매니저·관리자 계정에만 부여할 수 있습니다.');
    }
    if (this.profiles.findActive(account.id)) throw new ConflictException('이미 강사 활동(겸직)이 부여된 계정입니다.');
    await this.activateInstructor(account, actorId, '강사 겸직 부여');
  }

  /** [TBO-87 겸직] 강사 활동 해제 — 담당 수업·활성 계약 가드는 강사 해제와 동일 규칙 재사용. */
  async revokeTeaching(account: StaffAccount, actorId: number): Promise<void> {
    if (account.role !== 'manager' && account.role !== 'admin') {
      throw new ConflictException('강사 겸직 해제는 매니저·관리자 계정에만 적용됩니다.');
    }
    if (!this.profiles.findActive(account.id)) throw new ConflictException('부여된 강사 활동(겸직)이 없습니다.');
    await this.deactivateInstructor(account, actorId, '강사 겸직 해제');
  }

  async activateForRestore(account: StaffAccount, actorId: number): Promise<void> {
    if (account.role !== 'instructor') return;
    await this.activateInstructor(account, actorId, '강사 계정 복구');
  }

  private async deactivateInstructor(
    account: StaffAccount,
    actorId: number,
    reason: string,
  ): Promise<void> {
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
        `강사 계정을 변경하기 전에 ${blockers.join('·')}을 정리해 주세요.`,
      );
    }

    const beforeProfile = this.profiles.findActive(account.id);
    if (!beforeProfile) return;
    await this.profiles.deactivate(account.id);
    await this.auditProfileTransition(
      account.id,
      actorId,
      beforeProfile,
      this.profiles.find(account.id),
      reason,
    );
  }

  private async activateInstructor(
    account: StaffAccount,
    actorId: number,
    reasonPrefix: string,
  ): Promise<void> {
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
        ? `${reasonPrefix}에 따른 운영 프로필 재활성화`
        : `${reasonPrefix}에 따른 운영 프로필 생성`,
    );
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
