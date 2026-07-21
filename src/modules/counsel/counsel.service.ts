import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { COUNSEL_FORMS_SPEC, COUNSEL_ROUNDS_SPEC } from '../../database/calendar-asset-specs';
import { AuditService } from '../audit/audit.service';
import { Course, COURSES } from '../courses/course.entity';
import { Subject, SUBJECTS } from '../subjects/subject.entity';
import { type StaffAccount, USERS, isStaffRole } from '../users/user.entity';
import { CounselForm, CounselRound, COUNSEL_FORMS } from './counsel.entity';
import { CreateCounselDto } from './dto/create-counsel.dto';
import { UpdateCounselDto } from './dto/update-counsel.dto';
import { CreateCounselRoundDto } from './dto/create-round.dto';
import type { CounselAggregate, CounselFormSnapshot } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';
import { UpdateCounselRoundDto } from './dto/update-round.dto';
import { StudentsService } from '../students/students.service';
import { Parent, ParentStudent, PARENTS, PARENT_STUDENTS } from '../parents/parent.entity';
import { Student, STUDENTS } from '../students/student.entity';

const snapshotOfForm = (form: CounselFormSnapshot): CounselFormSnapshot => ({
  applicantName: form.applicantName,
  applicantPhone: form.applicantPhone ?? null,
  parentId: form.parentId ?? null,
  studentId: form.studentId ?? null,
  assignedStaffId: form.assignedStaffId ?? null,
  status: form.status,
  source: form.source,
  submitterType: form.submitterType,
  interestSubjectId: form.interestSubjectId ?? null,
  interestCourseId: form.interestCourseId ?? null,
  academyExpectation: form.academyExpectation ?? null,
  desiredStartTime: form.desiredStartTime ?? null,
  learningAtmosphere: form.learningAtmosphere ?? null,
  studentIntention: form.studentIntention ?? null,
  weakness: form.weakness ?? null,
  referenceNotes: form.referenceNotes ?? null,
  nextContactAt: form.nextContactAt ?? null,
});

@Injectable()
export class CounselService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly students: StudentsService,
  ) {}

  // 관심 과목/코스 FK 존재 검증(있을 때만) — 참조 무결성.
  private assertRefs(dto: {
    interestSubjectId?: number | null;
    interestCourseId?: number | null;
    assignedStaffId?: number | null;
    parentId?: number | null;
    studentId?: number | null;
  }): void {
    if (dto.interestSubjectId != null && !this.db.findById<Subject>(SUBJECTS, dto.interestSubjectId))
      throw new BadRequestException(`interestSubjectId ${dto.interestSubjectId} 없음`);
    if (dto.interestCourseId != null && !this.db.findById<Course>(COURSES, dto.interestCourseId))
      throw new BadRequestException(`interestCourseId ${dto.interestCourseId} 없음`);
    if (dto.assignedStaffId != null) this.assertActiveStaff(dto.assignedStaffId, 'assignedStaffId');
    if (dto.studentId != null && !this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음`);
    if (dto.parentId != null && !this.db.findById<Parent>(PARENTS, dto.parentId))
      throw new BadRequestException(`parentId ${dto.parentId} 없음`);
    if (dto.studentId != null && dto.parentId != null) {
      const linked = this.db.findBy<ParentStudent>(PARENT_STUDENTS, (row) =>
        row.studentId === dto.studentId && row.parentId === dto.parentId).length > 0;
      if (!linked) throw new BadRequestException('parentId와 studentId 사이의 활성 보호자 관계가 없습니다.');
    }
  }

  private assertActiveStaff(id: number, field: 'assignedStaffId' | 'counselorId'): void {
    const account = this.db.findById<StaffAccount>(USERS, id);
    if (!account || account.status !== 'active' || !isStaffRole(account.role)) {
      throw new BadRequestException(`${field} ${id}는 활성 직원이 아닙니다`);
    }
  }

  async findForm(id: number): Promise<CounselForm> {
    const [row] = await this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC, { where: { id } });
    if (!row) throw new NotFoundException(`CounselForm ${id} not found`);
    return row;
  }

  async findAggregate(id: number): Promise<CounselAggregate> {
    const form = await this.findForm(id);
    return {
      form,
      rounds: await this.findAllRounds(id),
      student: form.studentId == null ? null : this.students.findAggregate(form.studentId),
    };
  }

  // 상담 접수 생성 — 최초 status='requested'(미지정 시). actorId 없으면(시드·내부 경로) audit 생략.
  async createForm(dto: CreateCounselDto, actorId?: number): Promise<CounselForm> {
    this.assertRefs(dto);
    return this.uow.run(async () => {
      const row = await this.store.insert<CounselForm>(COUNSEL_FORMS_SPEC, {
        ...dto,
        submitterType: dto.submitterType ?? 'unknown',
        status: 'requested',
      } as Omit<CounselForm, 'id' | 'createdAt' | 'updatedAt'>);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) {
        await this.audit.log({
          entity: 'counsel_forms', entityId: row.id, action: 'create', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf({}, row)),
        });
      }
      return row;
    });
  }

  // 상담 폼 수정(상태 전환·담당자·관심사). 존재 검증 + 관심 FK 검증.
  async updateForm(id: number, dto: UpdateCounselDto, actorId?: number): Promise<CounselForm> {
    this.assertRefs(dto);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id }]);
      const before = { ...(await this.findForm(id)) };
      const after = (await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, id, dto)) as CounselForm;
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      // PII 마스킹: applicantPhone 등 연락처 키는 diff에 원문 금지 — users.service maskTarget 규약과 동일 원칙.
      if (actorId != null) {
        await this.audit.log({
          entity: 'counsel_forms', entityId: id, action: 'update', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  // 회차 추가 — roundNo 자동 증가, 부모 폼 FK 검증 + nextContactAt 동기화(배지 단일 소스).
  async createRound(formId: number, dto: CreateCounselRoundDto, actorId?: number): Promise<CounselRound> {
    if (dto.counselorId != null) this.assertActiveStaff(dto.counselorId, 'counselorId');
    if (dto.formSnapshot) this.assertRefs(dto.formSnapshot);
    if (dto.nextContactAt !== undefined && dto.formSnapshot?.nextContactAt !== undefined
      && dto.nextContactAt !== dto.formSnapshot.nextContactAt) {
      throw new BadRequestException('nextContactAt과 formSnapshot.nextContactAt이 일치해야 합니다');
    }
    // [원자성] 회차 기록 + 폼 nextContactAt 동기화가 함께(다음 일정 불일치 방지)
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const existing = await this.store.findActive<CounselRound>(COUNSEL_ROUNDS_SPEC, {
        where: { counselFormId: formId },
        orderBy: { field: 'roundNo' },
      });
      const roundNo = existing.reduce((max, r) => Math.max(max, r.roundNo), -1) + 1;
      const formSnapshot: CounselFormSnapshot = {
        ...snapshotOfForm(beforeForm),
        ...dto.formSnapshot,
      };
      if (dto.nextContactAt !== undefined) formSnapshot.nextContactAt = dto.nextContactAt;
      const round = await this.store.insert<CounselRound>(COUNSEL_ROUNDS_SPEC, {
        counselFormId: formId, roundNo, counselorId: dto.counselorId,
        completedAt: new Date().toISOString().slice(0, 10), isCompleted: true,
        summary: dto.summary, detail: dto.detail, result: dto.result,
        nextAction: dto.nextAction, nextContactAt: formSnapshot.nextContactAt ?? null,
        formSnapshot,
      } as Omit<CounselRound, 'id' | 'createdAt' | 'updatedAt'>);
      // 폼의 다음 상담일을 최신 회차 기준으로 동기화(상담 배지 = nextContactAt 미정).
      if (dto.nextContactAt !== undefined || dto.formSnapshot !== undefined) {
        const afterForm = await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, formId, {
          nextContactAt: formSnapshot.nextContactAt ?? null,
        });
        if (actorId != null) {
          await this.audit.log({
            entity: 'counsel_forms', entityId: formId, action: 'update', actorId,
            changes: this.audit.diffOf(beforeForm, afterForm as CounselForm),
          });
        }
      }
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 기존 db.transaction 안에 audit만 추가.
      if (actorId != null) {
        await this.audit.log({
          entity: 'counsel_rounds', entityId: round.id, action: 'create', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf({}, round)),
        });
      }
      return round;
    });
  }

  async updateRound(formId: number, roundId: number, dto: UpdateCounselRoundDto, actorId: number): Promise<CounselRound> {
    if (dto.counselorId != null) this.assertActiveStaff(dto.counselorId, 'counselorId');
    if (dto.formSnapshot) this.assertRefs(dto.formSnapshot);
    if (dto.nextContactAt !== undefined && dto.formSnapshot?.nextContactAt !== undefined
      && dto.nextContactAt !== dto.formSnapshot.nextContactAt) {
      throw new BadRequestException('nextContactAt과 formSnapshot.nextContactAt이 일치해야 합니다');
    }
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const before = { ...this.roundForForm(formId, roundId) };
      const formSnapshot = dto.formSnapshot == null
        ? { ...before.formSnapshot }
        : snapshotOfForm({ ...before.formSnapshot, ...dto.formSnapshot });
      if (dto.nextContactAt !== undefined) formSnapshot.nextContactAt = dto.nextContactAt;
      const patch = {
        ...(dto.counselorId !== undefined ? { counselorId: dto.counselorId } : {}),
        ...(dto.scheduledAt !== undefined ? { scheduledAt: dto.scheduledAt } : {}),
        ...(dto.completedAt !== undefined ? { completedAt: dto.completedAt } : {}),
        ...(dto.isCompleted !== undefined ? { isCompleted: dto.isCompleted } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.detail !== undefined ? { detail: dto.detail } : {}),
        ...(dto.result !== undefined ? { result: dto.result } : {}),
        ...(dto.nextAction !== undefined ? { nextAction: dto.nextAction } : {}),
        ...(dto.nextContactAt !== undefined ? { nextContactAt: dto.nextContactAt } : {}),
        ...(dto.formSnapshot !== undefined || dto.nextContactAt !== undefined ? { formSnapshot } : {}),
      };
      const after = await this.store.update<CounselRound>(COUNSEL_ROUNDS_SPEC, roundId, patch);
      if (!after) throw new NotFoundException(`CounselRound ${roundId} not found`);
      const rounds = await this.findAllRounds(formId);
      const latestRoundId = rounds.sort((a, b) => b.roundNo - a.roundNo || b.id - a.id)[0]?.id;
      if ((dto.nextContactAt !== undefined || dto.formSnapshot !== undefined) && latestRoundId === roundId) {
        const nextContactAt = formSnapshot.nextContactAt ?? null;
        const afterForm = await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, formId, { nextContactAt });
        await this.audit.log({
          entity: COUNSEL_FORMS, entityId: formId, action: 'update', actorId,
          changes: this.audit.diffOf(beforeForm, afterForm as CounselForm), reason: `round-update:${roundId}`,
        });
      }
      await this.audit.log({
        entity: 'counsel_rounds', entityId: roundId, action: 'update', actorId,
        changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
      });
      return after;
    });
  }

  async removeRound(formId: number, roundId: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const before = { ...this.roundForForm(formId, roundId) };
      await this.store.remove(COUNSEL_ROUNDS_SPEC, roundId, actorId);
      await this.audit.log({
        entity: 'counsel_rounds', entityId: roundId, action: 'delete', actorId,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
      });
      const remaining = await this.findAllRounds(formId);
      const latest = remaining.sort((a, b) => b.roundNo - a.roundNo || b.id - a.id)[0];
      const nextContactAt = latest?.nextContactAt ?? null;
      if ((beforeForm.nextContactAt ?? null) !== nextContactAt) {
        const afterForm = await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, formId, { nextContactAt });
        await this.audit.log({
          entity: COUNSEL_FORMS, entityId: formId, action: 'update', actorId,
          changes: this.audit.diffOf(beforeForm, afterForm as CounselForm), reason: `round-delete:${roundId}`,
        });
      }
      return { id: roundId, deleted: true };
    });
  }

  private roundForForm(formId: number, roundId: number): CounselRound {
    const row = this.db.findById<CounselRound>('counsel_rounds', roundId);
    if (!row || row.counselFormId !== formId) throw new NotFoundException(`상담 ${formId}의 회차 ${roundId} 없음`);
    return row;
  }

  // 데모 상담 시드 — 프론트 목데이터 이관. rounds.counselFormId→forms.id(무결성).
  // 상담 탭 배지: status≠dropped ∧ nextContactAt 없음(다음 상담일 미정) 기준.
  async onModuleInit(): Promise<void> {
    const forms = await this.store.hydrate<CounselForm>(COUNSEL_FORMS_SPEC);
    const rounds = await this.store.hydrate<CounselRound>(COUNSEL_ROUNDS_SPEC);
    if (forms.length || rounds.length || this.db.findAll<CounselForm>(COUNSEL_FORMS).length) return;
    const seedForms: Array<Omit<CounselForm, keyof BaseRow> & { id: number }> = [
      { id: 1, applicantName: '한서진', applicantPhone: '010-7777-1212', assignedStaffId: 1, status: 'pending', source: 'internal_form', submitterType: 'unknown', interestSubjectId: 1, academyExpectation: '내신·수능 영어 전반 보완, 독해 속도 개선', desiredStartTime: 'within_1_month', learningAtmosphere: 'needs_management', studentIntention: 'parent_only', weakness: '독해 속도, 어휘량 부족', nextContactAt: '2026-06-29' },
      { id: 2, applicantName: '오민재', applicantPhone: '010-8888-3434', assignedStaffId: 1, status: 'registered', source: 'naver_form', submitterType: 'unknown', interestCourseId: 11, interestSubjectId: 2, academyExpectation: 'AP Calculus 대비', desiredStartTime: 'immediately', learningAtmosphere: 'self_directed', studentIntention: 'student_wants', weakness: '서술형 풀이 과정' },
      { id: 3, applicantName: '신유나', applicantPhone: '010-9999-5656', status: 'requested', source: 'manual', submitterType: 'unknown', interestSubjectId: 1, desiredStartTime: 'undecided', studentIntention: 'unknown' },
    ];
    await this.store.seed<CounselForm>(COUNSEL_FORMS_SPEC, seedForms);
    await this.store.seed<CounselRound>(COUNSEL_ROUNDS_SPEC, [
      { id: 1, counselFormId: 1, roundNo: 0, counselorId: 1, completedAt: '2026-06-19', isCompleted: true, summary: '초기 전화 상담', detail: '현 성적·목표 파악. 레벨테스트 권유.', result: 'neutral', nextAction: '레벨테스트 일정 조율', nextContactAt: '2026-06-23', formSnapshot: { ...snapshotOfForm(seedForms[0]), nextContactAt: '2026-06-23' } },
      { id: 2, counselFormId: 1, roundNo: 1, counselorId: 1, completedAt: '2026-06-24', isCompleted: true, summary: '레벨테스트 후 대면 상담', detail: '독해 보강 필요. SAT Reading 정규 제안.', result: 'positive', nextAction: '수강 등록 안내', nextContactAt: '2026-06-29', formSnapshot: snapshotOfForm(seedForms[0]) },
      { id: 3, counselFormId: 2, roundNo: 0, counselorId: 1, completedAt: '2026-06-13', isCompleted: true, summary: '온라인 상담', detail: 'AP 일정 및 커리큘럼 안내.', result: 'positive', nextAction: '시간표 확정', formSnapshot: snapshotOfForm(seedForms[1]) },
      { id: 4, counselFormId: 2, roundNo: 1, counselorId: 1, completedAt: '2026-06-16', isCompleted: true, summary: '등록 확정 상담', detail: 'AP Calculus BC 등록 결정.', result: 'registered', nextAction: '결제 및 반 배정', formSnapshot: snapshotOfForm(seedForms[1]) },
    ]);
  }

  async findAllForms(): Promise<CounselForm[]> {
    return this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC, { orderBy: { field: 'id', direction: 'DESC' } });
  }

  async findAllRounds(counselFormId?: number): Promise<CounselRound[]> {
    return this.store.findActive<CounselRound>(COUNSEL_ROUNDS_SPEC, {
      where: counselFormId == null ? undefined : { counselFormId },
      orderBy: { field: 'roundNo' },
    });
  }

  // 상담 폼과 활성 회차를 함께 soft delete — 고아 회차·목록 재노출 방지.
  async removeForm(id: number, actorId: number): Promise<CounselForm> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id }]);
      const before = await this.findForm(id);
      const rounds = await this.findAllRounds(id);
      for (const round of rounds) {
        await this.store.remove(COUNSEL_ROUNDS_SPEC, round.id, actorId);
        await this.audit.log({
          entity: 'counsel_rounds', entityId: round.id, action: 'delete', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(round)), reason: `counsel-form-delete:${id}`,
        });
      }
      await this.store.remove(COUNSEL_FORMS_SPEC, id, actorId);
      await this.audit.log({
        entity: 'counsel_forms', entityId: id, action: 'delete', actorId,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
        reason: `cascade-rounds:${rounds.length}`,
      });
      return before;
    });
  }
}
