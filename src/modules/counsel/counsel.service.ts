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

@Injectable()
export class CounselService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 관심 과목/코스 FK 존재 검증(있을 때만) — 참조 무결성.
  private assertRefs(dto: { interestSubjectId?: number | null; interestCourseId?: number | null; assignedStaffId?: number | null }): void {
    if (dto.interestSubjectId != null && !this.db.findById<Subject>(SUBJECTS, dto.interestSubjectId))
      throw new BadRequestException(`interestSubjectId ${dto.interestSubjectId} 없음`);
    if (dto.interestCourseId != null && !this.db.findById<Course>(COURSES, dto.interestCourseId))
      throw new BadRequestException(`interestCourseId ${dto.interestCourseId} 없음`);
    if (dto.assignedStaffId != null) this.assertActiveStaff(dto.assignedStaffId, 'assignedStaffId');
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
      if (actorId != null) await this.audit.log({ entity: 'counsel_forms', entityId: row.id, action: 'create', actorId });
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
    // [원자성] 회차 기록 + 폼 nextContactAt 동기화가 함께(다음 일정 불일치 방지)
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const existing = await this.store.findActive<CounselRound>(COUNSEL_ROUNDS_SPEC, {
        where: { counselFormId: formId },
        orderBy: { field: 'roundNo' },
      });
      const roundNo = existing.reduce((max, r) => Math.max(max, r.roundNo), -1) + 1;
      const round = await this.store.insert<CounselRound>(COUNSEL_ROUNDS_SPEC, {
        counselFormId: formId, roundNo, counselorId: dto.counselorId,
        completedAt: new Date().toISOString().slice(0, 10), isCompleted: true,
        summary: dto.summary, detail: dto.detail, result: dto.result,
        nextAction: dto.nextAction, nextContactAt: dto.nextContactAt,
      } as Omit<CounselRound, 'id' | 'createdAt' | 'updatedAt'>);
      // 폼의 다음 상담일을 최신 회차 기준으로 동기화(상담 배지 = nextContactAt 미정).
      if (dto.nextContactAt !== undefined) {
        const afterForm = await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, formId, { nextContactAt: dto.nextContactAt });
        if (actorId != null) {
          await this.audit.log({
            entity: 'counsel_forms', entityId: formId, action: 'update', actorId,
            changes: this.audit.diffOf(beforeForm, afterForm as CounselForm),
          });
        }
      }
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 기존 db.transaction 안에 audit만 추가.
      if (actorId != null) await this.audit.log({ entity: 'counsel_rounds', entityId: round.id, action: 'create', actorId });
      return round;
    });
  }

  // 데모 상담 시드 — 프론트 목데이터 이관. rounds.counselFormId→forms.id(무결성).
  // 상담 탭 배지: status≠dropped ∧ nextContactAt 없음(다음 상담일 미정) 기준.
  async onModuleInit(): Promise<void> {
    const forms = await this.store.hydrate<CounselForm>(COUNSEL_FORMS_SPEC);
    const rounds = await this.store.hydrate<CounselRound>(COUNSEL_ROUNDS_SPEC);
    if (forms.length || rounds.length || this.db.findAll<CounselForm>(COUNSEL_FORMS).length) return;
    await this.store.seed<CounselForm>(COUNSEL_FORMS_SPEC, [
      { id: 1, applicantName: '한서진', applicantPhone: '010-7777-1212', assignedStaffId: 1, status: 'pending', source: 'internal_form', submitterType: 'unknown', interestSubjectId: 1, academyExpectation: '내신·수능 영어 전반 보완, 독해 속도 개선', desiredStartTime: 'within_1_month', learningAtmosphere: 'needs_management', studentIntention: 'parent_only', weakness: '독해 속도, 어휘량 부족', nextContactAt: '2026-06-29' },
      { id: 2, applicantName: '오민재', applicantPhone: '010-8888-3434', assignedStaffId: 1, status: 'registered', source: 'naver_form', submitterType: 'unknown', interestCourseId: 11, interestSubjectId: 2, academyExpectation: 'AP Calculus 대비', desiredStartTime: 'immediately', learningAtmosphere: 'self_directed', studentIntention: 'student_wants', weakness: '서술형 풀이 과정' },
      { id: 3, applicantName: '신유나', applicantPhone: '010-9999-5656', status: 'requested', source: 'manual', submitterType: 'unknown', interestSubjectId: 1, desiredStartTime: 'undecided', studentIntention: 'unknown' },
    ]);
    await this.store.seed<CounselRound>(COUNSEL_ROUNDS_SPEC, [
      { id: 1, counselFormId: 1, roundNo: 0, counselorId: 1, completedAt: '2026-06-19', isCompleted: true, summary: '초기 전화 상담', detail: '현 성적·목표 파악. 레벨테스트 권유.', result: 'neutral', nextAction: '레벨테스트 일정 조율', nextContactAt: '2026-06-23' },
      { id: 2, counselFormId: 1, roundNo: 1, counselorId: 1, completedAt: '2026-06-24', isCompleted: true, summary: '레벨테스트 후 대면 상담', detail: '독해 보강 필요. SAT Reading 정규 제안.', result: 'positive', nextAction: '수강 등록 안내', nextContactAt: '2026-06-29' },
      { id: 3, counselFormId: 2, roundNo: 0, counselorId: 1, completedAt: '2026-06-13', isCompleted: true, summary: '온라인 상담', detail: 'AP 일정 및 커리큘럼 안내.', result: 'positive', nextAction: '시간표 확정' },
      { id: 4, counselFormId: 2, roundNo: 1, counselorId: 1, completedAt: '2026-06-16', isCompleted: true, summary: '등록 확정 상담', detail: 'AP Calculus BC 등록 결정.', result: 'registered', nextAction: '결제 및 반 배정' },
    ]);
  }

  async findAllForms(): Promise<CounselForm[]> {
    return this.store.findActive<CounselForm>(COUNSEL_FORMS_SPEC, { orderBy: { field: 'id' } });
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
      await this.store.removeByField(COUNSEL_ROUNDS_SPEC, 'counselFormId', id, actorId);
      await this.store.remove(COUNSEL_FORMS_SPEC, id, actorId);
      await this.audit.log({
        entity: 'counsel_forms', entityId: id, action: 'delete', actorId,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
      });
      return before;
    });
  }
}
