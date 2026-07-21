import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { StudentInterestInput } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { STUDENT_INTERESTS_SPEC } from '../../database/calendar-asset-specs';
import { AuditService } from '../audit/audit.service';
import { Course, COURSES } from '../courses/course.entity';
import { STUDENTS } from './student.entity';
import { StudentInterest, STUDENT_INTERESTS } from './student-interest.entity';

type NormalizedInterest = { courseId?: number; customLabel?: string; priority: number };

@Injectable()
export class StudentInterestsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<StudentInterest>(STUDENT_INTERESTS_SPEC);
  }

  findByStudent(studentId: number): StudentInterest[] {
    this.assertStudent(studentId);
    return this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', studentId)
      .sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  validate(inputs: readonly StudentInterestInput[]): NormalizedInterest[] {
    if (inputs.length < 2) throw new BadRequestException('희망 수업은 최소 2개여야 합니다.');
    if (inputs.length > 20) throw new BadRequestException('희망 수업은 최대 20개까지 등록할 수 있습니다.');
    const normalized: NormalizedInterest[] = inputs.map((input): NormalizedInterest => {
      const customLabel = input.customLabel?.trim() || undefined;
      const hasCourse = input.courseId != null;
      if (hasCourse === (customLabel != null)) {
        throw new BadRequestException('희망 수업은 courseId와 customLabel 중 정확히 하나가 필요합니다.');
      }
      if (!Number.isInteger(input.priority) || input.priority < 1) {
        throw new BadRequestException('희망 수업 priority는 1 이상의 정수여야 합니다.');
      }
      if (hasCourse) {
        const course = this.db.findById<Course & { status?: string }>(COURSES, Number(input.courseId));
        if (!course || (course.status != null && course.status !== 'active')) {
          throw new BadRequestException(`활성 courseId ${input.courseId}를 찾을 수 없습니다.`);
        }
      }
      return { ...(hasCourse ? { courseId: Number(input.courseId) } : { customLabel }), priority: input.priority };
    });
    const priorities = normalized.map((item) => item.priority).sort((a, b) => a - b);
    if (priorities.some((priority, index) => priority !== index + 1)) {
      throw new BadRequestException('희망 수업 priority는 1부터 중복·누락 없이 연속이어야 합니다.');
    }
    const targets = normalized.map((item) => item.courseId != null
      ? `course:${item.courseId}`
      : `custom:${item.customLabel!.toLowerCase()}`);
    if (new Set(targets).size !== targets.length) throw new ConflictException('중복된 희망 수업이 있습니다.');
    return normalized;
  }

  async replace(studentId: number, inputs: readonly StudentInterestInput[], actorId: number): Promise<StudentInterest[]> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      this.assertStudent(studentId);
      return this.replaceInTx(studentId, inputs, actorId);
    });
  }

  async replaceInTx(studentId: number, inputs: readonly StudentInterestInput[], actorId: number): Promise<StudentInterest[]> {
    const normalized = this.validate(inputs);
    const before = this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', studentId);
    for (const row of before) {
      await this.store.remove(STUDENT_INTERESTS_SPEC, row.id, actorId);
      await this.audit.log({
        entity: STUDENT_INTERESTS, entityId: row.id, action: 'delete', actorId,
        changes: this.audit.snapshotOf(row), reason: 'aggregate-replace',
      });
    }
    const created: StudentInterest[] = [];
    for (const input of normalized) {
      const row = await this.store.insert<StudentInterest>(STUDENT_INTERESTS_SPEC, { studentId, ...input });
      created.push(row);
      await this.audit.log({
        entity: STUDENT_INTERESTS, entityId: row.id, action: 'create', actorId,
        changes: this.audit.diffOf({}, row), reason: 'aggregate-replace',
      });
    }
    return created;
  }

  async add(studentId: number, input: StudentInterestInput, actorId: number): Promise<StudentInterest> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      this.assertStudent(studentId);
      const current = this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', studentId);
      const normalized = this.validate([...current.map(this.toInput), input]);
      const next = normalized.find((item) => item.priority === input.priority)!;
      const row = await this.store.insert<StudentInterest>(STUDENT_INTERESTS_SPEC, { studentId, ...next });
      await this.audit.log({ entity: STUDENT_INTERESTS, entityId: row.id, action: 'create', actorId, changes: this.audit.diffOf({}, row) });
      return row;
    });
  }

  async remove(studentId: number, interestId: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      this.assertStudent(studentId);
      const current = this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', studentId);
      const target = current.find((row) => row.id === interestId);
      if (!target) throw new NotFoundException(`희망 수업 ${interestId} 없음`);
      if (current.length <= 2) throw new ConflictException('희망 수업은 최소 2개를 유지해야 합니다.');
      await this.store.remove(STUDENT_INTERESTS_SPEC, interestId, actorId);
      await this.audit.log({
        entity: STUDENT_INTERESTS, entityId: interestId, action: 'delete', actorId,
        changes: this.audit.snapshotOf(target),
      });
      const remaining = current.filter((row) => row.id !== interestId).sort((a, b) => a.priority - b.priority);
      for (let index = 0; index < remaining.length; index += 1) {
        const row = remaining[index];
        const priority = index + 1;
        if (row.priority === priority) continue;
        const after = await this.store.update<StudentInterest>(STUDENT_INTERESTS_SPEC, row.id, { priority });
        if (after) await this.audit.log({
          entity: STUDENT_INTERESTS, entityId: row.id, action: 'update', actorId,
          changes: this.audit.diffOf(row, after), reason: `delete-reorder:${interestId}`,
        });
      }
      return { id: interestId, deleted: true };
    });
  }

  private readonly toInput = (row: StudentInterest): StudentInterestInput => ({
    ...(row.courseId != null ? { courseId: row.courseId } : { customLabel: row.customLabel ?? undefined }),
    priority: row.priority,
  });

  private assertStudent(studentId: number): void {
    if (!this.db.findById(STUDENTS, studentId)) throw new NotFoundException(`Student ${studentId} not found`);
  }
}
