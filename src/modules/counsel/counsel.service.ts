import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { InMemoryDatabase } from '../../database/in-memory.database';
import { DbAnalyticsSnapshotRepository } from '../../database/db-analytics-snapshot.repository';
import { STUDENTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { COUNSEL_FORMS_SPEC, COUNSEL_ROUNDS_SPEC } from '../../database/calendar-asset-specs';
import { AuditService } from '../audit/audit.service';
import { assertDayRange } from '../../common/day-range'; // [TBO-46 G1]
import { type StaffAccount, isStaffRole } from '../users/user.entity';
import { CounselForm, CounselRound, COUNSEL_FORMS } from './counsel.entity';
import { CreateCounselDto } from './dto/create-counsel.dto';
import { UpdateCounselDto } from './dto/update-counsel.dto';
import { CreateCounselRoundDto } from './dto/create-round.dto';
import type { CounselAggregate, CounselFormSnapshot } from '@kms545487/contracts';
import { UpdateCounselRoundDto } from './dto/update-round.dto';
import { StudentsService } from '../students/students.service';
import { Student } from '../students/student.entity';
// [TBO-30D/30E] 집계는 순수 함수(counsel-analytics — API·e2e 공용 단일 진실원)에 위임하고,
//  서비스는 읽기모델 스냅샷 조립만 담당한다(entity 상수만 참조 — 서비스 순환 없음).
import {
  computeCounselCorrelation, computeCounselFunnel,
  type CounselAnalyticsRange, type CounselAnalyticsSnapshot, type CounselCorrelation, type CounselFunnel,
} from './counsel-analytics';
import { normalizeCounselInstant } from './counsel-instant';

const snapshotOfForm = (form: CounselFormSnapshot): CounselFormSnapshot => ({
  studentId: form.studentId,
  assignedStaffId: form.assignedStaffId ?? null,
  status: form.status,
  source: form.source,
  submitterType: form.submitterType,
  referenceNotes: form.referenceNotes ?? null,
  nextContactAt: normalizeCounselInstant(form.nextContactAt) ?? null,
});

@Injectable()
export class CounselService implements OnModuleInit {
  // [TBO-58 P2] 도메인 command 1줄 로그 — allowlist(id·상태·회차번호만, 상담 내용·이름 금지)
  private readonly domainLog = new Logger('counsel');

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly students: StudentsService,
    private readonly analytics: DbAnalyticsSnapshotRepository, // [TBO-54 C2] 분석 조인 4표 DB snapshot
  ) {}

  // 상담의 학생 프로필·보호자·관심 수업은 student aggregate만 권위다.
  // [TBO-56 C2b] 참조 검증 = DB 권위(findActive) — 교차 인스턴스의 계정 정지·학생 삭제 즉시 반영.
  private async assertRefs(dto: {
    assignedStaffId?: number | null;
    studentId?: number;
  }): Promise<void> {
    if (dto.assignedStaffId != null) await this.assertActiveStaff(dto.assignedStaffId, 'assignedStaffId');
    if (dto.studentId != null) {
      const rows = await this.store.findActive<Student>(STUDENTS_SPEC, { where: { id: dto.studentId } as Partial<Student> });
      if (!rows.length) throw new BadRequestException(`studentId ${dto.studentId} 없음`);
    }
  }

  private async assertActiveStaff(id: number, field: 'assignedStaffId' | 'counselorId'): Promise<void> {
    const [account] = await this.store.findActive<StaffAccount>(USERS_SPEC, { where: { id } as Partial<StaffAccount>, limit: 1 });
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
      student: this.students.findAggregate(form.studentId),
    };
  }

  // 내부 상담 접수 — 작성 메타데이터는 body가 아니라 검증된 JWT actor에서만 파생한다.
  async createForm(dto: CreateCounselDto, actorId: number): Promise<CounselForm> {
    await this.assertRefs({ studentId: dto.studentId, assignedStaffId: actorId });
    return this.uow.run(async () => {
      const row = await this.store.insert<CounselForm>(COUNSEL_FORMS_SPEC, {
        ...dto,
        nextContactAt: normalizeCounselInstant(dto.nextContactAt),
        source: 'manual',
        submitterType: 'staff',
        assignedStaffId: actorId,
        status: 'requested',
      } as Omit<CounselForm, 'id' | 'createdAt' | 'updatedAt'>);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      await this.audit.log({
        entity: 'counsel_forms', entityId: row.id, action: 'create', actorId,
        changes: this.audit.maskContactPii(this.audit.diffOf({}, row)),
      });
      this.domainLog.log(`action=createForm form=${row.id} actor=${actorId} status=${row.status} result=created`); // [TBO-58 P2]
      return row;
    });
  }

  // 상담 폼 수정(상태·학생·상담 내용·예정 시각). 존재 검증 + 학생 FK 검증.
  async updateForm(id: number, dto: UpdateCounselDto, actorId: number): Promise<CounselForm> {
    await this.assertRefs(dto);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id }]);
      const before = { ...(await this.findForm(id)) };
      const patch = {
        ...dto,
        ...(dto.nextContactAt !== undefined
          ? { nextContactAt: normalizeCounselInstant(dto.nextContactAt) }
          : {}),
      };
      const after = (await this.store.update<CounselForm>(COUNSEL_FORMS_SPEC, id, patch)) as CounselForm;
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      // referenceNotes 등 상담 민감 텍스트는 audit 원문 금지.
      await this.audit.log({
        entity: 'counsel_forms', entityId: id, action: 'update', actorId,
        changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
      });
      this.domainLog.log(`action=updateForm form=${id} actor=${actorId} status=${after.status} result=updated`); // [TBO-58 P2]
      return after;
    });
  }

  // 회차 추가 — roundNo 자동 증가, 부모 폼 FK 검증 + nextContactAt 동기화(배지 단일 소스).
  async createRound(formId: number, dto: CreateCounselRoundDto, actorId: number): Promise<CounselRound> {
    await this.assertActiveStaff(actorId, 'counselorId');
    if (dto.formSnapshot) await this.assertRefs(dto.formSnapshot);
    const nextContactAt = normalizeCounselInstant(dto.nextContactAt);
    const snapshotNextContactAt = normalizeCounselInstant(dto.formSnapshot?.nextContactAt);
    if (nextContactAt !== undefined && snapshotNextContactAt !== undefined
      && nextContactAt !== snapshotNextContactAt) {
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
      if (dto.formSnapshot?.nextContactAt !== undefined) {
        formSnapshot.nextContactAt = snapshotNextContactAt ?? null;
      }
      if (nextContactAt !== undefined) formSnapshot.nextContactAt = nextContactAt;
      const round = await this.store.insert<CounselRound>(COUNSEL_ROUNDS_SPEC, {
        counselFormId: formId, roundNo, counselorId: actorId,
        completedAt: todayKst(), isCompleted: true, // [TBO-65 M2] KST 기준
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
      this.domainLog.log(`action=createRound form=${formId} round=${round.id} roundNo=${round.roundNo} actor=${actorId} result=created`); // [TBO-58 P2]
      return round;
    });
  }

  async updateRound(formId: number, roundId: number, dto: UpdateCounselRoundDto, actorId: number): Promise<CounselRound> {
    if (dto.formSnapshot) await this.assertRefs(dto.formSnapshot);
    const nextContactAt = normalizeCounselInstant(dto.nextContactAt);
    const snapshotNextContactAt = normalizeCounselInstant(dto.formSnapshot?.nextContactAt);
    if (nextContactAt !== undefined && snapshotNextContactAt !== undefined
      && nextContactAt !== snapshotNextContactAt) {
      throw new BadRequestException('nextContactAt과 formSnapshot.nextContactAt이 일치해야 합니다');
    }
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const before = { ...(await this.roundForForm(formId, roundId)) };
      const formSnapshot = dto.formSnapshot == null
        ? { ...before.formSnapshot }
        : snapshotOfForm({ ...before.formSnapshot, ...dto.formSnapshot });
      if (nextContactAt !== undefined) formSnapshot.nextContactAt = nextContactAt;
      const patch = {
        ...(dto.scheduledAt !== undefined ? { scheduledAt: dto.scheduledAt } : {}),
        ...(dto.completedAt !== undefined ? { completedAt: dto.completedAt } : {}),
        ...(dto.isCompleted !== undefined ? { isCompleted: dto.isCompleted } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.detail !== undefined ? { detail: dto.detail } : {}),
        ...(dto.result !== undefined ? { result: dto.result } : {}),
        ...(dto.nextAction !== undefined ? { nextAction: dto.nextAction } : {}),
        ...(dto.nextContactAt !== undefined ? { nextContactAt } : {}),
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
      this.domainLog.log(`action=updateRound form=${formId} round=${roundId} actor=${actorId} result=updated`); // [TBO-58 P2]
      return after;
    });
  }

  async removeRound(formId: number, roundId: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'counselForm', id: formId }]);
      const beforeForm = { ...(await this.findForm(formId)) };
      const before = { ...(await this.roundForForm(formId, roundId)) };
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
      this.domainLog.log(`action=removeRound form=${formId} round=${roundId} actor=${actorId} result=deleted`); // [TBO-58 P2]
      return { id: roundId, deleted: true };
    });
  }

  // [TBO-66 R5 2026-07-25] 존재·소속 판정 = DB 재조회 — 다른 인스턴스가 만든 회차의 즉시 수정/삭제 허용
  //  (종전 메모리 직독은 교차 인스턴스에서 유령 404). 호출부는 uow lock 안이라 재조회가 권위다.
  private async roundForForm(formId: number, roundId: number): Promise<CounselRound> {
    const [row] = await this.store.findActive<CounselRound>(COUNSEL_ROUNDS_SPEC, { where: { id: roundId } as Partial<CounselRound>, limit: 1 });
    if (!row || row.counselFormId !== formId) throw new NotFoundException(`상담 ${formId}의 회차 ${roundId} 없음`);
    return row;
  }

  // 데모 상담 시드 — 프론트 목데이터 이관. rounds.counselFormId→forms.id(무결성).
  // 상담 탭 배지: status≠dropped ∧ nextContactAt 없음(다음 상담일 미정) 기준.
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<CounselForm>(COUNSEL_FORMS_SPEC);
    await this.store.hydrate<CounselRound>(COUNSEL_ROUNDS_SPEC);
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

  // [TBO-30D/30E] 분석 스냅샷 — 활성 읽기모델을 파생 전용으로 조립(원본 무변형·사본 저장 0).
  //  퍼널은 forms/rounds, 상관관계는 student_interests(희망 권위)×enrollments(등록 권위) 조인.
  private async analyticsSnapshot(): Promise<CounselAnalyticsSnapshot> {
    return {
      forms: (await this.findAllForms()).map((form) => ({
        id: form.id, studentId: form.studentId, status: form.status, createdAt: form.createdAt,
      })),
      rounds: (await this.findAllRounds()).map((round) => ({
        counselFormId: round.counselFormId, roundNo: round.roundNo,
        result: round.result ?? null, completedAt: round.completedAt ?? null,
      })),
      ...(await this.joinTables()),
    };
  }

  // [TBO-54 C2] 조인 4표 = DB 단일 snapshot 저장소(P0-4) — 메모리 projection 금지.
  private async joinTables(): Promise<Pick<CounselAnalyticsSnapshot, 'interests' | 'enrollments' | 'courses' | 'subjects'>> {
    const tables = await this.analytics.counselJoins();
    return {
      interests: tables.interests.map((interest) => ({
        studentId: interest.studentId, courseId: interest.courseId ?? null, customLabel: interest.customLabel ?? null,
      })),
      enrollments: tables.enrollments.map((enrollment) => ({
        studentId: enrollment.studentId, courseId: enrollment.courseId, status: enrollment.status,
      })),
      courses: tables.courses.map((course) => ({ id: course.id, subjectId: course.subjectId })),
      subjects: tables.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
    };
  }

  // [TBO-46 G1] 기간 검증은 공용 assertDayRange 소비(GraphQL 게이트웨이와 같은 규칙 — 사본 제거).
  private assertRange(range: CounselAnalyticsRange): void {
    assertDayRange(range);
  }

  async funnel(range: CounselAnalyticsRange = {}): Promise<CounselFunnel> {
    this.assertRange(range);
    return computeCounselFunnel(await this.analyticsSnapshot(), range);
  }

  async correlation(range: CounselAnalyticsRange = {}): Promise<CounselCorrelation> {
    this.assertRange(range);
    return computeCounselCorrelation(await this.analyticsSnapshot(), range);
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
      this.domainLog.log(`action=removeForm form=${id} actor=${actorId} cascadeRounds=${rounds.length} result=deleted`); // [TBO-58 P2]
      return before;
    });
  }
}
