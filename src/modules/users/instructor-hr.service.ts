// [TBO-68 C3 2026-07-26] 강사 HR aggregate 서비스 — users.service(945줄, 3컨텍스트 혼재)에서
//  강사 HR CRUD를 분리(P3 ① 실측 근거: 인증/HR/승인 이질 컨텍스트). **public API·규약 무변**:
//  메서드 본문은 이동만(잠금·audit·불변식 그대로), 계정 코어(미러 refresh·find)는 UsersService를
//  단방향 주입해 경유한다(순환 없음 — UsersService는 이 서비스를 모른다).
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { InstructorAggregate, UpdateInstructorInput, DeletedResult } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COURSES_SPEC, INSTRUCTOR_CONTRACTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { INSTRUCTOR_PROFILES, InstructorProfilesStore, activeTeachingProfileUserIds } from './instructor-profiles.store';
import type { InstructorProfile } from './instructor-profiles.store';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import type { Course } from '../courses/course.entity';
import type { InstructorContract } from '../instructor-contracts/instructor-contract.entity';
import { isTeachingAccount, USERS, authVersionOf, toSafe, type StaffAccount } from './user.entity';
import { UsersService } from './users.service';

@Injectable()
export class InstructorHrService {
  constructor(
    private readonly users: UsersService,
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly profiles: InstructorProfilesStore,
    private readonly sessions: ClassSessionsStore,
  ) {}

  private instructorAggregateOf(account: StaffAccount, profile: InstructorProfile): InstructorAggregate {
    return {
      id: account.id,
      webId: account.webId,
      name: account.name,
      email: account.email ?? null,
      phone: account.phone ?? null,
      status: account.status,
      countryCode: account.countryCode ?? null,
      timeZone: account.timeZone ?? null,
      university: profile.university ?? null,
      major: profile.major ?? null,
      birthYear: profile.birthYear ?? null,
      defaultHourlyRate: profile.defaultHourlyRate ?? 0,
      canTeachKinder: profile.canTeachKinder ?? false,
      approvedBy: profile.approvedBy,
      approvedAt: profile.approvedAt,
    };
  }

  async listInstructors(): Promise<InstructorAggregate[]> {
    await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
    // [TBO-87] 강사 원부 목록 = 가르치는 사람 전체(겸직 manager/admin 포함) — 활성 원부 보유 기준.
    const teaching = activeTeachingProfileUserIds(this.db.findAll<InstructorProfile>(INSTRUCTOR_PROFILES));
    return this.db.findBy<StaffAccount>(USERS, (account) => isTeachingAccount(account, teaching))
      .map((account) => {
        const profile = this.profiles.findActive(account.id);
        if (!profile) return null;
        return this.instructorAggregateOf(account, profile);
      })
      .filter((row): row is InstructorAggregate => row != null)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  async getInstructor(id: number): Promise<InstructorAggregate> {
    await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
    const account = this.users.findById(id);
    const profile = this.profiles.findActive(id);
    if (!account || account.role !== 'instructor' || account.status !== 'active' || !profile)
      throw new NotFoundException(`강사 ${id} 없음`);
    return this.instructorAggregateOf(account, profile);
  }

  async updateInstructor(id: number, actorId: number, patch: UpdateInstructorInput): Promise<InstructorAggregate> {
    await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }]);
      await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
      const currentAccount = this.users.findById(id);
      const currentProfile = this.profiles.findActive(id);
      if (!currentAccount || currentAccount.role !== 'instructor' || currentAccount.status !== 'active' || !currentProfile)
        throw new NotFoundException(`강사 ${id} 없음`);
      const beforeAccount = { ...currentAccount };
      const beforeProfile = { ...currentProfile };

      const userPatch: Partial<StaffAccount> = {};
      if (patch.name !== undefined) userPatch.name = patch.name.trim();
      if (patch.phone !== undefined) userPatch.phone = patch.phone.trim() || null;
      if (patch.email !== undefined) {
        const email = patch.email.trim().toLowerCase();
        const taken = this.db.findBy<StaffAccount>(USERS, (a) => a.id !== id && !!a.email && a.email.toLowerCase() === email).length > 0;
        if (taken) throw new BadRequestException('이미 사용 중인 이메일입니다.');
        userPatch.email = email;
        if (email !== (beforeAccount.email ?? '').toLowerCase()) userPatch.authVersion = authVersionOf(beforeAccount) + 1;
      }
      if (patch.countryCode !== undefined) userPatch.countryCode = patch.countryCode?.trim() || null;
      if (patch.timeZone !== undefined) userPatch.timeZone = patch.timeZone?.trim() || null;
      const afterAccount = Object.keys(userPatch).length
        ? await this.store.update<StaffAccount>(USERS_SPEC, id, userPatch as never)
        : beforeAccount;
      if (!afterAccount) throw new NotFoundException(`강사 ${id} 없음`);

      const profilePatch = {
        university: patch.university !== undefined ? patch.university?.trim() || null : undefined,
        major: patch.major !== undefined ? patch.major?.trim() || null : undefined,
        birthYear: patch.birthYear,
        defaultHourlyRate: patch.defaultHourlyRate,
        canTeachKinder: patch.canTeachKinder,
      };
      const afterProfile = Object.values(profilePatch).some((value) => value !== undefined)
        ? await this.profiles.updateDetails(id, profilePatch)
        : beforeProfile;

      const userChanges = this.audit.maskContactPii(this.audit.diffOf(beforeAccount, afterAccount));
      if (Object.keys(userChanges).length) {
        await this.audit.log({ entity: 'users', entityId: id, action: 'update', actorId, changes: userChanges,
          reason: '강사 aggregate 수정' });
      }
      const profileChanges = this.audit.maskContactPii(this.audit.diffOf(beforeProfile, afterProfile));
      if (Object.keys(profileChanges).length) {
        await this.audit.log({ entity: 'instructor_profiles', entityId: id, action: 'update', actorId,
          changes: profileChanges, reason: '강사 aggregate 수정' });
      }
      return this.instructorAggregateOf(afterAccount, afterProfile);
    });
  }

  async removeInstructor(id: number, actorId: number): Promise<DeletedResult> {
    await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'user', id }]);
      await Promise.all([this.users.refreshFromDb(), this.profiles.hydrate()]);
      const currentAccount = this.users.findById(id);
      const currentProfile = this.profiles.findActive(id);
      if (!currentAccount || currentAccount.role !== 'instructor' || currentAccount.status !== 'active' || !currentProfile)
        throw new NotFoundException(`강사 ${id} 없음`);
      const account = { ...currentAccount };
      const profile = { ...currentProfile };
      const [courses, contracts, hasSession] = await Promise.all([
        this.store.findActive<Course>(COURSES_SPEC, { where: { instructorId: id }, limit: 1 }),
        this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, { where: { instructorId: id, active: true }, limit: 1 }),
        this.sessions.existsForInstructor(id),
      ]);
      const blockers = [courses.length && '수업', contracts.length && '계약', hasSession && '스케줄'].filter(Boolean);
      if (blockers.length) throw new ConflictException(`활성 참조가 있는 강사는 삭제할 수 없습니다: ${blockers.join('·')}`);

      await this.store.update<StaffAccount>(USERS_SPEC, id, {
        status: 'rejected', authVersion: authVersionOf(account) + 1,
      } as never);
      await this.profiles.softDelete(id, actorId);
      await this.store.remove(USERS_SPEC, id, actorId);
      await this.audit.log({ entity: 'instructor_profiles', entityId: id, action: 'delete', actorId,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(profile)), reason: '대표 강사 삭제' });
      await this.audit.log({ entity: 'users', entityId: id, action: 'delete', actorId,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(toSafe(account))), reason: '대표 강사 삭제' });
      return { id, deleted: true as const };
    });
  }
}
